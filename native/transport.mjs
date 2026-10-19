/** Bounded JSON-RPC framing and serialized dispatch preserve native snapshot order. */
import { ProtocolError } from './errors.mjs';
const MAX_FRAME = 32 * 1024 * 1024;

/** Attach the worker to owned streams; EOF retires all analysis processes. */
export function serve(input, output, handler, dispose) {
  let buffer = Buffer.alloc(0);
  let queue = Promise.resolve();
  let queued = 0;
  let queuedBytes = 0;
  let ended = false;
  const cancelled = new Set();
  const active = new Set();
  const send = message => {
    if (ended || output.destroyed) return;
    const body = Buffer.from(JSON.stringify(message));
    if (body.length > MAX_FRAME || output.writableLength + body.length > 64 * 1024 * 1024) throw new ProtocolError(-32000, 'Result exceeds stream quota');
    output.write(`Content-Length: ${body.length}\r\n\r\n`);
    output.write(body);
  };
  const stop = async () => { if (!ended) { ended = true; await dispose(); } };
  input.on('end', stop);
  input.on('error', stop);
  output.on('error', stop);
  input.on('data', chunk => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const split = buffer.indexOf('\r\n\r\n');
        if (split < 0) {
          if (buffer.length > 8192) throw new Error('Header exceeds quota');
          return;
        }
        if (split > 8192) throw new Error('Header exceeds quota');
        const length = /^Content-Length: *(\d+)\r?$/im.exec(buffer.subarray(0, split).toString());
        if (!length || Number(length[1]) > MAX_FRAME) throw new Error('Invalid frame length');
        const end = split + 4 + Number(length[1]);
        if (buffer.length < end) return;
        const message = JSON.parse(buffer.subarray(split + 4, end).toString());
        buffer = buffer.subarray(end);
        if (message.method === '$/cancelRequest') {
          if (active.has(message.params?.id)) cancelled.add(message.params.id);
          continue;
        }
        queuedBytes += end;
        if (++queued > 256 || queuedBytes > 64 * 1024 * 1024) throw new Error('Dispatch queue exceeds quota');
        if (message.id !== undefined && active.has(message.id)) throw new Error('Duplicate active request ID');
        if (message.id !== undefined) active.add(message.id);
        queue = queue.then(async () => {
          try {
            if (ended) return;
            if (cancelled.has(message.id)) throw new ProtocolError(-32800, 'Request cancelled');
            const result = await handler(message.method, message.params, notification => send({ jsonrpc: '2.0', ...notification }));
            if (cancelled.has(message.id)) throw new ProtocolError(-32800, 'Request cancelled');
            if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: result ?? null });
          } catch (error) {
            if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id,
              error: { code: error.code ?? -32603, message: error.message, data: error.data } });
            else send({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 1, message: error.message } });
          } finally { queued--; queuedBytes -= end; active.delete(message.id); cancelled.delete(message.id); }
        });
      }
    } catch { void stop().finally(() => { input.destroy(); process.exitCode = 1; }); }
  });
  return { stop };
}
