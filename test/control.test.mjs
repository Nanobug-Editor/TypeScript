/** Consumer control calls cannot bypass snapshot versions or execute arbitrary compiler commands. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, project } from './client.mjs';
import { writeFile } from 'node:fs/promises';
import { join, toNamespacedPath } from 'node:path';

/** Rust supplies canonical Windows paths with the verbatim prefix in native initialization options. */
test('native Windows workspace paths initialize a nested TypeScript project', { skip: process.platform !== 'win32' }, async () => {
  const input = await project({
    'nested/tsconfig.json': '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
    'nested/main.ts': 'export const value = 1;\nvalue;\n',
  });
  const client = new Client();
  try {
    await client.initialize(join(input.root, 'nested'), { workspace: toNamespacedPath(input.root) });
    const uri = input.uri('nested/main.ts');
    client.open(uri, 'export const value = 1;\nvalue;\n');
    const context = await client.request('typescript/project/resolve', { uri });
    assert.equal(context.kind, 'configured');
    assert.equal(context.engineVersion, '5.9.3');
    const hover = await client.request('textDocument/hover', {
      textDocument: { uri }, position: { line: 1, character: 2 },
    });
    assert.match(hover.contents.value, /value:\s*1/);
  } finally { await client.close(); await input.cleanup(); }
});

test('analysis uses native document identities without guessing connection versions', async () => {
  const text = 'const message = "native-source";\nmessage;\n';
  const input = await project({ 'file.ts': text });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('file.ts');
    client.open(uri, text, 'typescript', 9);
    const context = await client.request('typescript/project/resolve', { uri });
    const document = { id: 'native-document-incarnation', path: 'file.ts', revision: 37 };
    const sources = [{ document, uri, version: 9 }];
    const params = { uri, context: context.context, generation: context.generation,
      command: 'quickinfo', arguments: { line: 2, offset: 2 } };
    const result = await client.request('typescript/analysis/request', params, sources);
    assert.match(result.result.displayString, /native-source/);
    assert.deepEqual(result.versions, [document]);
    await assert.rejects(client.request('typescript/analysis/request', {
      ...params, versions: [{ ...document, revision: 36 }],
    }, sources), /revision|snapshot/i);
    await assert.rejects(client.request('typescript/analysis/request', params,
      [{ ...sources[0], version: 8 }]), /revision|snapshot/i);
  } finally { await client.close(); await input.cleanup(); }
});

test('analysis requires a live context and exact synchronized source revisions', async () => {
  const input = await project({ 'file.ts': 'const message = "source";\nmessage;\n' });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('file.ts');
    const document = client.open(uri, 'const message = "source";\nmessage;\n');
    const context = await client.request('typescript/project/resolve', { uri });
    const params = { uri, context: context.context, generation: context.generation, command: 'quickinfo',
      arguments: { line: 2, offset: 2 }, versions: [document] };
    const result = await client.request('typescript/analysis/request', params);
    assert.match(result.result.displayString, /source/);
    assert.equal(result.generation, context.generation);
    client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'const message = 42;\nmessage;\n' }] });
    await assert.rejects(client.request('typescript/analysis/request', params), /revision|snapshot/i);
    await assert.rejects(client.request('typescript/analysis/request', { ...params, command: 'open', versions: [{ ...document, revision: 2 }] }), /unsupported|permitted/i);
    await assert.rejects(client.request('typescript/adapter/attach', { entry: 'C:/untrusted/adapter.js' }), /host-issued/i);
    await client.request('typescript/project/release', { context: context.context });
    await assert.rejects(client.request('typescript/analysis/request', { ...params, versions: [{ ...document, revision: 2 }] }), /retired|unknown/i);
  } finally { await client.close(); await input.cleanup(); }
});

test('extended configuration and lockfile changes retire old project generations', async () => {
  const input = await project({ 'base.json': '{"compilerOptions":{"strict":true}}',
    'tsconfig.json': '{"extends":"./base.json","include":["*.ts"]}', 'file.ts': 'export const value = 1;' });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('file.ts');
    client.open(uri, 'export const value = 1;');
    const before = await client.request('typescript/project/resolve', { uri });
    await writeFile(join(input.root, 'base.json'), '{"compilerOptions":{"strict":false}}');
    await assert.rejects(client.request('typescript/project/describe', { context: before.context }), /generation/);
    const after = await client.request('typescript/project/resolve', { uri });
    assert.ok(after.generation > before.generation);
    await assert.rejects(client.request('typescript/analysis/request', { uri, context: before.context, generation: before.generation,
      command: 'quickinfo', arguments: { line: 1, offset: 15 } }), /generation|retired/);
    await writeFile(join(input.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const lock = await client.request('typescript/project/resolve', { uri });
    assert.ok(lock.generation > after.generation);
  } finally { await client.close(); await input.cleanup(); }
});

test('an explicit incompatible SDK fails instead of falling back to the bundled engine', async () => {
  const input = await project({ 'sdk/package.json': '{"name":"typescript","version":"0.0.1"}', 'sdk/lib/tsserver.js': '' });
  const client = new Client();
  try {
    await assert.rejects(client.initialize(input.root, { typescript: input.root + '/sdk/lib' }), /missing or incompatible/);
  } finally { await client.close(); await input.cleanup(); }
});

test('consumers share a TypeScript project without sharing releasable context references', async () => {
  const input = await project({ 'file.ts': 'export const shared = 1;' });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('file.ts');
    client.open(uri, 'export const shared = 1;');
    const a = await client.request('typescript/project/resolve', { uri, consumer: 'first' });
    for (let index = 0; index < 200; index++) {
      const repeated = await client.request('typescript/project/resolve', { uri, consumer: 'first' });
      assert.equal(repeated.context, a.context);
    }
    const b = await client.request('typescript/project/resolve', { uri, consumer: 'second' });
    assert.equal(a.project, b.project);
    assert.notEqual(a.context, b.context);
    await assert.rejects(client.request('typescript/project/release', { context: a.context, consumer: 'second' }), /consumer|owner/i);
    await client.request('typescript/project/release', { context: a.context, consumer: 'first' });
    const alive = await client.request('typescript/project/describe', { context: b.context, consumer: 'second' });
    assert.equal(alive.project, b.project);
  } finally { await client.close(); await input.cleanup(); }
});
