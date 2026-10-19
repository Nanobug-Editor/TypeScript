/** Public stdio pressure stays bounded, and refused/cancelled requests retain their own IDs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client, project } from './client.mjs';

/** Encode byte counts independently of the worker's parser, including multibyte source text. */
function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

/** One OS write fixes request/cancel ordering without relying on sleeps or compiler speed. */
function batch(client, run) {
  const original = client.send;
  const frames = [];
  client.send = message => frames.push(frame(message));
  try { return run(); }
  finally { client.send = original; client.child.stdin.write(Buffer.concat(frames)); }
}

test('interleaved successes, business errors and cancellation keep the shared connection usable', async () => {
  const source = 'export const 中文Value = 42;\n中文Value;\n';
  const input = await project({ 'main.ts': source });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('main.ts');
    client.open(uri, source);
    const calls = batch(client, () => {
      const pending = [];
      for (let index = 0; index < 24; index++) {
        const rejected = index % 3 === 0;
        const cancelled = index % 3 === 1;
        const call = client.request(rejected ? 'unfamiliar/refused' : 'textDocument/hover', rejected ? {} : {
          textDocument: { uri }, position: { line: 1, character: 2 },
        });
        if (cancelled) client.notify('$/cancelRequest', { id: client.next });
        // Install rejection handlers before the parser receives the combined frame stream.
        pending.push(rejected || cancelled
          ? assert.rejects(call, error => error.code === (cancelled ? -32800 : -32601))
          : call.then(value => assert.match(JSON.stringify(value), /中文Value/)));
      }
      return pending;
    });
    await Promise.all(calls);
    const result = await client.request('typescript/project/resolve', { uri });
    assert.equal(result.engineVersion, '5.9.3');
    assert.equal(client.events.filter(event => event.error).length, 0, 'no reply may lose its request ID');
  } finally { await client.close(); await input.cleanup(); }
});

test('oversized control payload fails explicitly while ordinary source synchronization stays separate', async () => {
  const source = '// ' + '中'.repeat(24000) + '\nexport const value = 1;\nvalue;\n';
  const input = await project({ 'main.ts': source });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('main.ts');
    client.open(uri, source);
    await assert.rejects(client.request('typescript/project/resolve', { uri, padding: 'x'.repeat(49152) }),
      error => error.code === -32602 && /payload/i.test(error.message));
    const context = await client.request('typescript/project/resolve', { uri });
    assert.equal(context.engineVersion, '5.9.3');
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri }, position: { line: 2, character: 2 },
    });
    assert.match(JSON.stringify(hover), /value/);
  } finally { await client.close(); await input.cleanup(); }
});

test('a large readonly analysis result fails within the control quota and preserves later requests', async () => {
  const declarations = Array.from({ length: 1600 }, (_, index) => `const candidate${index} = ${index};`).join('\n');
  const source = `${declarations}\ncandidate\n`;
  const input = await project({ 'main.ts': source });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('main.ts');
    client.open(uri, source);
    const context = await client.request('typescript/project/resolve', { uri });
    await assert.rejects(client.request('typescript/analysis/request', {
      uri, context: context.context, generation: context.generation,
      command: 'completionInfo', arguments: { line: 1601, offset: 10 },
    }), error => error.code === -32000 && /result exceeds quota/i.test(error.message));
    const described = await client.request('typescript/project/describe', { context: context.context });
    assert.equal(described.engineVersion, '5.9.3');
  } finally { await client.close(); await input.cleanup(); }
});

/** Malformed streams are owned disposable workers; every case must terminate without an engine. */
test('frame, header, active ID and queued-request quotas reject a flooding peer', async () => {
  const notification = { jsonrpc: '2.0', method: 'initialized', params: {} };
  const inputs = [
    Buffer.from('Content-Length: 33554433\r\n\r\n'),
    Buffer.from('X'.repeat(8193)),
    Buffer.concat([frame({ ...notification, id: 7 }), frame({ ...notification, id: 7 })]),
    Buffer.concat(Array.from({ length: 257 }, () => frame(notification))),
  ];
  for (const input of inputs) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../native/main.mjs', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // Broken input is the expected result. The deadline kills only this test-owned worker.
    child.stdin.on('error', () => {});
    child.stdout.resume(); child.stderr.resume();
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      const exited = once(child, 'exit');
      child.stdin.end(input);
      const [code, signal] = await exited;
      assert.equal(signal, null);
      assert.equal(code, 1);
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }
});
