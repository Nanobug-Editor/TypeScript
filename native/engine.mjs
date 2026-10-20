/** Owned TypeScript server transport; compiler internals stay behind its public protocol. */
import { spawn } from 'node:child_process';
import { ProtocolError } from './errors.mjs';
import { fileURLToPath } from 'node:url';

export class Engine {
  /** The entry is resolved by the plugin's engine policy, never by a document or analysis request. */
  constructor(entry, root, adapter = undefined) {
    this.sequence = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    // Provisional adapter failures are recoverable admission errors. Only a published engine can
    // retire its owning stdio service; explicit disposal never reports another unexpected failure.
    this.expectedClose = false;
    this.failureHandler = undefined;
    this.failure = undefined;
    this.writeQueue = Promise.resolve();
    this.queuedBytes = 0;
    this.commands = new Set();
    this.features = new Map();
    const args = adapter ? [fileURLToPath(new URL('./engine-bootstrap.cjs', import.meta.url)), entry, JSON.stringify(adapter)]
      : [entry, '--disableAutomaticTypingAcquisition', '--useInferredProjectPerProjectRoot'];
    this.child = spawn(process.execPath, args,
      { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] });
    this.adapterReady = adapter ? new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProtocolError(-32003, 'Adapter load timed out')), 10000);
      this.child.once('message', message => {
        clearTimeout(timer);
        if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'adapterReady' || !('commands' in message) || !Array.isArray(message.commands)) return reject(new ProtocolError(-32002, 'Invalid adapter handshake'));
        this.commands = new Set(message.commands);
        this.features = new Map(Object.entries('features' in message ? message.features : {}));
        resolve(undefined);
      });
      this.child.once('exit', () => { clearTimeout(timer); reject(new ProtocolError(-32002, 'Adapter failed to load')); });
    }) : Promise.resolve();
    this.adapterApplied = adapter ? new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ProtocolError(-32003, 'Adapter factory did not initialize')), 10000);
      const receive = message => {
        if (message?.type !== 'adapterApplied' && message?.type !== 'adapterFailed') return;
        clearTimeout(timer); this.child.off('message', receive);
        if (message.type === 'adapterApplied') resolve(undefined);
        else reject(new ProtocolError(-32002, `Adapter factory failed: ${message.message}`));
      };
      this.child.on('message', receive);
      this.child.once('exit', () => { clearTimeout(timer); reject(new ProtocolError(-32002, 'Adapter exited before initialization')); });
    }) : Promise.resolve();
    // IPC can reject while projectInfo is still pending; attach awaits the original promise below.
    this.adapterApplied.catch(() => {});
    // A later project must not silently lose one member after another project's successful create.
    // The whole owned worker retires; callers receive an error instead of partially extended output.
    if (adapter) this.child.on('message', message => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'adapterFailed' && 'message' in message) {
        this.fault(new ProtocolError(-32002, `Adapter factory failed: ${message.message}`));
        void this.close();
      }
    });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.stdout.on('data', data => {
      try { this.receive(data); } catch { this.fault(new ProtocolError(-32001, 'Invalid TypeScript transport frame')); void this.close(); }
    });
    // Drain stderr without forwarding project-controlled messages into protocol framing.
    this.child.stderr.on('data', () => {});
    this.child.on('error', () => this.fault(new ProtocolError(-32001, 'TypeScript engine could not start')));
    this.child.on('exit', () => this.fault(new ProtocolError(-32001, 'TypeScript engine exited')));
    this.child.stdin.on('error', () => this.fault(new ProtocolError(-32001, 'TypeScript input closed')));
  }
  /** Arm retirement only after initialization/adapter admission has completed successfully. */
  admit(onUnexpectedFailure) {
    if (this.closed) throw this.failure ?? new ProtocolError(-32001, 'TypeScript engine retired');
    this.failureHandler = onUnexpectedFailure;
  }
  /** Pipe/framing/child failure invalidates the complete published worker, not a business request. */
  fault(error) {
    const handler = !this.expectedClose && !this.closed ? this.failureHandler : undefined;
    this.fail(error);
    if (handler) handler();
  }
  /** Reliable replies are correlated; unsolicited TS telemetry never enters editor results. */
  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const split = this.buffer.indexOf('\r\n\r\n');
      if (split < 0) { if (this.buffer.length > 8192) throw new Error('Header too large'); return; }
      const match = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, split).toString());
      if (!match || +match[1] > 32 * 1024 * 1024) throw new Error('Frame too large');
      const end = split + 4 + Number(match[1]);
      if (this.buffer.length < end) return;
      const message = JSON.parse(this.buffer.subarray(split + 4, end).toString());
      this.buffer = this.buffer.subarray(end);
      const task = this.pending.get(message.request_seq);
      if (message.type === 'response' && task) {
        this.pending.delete(message.request_seq); clearTimeout(task.timer);
        if (message.success) task.resolve(message.body);
        else task.reject(new ProtocolError(-32002, `TypeScript rejected ${message.command}`, { reason: message.message }));
      }
    }
  }
  /** A deadline invalidates only the request; late replies cannot satisfy another correlation ID. */
  request(command, args) {
    if (this.closed) return Promise.reject(new ProtocolError(-32001, 'TypeScript engine retired'));
    if (this.pending.size >= 32) return Promise.reject(new ProtocolError(-32000, 'TypeScript request quota exceeded'));
    return new Promise((resolve, reject) => {
      const seq = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new ProtocolError(-32003, `TypeScript ${command} timed out`)); }, 30000);
      this.pending.set(seq, { resolve, reject, timer });
      this.send(seq, command, args).catch(error => {
        const task = this.pending.get(seq);
        if (task) { this.pending.delete(seq); clearTimeout(task.timer); task.reject(error); }
      });
    });
  }
  /** One-way updates still use increasing sequence IDs and the same ordered stdin pipe. */
  async notify(command, args) {
    try { await this.send(++this.sequence, command, args); }
    catch (error) {
      // LSP notifications have no response that could repair a lost overlay. Retire this worker
      // before another feature can mistake its last accepted snapshot for the current source.
      this.fault(error);
      await this.close();
      throw error;
    }
  }
  /** Keep the outer dispatch budget until the compiler pipe accepts each ordered frame. */
  send(seq, command, args) {
    if (this.closed) return Promise.reject(new ProtocolError(-32001, 'TypeScript engine retired'));
    const frame = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }) + '\n');
    if (frame.length > 32 * 1024 * 1024 || this.queuedBytes + frame.length > 64 * 1024 * 1024) {
      return Promise.reject(new ProtocolError(-32000, 'TypeScript input exceeds stream quota'));
    }
    this.queuedBytes += frame.length;
    const sent = this.writeQueue.then(() => new Promise((resolve, reject) => {
      if (this.closed) return reject(new ProtocolError(-32001, 'TypeScript engine retired'));
      // A paused or broken compiler cannot pin source buffers indefinitely. Closing the owned
      // process also cancels its pending analyses; a late pipe callback cannot revive them.
      const timer = setTimeout(() => {
        const error = new ProtocolError(-32003, 'TypeScript input timed out');
        reject(error); this.fault(error); void this.close();
      }, 30000);
      this.child.stdin.write(frame, error => {
        clearTimeout(timer);
        if (error) reject(new ProtocolError(-32001, 'TypeScript input closed'));
        else resolve(undefined);
      });
    }));
    this.writeQueue = sent.catch(() => {});
    return sent.finally(() => { this.queuedBytes -= frame.length; });
  }
  fail(error) {
    this.failure ??= error;
    this.closed = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  /** Shutdown waits for physical process closure before the parent may release its SDK files. */
  async close() {
    this.expectedClose = true;
    this.fail(new ProtocolError(-32001, 'TypeScript engine retired'));
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
    await this.exited;
  }
}
