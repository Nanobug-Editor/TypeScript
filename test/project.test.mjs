/** Project ownership is tested through the same public wire used by plugin consumers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, project } from './client.mjs';
import { join } from 'node:path';

/** Separate service invocations reuse one native context until its exact consumer retires. */
test('workspace-relative resolve and describe retain contexts across independent business calls', async () => {
  const input = await project({ 'app/tsconfig.json': '{"include":["*.vue"]}',
    'app/App.vue': '<script setup lang="ts">const answer = 42;</script>' });
  const client = new Client();
  try {
    await client.initialize(join(input.root, 'app'), { workspace: input.root });
    const uri = input.uri('app/App.vue').replace(/^file:\/\/\/([A-Z]):/, (_, drive) => `file:///${drive.toLowerCase()}:`);
    client.open(uri, '<script setup lang="ts">const answer = 43;</script>', 'vue', 17);
    const first = await client.request('typescript/project/resolve', { path: 'app/App.vue', consumer: 'vue-session' });
    const other = await client.request('typescript/project/resolve', { path: 'app/App.vue', consumer: 'other-session' });
    assert.notEqual(first.context, other.context);
    assert.equal(first.project, other.project);
    for (let invocation = 0; invocation < 4; invocation++) {
      const description = await client.request('typescript/project/describe', {
        path: 'app/App.vue', consumer: 'vue-session', context: first.context,
      });
      assert.deepEqual(description, first);
      const repeated = await client.request('typescript/project/resolve', { path: 'app/App.vue', consumer: 'vue-session' });
      assert.equal(repeated.context, first.context);
    }
    client.notify('nanobug/controlConsumersRetired', { consumers: ['other-session'] });
    assert.deepEqual(await client.request('typescript/project/describe', {
      path: 'app/App.vue', consumer: 'vue-session', context: first.context,
    }), first);
    client.notify('nanobug/controlConsumersRetired', { consumers: ['vue-session'] });
    await assert.rejects(client.request('typescript/project/describe', {
      path: 'app/App.vue', consumer: 'vue-session', context: first.context,
    }), /Unknown or retired project context/);
  } finally { await client.close(); await input.cleanup(); }
});

test('configured and inferred contexts describe the real TypeScript engine without Vue', async () => {
  const input = await project({ 'app/tsconfig.json': '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
    'app/main.ts': 'export const message = "hello";', 'loose/file.js': 'const answer = 42;' });
  const client = new Client();
  try {
    await client.initialize(input.root);
    client.open(input.uri('app/main.ts'), 'export const message = "unsaved";');
    const configured = await client.request('typescript/project/resolve', { uri: input.uri('app/main.ts') });
    assert.equal(configured.kind, 'configured');
    assert.ok(configured.config.endsWith('/app/tsconfig.json'));
    const description = await client.request('typescript/project/describe', { context: configured.context });
    assert.equal(description.engineVersion, '5.9.3');
    client.open(input.uri('loose/file.js'), 'const answer = 42;', 'javascript');
    const inferred = await client.request('typescript/project/resolve', { uri: input.uri('loose/file.js') });
    assert.equal(inferred.kind, 'inferred');
    assert.notEqual(inferred.context, configured.context);
    await client.request('typescript/project/release', { context: configured.context });
    await assert.rejects(client.request('typescript/project/describe', { context: configured.context }), /retired|unknown/i);
  } finally { await client.close(); await input.cleanup(); }
});

test('project-scoped transports retain workspace-relative control paths and independent shutdown', async () => {
  const input = await project({ 'a/tsconfig.json': '{"include":["*.ts"]}', 'a/file.ts': 'export const value = "a";',
    'b/tsconfig.json': '{"include":["*.ts"]}', 'b/file.ts': 'export const value = "b";' });
  const a = new Client();
  const b = new Client();
  try {
    await a.initialize(join(input.root, 'a'), { workspace: input.root });
    await b.initialize(join(input.root, 'b'), { workspace: input.root });
    a.open(input.uri('a/file.ts'), 'export const value = "a";');
    b.open(input.uri('b/file.ts'), 'export const value = "b";');
    const first = await a.request('typescript/project/resolve', { path: 'a/file.ts' });
    const second = await b.request('typescript/project/resolve', { path: 'b/file.ts' });
    assert.notEqual(first.project, second.project);
    assert.match(first.root, /\/a$/);
    await a.close();
    const hover = await b.request('textDocument/hover', { textDocument: { uri: input.uri('b/file.ts') }, position: { line: 0, character: 14 } });
    assert.match(hover.contents.value, /"b"/);
  } finally { await a.close(); await b.close(); await input.cleanup(); }
});
