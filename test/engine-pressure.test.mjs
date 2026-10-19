/** Exercise inner compiler backpressure through the public worker and a test-owned paused SDK. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Client, project } from './client.mjs';
const require = createRequire(import.meta.url);

/** The file handshake proves the compiler paused before the outer client can send any documents. */
async function waitFile(path) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { return await readFile(path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(Date.now() < deadline, 'test compiler did not reach its file barrier');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('a paused compiler backpressures document dispatch and preserves close/reopen order', async () => {
  const input = await project({ 'main.ts': 'export const saved = 1;\n' });
  const sdk = join(input.root, 'test-sdk');
  const paused = join(sdk, 'paused');
  const release = join(sdk, 'release');
  const applied = join(sdk, 'applied.json');
  await mkdir(join(sdk, 'lib'), { recursive: true });
  await writeFile(join(sdk, 'package.json'), JSON.stringify({ name: 'typescript', version: '5.9.3' }));
  // Use the real parser for SDK configuration discovery; only this transport peer is controlled.
  await copyFile(join(dirname(require.resolve('typescript/package.json')), 'lib/typescript.js'), join(sdk, 'lib/typescript.js'));
  await writeFile(join(sdk, 'lib/tsserver.js'), `
    const fs = require('node:fs');
    let buffer = ''; const seen = [];
    const respond = message => {
      const body = JSON.stringify({ type:'response', request_seq:message.seq, command:message.command, success:true, body:{} });
      process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body);
    };
    process.stdin.on('data', chunk => {
      buffer += chunk.toString();
      for (;;) {
        const end = buffer.indexOf('\\n'); if (end < 0) return;
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.command === 'compilerOptionsForInferredProjects') {
          process.stdin.pause(); fs.writeFileSync(${JSON.stringify(paused)}, 'paused'); respond(message); return;
        }
        if (['open','updateOpen','close'].includes(message.command)) {
          seen.push({ command:message.command, text:message.arguments.fileContent ?? message.arguments.changedFiles?.[0]?.textChanges[0]?.newText ?? null });
          if (seen.length === 4) fs.writeFileSync(${JSON.stringify(applied)}, JSON.stringify(seen));
        } else respond(message);
      }
    });
    const gate = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(gate); process.stdin.resume(); } }, 10);
  `);
  const client = new Client();
  try {
    await client.initialize(input.root, { typescript: join(sdk, 'lib') });
    assert.equal(await waitFile(paused), 'paused');
    const uri = input.uri('main.ts');
    const draft = '// ' + 'x'.repeat(8 * 1024 * 1024) + '\n';
    client.open(uri, draft);
    client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'changed\n' }] });
    client.notify('textDocument/didClose', { textDocument: { uri } });
    client.open(uri, 'reopened\n');
    // A request that needs no compiler response must still wait behind the blocked document write.
    const barrier = client.request('unfamiliar/after-documents', {}).then(() => 'unexpected-success', error => error);
    const early = await Promise.race([barrier, new Promise(resolve => setTimeout(() => resolve('blocked'), 300))]);
    assert.equal(early, 'blocked', 'outer dispatch released its byte budget while the compiler pipe was blocked');
    await writeFile(release, 'resume');
    assert.equal((await barrier).code, -32601);
    const seen = JSON.parse(await waitFile(applied));
    assert.deepEqual(seen.map(value => value.command), ['open', 'updateOpen', 'close', 'open']);
    assert.equal(seen[0].text, draft);
    assert.equal(seen[1].text, 'changed\n');
    assert.equal(seen[3].text, 'reopened\n');
  } finally {
    await writeFile(release, 'resume');
    await client.close();
    await input.cleanup();
  }
});
