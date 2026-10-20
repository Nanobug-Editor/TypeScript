/** Exercise this fixture's actual immutable factory through the managed TypeScript stdio service.
 * The test client supplies trusted-host seals; Package admission and WASM discovery remain separate.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, mkdir, symlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Client, project } from '../../client.mjs';

/** Exact factory and Vue fixtures are caller-selected inputs, never project plugin resolution. */
const fixture = fileURLToPath(new URL('.', import.meta.url));
const vue = process.env.NANOBUG_VUE_FIXTURES;
/** The same inert declarations become contributions.json when preparing each real Package. */
const scenarios = JSON.parse(await readFile(new URL('scenarios.json', import.meta.url), 'utf8'));

/** Attach the shipped factory to one disposable Vue 3 project, then close every owned process.
 * @param {string} source - Original SFC text, also used as the unsaved native snapshot.
 * @param {object[]} declarations - Actual composition declarations, including factory configuration.
 * @param {(context: object) => Promise<void>} exercise - Public-protocol assertions to perform.
 * @param {object} options - Locked backend, Vue dependency fixture and framework target for this case.
 */
async function analyze(source, declarations, exercise, options = {}) {
  assert.ok(vue, 'Set NANOBUG_VUE_FIXTURES to the independent Vue checkout');
  const { backend = 'modern', vueProject = 'vue3', target = 3.5 } = options;
  const configuration = JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: true,
    moduleResolution: 'Node', module: 'ESNext', target: 'ES2020' }, include: ['*.vue'],
    vueCompilerOptions: { target, strictTemplates: true, checkUnknownComponents: false } });
  const input = await project({ 'App.vue': source, 'tsconfig.json': configuration });
  const client = new Client();
  try {
    await mkdir(join(input.root, 'node_modules'));
    await symlink(await realpath(join(vue, `tests/projects/${vueProject}/node_modules/vue`)),
      join(input.root, 'node_modules/vue'), 'junction');
    await client.initialize(input.root);
    const uri = input.uri('App.vue');
    client.open(uri, source, 'vue');
    const context = await client.request('typescript/project/resolve', { uri });
    const primary = JSON.parse(await readFile(join(vue, 'module-exports.json'), 'utf8'))[backend];
    const sealedPrimary = { ...primary, export_id: backend,
      entry: join(vue, primary.root, primary.entry), package_root: vue,
      module_root: join(vue, primary.root),
      package_digest: createHash('sha256').update(JSON.stringify(primary.files)).digest('hex') };
    const hash = createHash('sha256').update(await readFile(join(fixture, 'modules/check/index.cjs'))).digest('hex');
    const factory = {
      entry: join(fixture, 'modules/check/index.cjs'), package_root: fixture,
      module_root: join(fixture, 'modules/check'), files: { 'index.cjs': hash },
      package_digest: hash, sha256: hash, abi: 'vue.language-plugin/1', engine: { typescript: '=5.9.3' } };
    const attach = (members = declarations) => client.request('typescript/adapter/attach', { uri,
      context: context.context, generation: context.generation, export: backend,
      imports: [sealedPrimary, ...members.map(member => ({ ...factory, export_id: member.export }))],
      contributions: members });
    await exercise({ client, uri, attach });
    assert.equal(await readFile(join(input.root, 'App.vue'), 'utf8'), source);
    assert.equal(await readFile(join(input.root, 'tsconfig.json'), 'utf8'), configuration);
  } finally {
    await client.close();
    await input.cleanup();
  }
}

/** Make one legal role declaration; competition and ordering stay with the public composition ABI.
 * @param {string} role - One supported template/style/project/types role.
 * @param {object} config - Immutable fixture-specific settings passed to the factory.
 * @returns {object} One source-independent module selector without a guest path.
 */
function member(role, config = {}) {
  const declaration = structuredClone(scenarios[role][0]);
  Object.assign(declaration.config, config);
  return declaration;
}

test('the fixture types role honors its configured requirement instead of a hard-coded diagnostic', async () => {
  const source = '<script setup lang="ts">\n// unsaved 中文😀\nconst eco = 42;\n</script>\n<template>{{eco}}</template>\n';
  await analyze(source, [member('types', { expectedType: 'number' })], async ({ client, uri, attach }) => {
    await attach();
    const report = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    assert.equal(report.items.filter(item => item.code === 2345).length, 0, JSON.stringify(report));
    const hover = await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 2, character: 7 } });
    assert.match(hover.contents.value, /eco: 42/);
  });
});

test('the same fixture type constraint maps a Vue 2.6 Options script without script setup', async () => {
  const source = '<script lang="ts">\nimport Vue from "vue";\nexport default Vue.extend({data(){return {eco:42}}});\n</script>\n<template>{{eco}}</template>';
  await analyze(source, [member('types')], async ({ client, uri, attach }) => {
    await attach();
    const report = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    const error = report.items.find(item => item.code === 2345);
    assert.ok(error, JSON.stringify(report));
    assert.deepEqual(error.range, { start: { line: 2, character: 46 }, end: { line: 2, character: 48 } });
  }, { backend: 'legacy', vueProject: 'vue26', target: 2 });
});

test('the fixture template role compiles unknown syntax and preserves definition and rename locations', async () => {
  const source = '<script setup lang="ts">\nconst count = 42;\n</script>\n<template lang="quill"><p>{{count.toUpperCase()}}</p></template>';
  await analyze(source, [member('template')], async ({ client, uri, attach }) => {
    await attach();
    const report = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    const error = report.items.find(item => item.code === 2339 && item.message.includes('toUpperCase'));
    assert.ok(error, JSON.stringify(report));
    assert.equal(error.range.start.line, 3);
    const position = { line: 3, character: 28 };
    const definitions = await client.request('textDocument/definition', { textDocument: { uri }, position });
    assert.ok(definitions.some(item => item.uri === uri && item.range.start.line === 1), JSON.stringify(definitions));
    const edit = await client.request('textDocument/rename', { textDocument: { uri }, position, newName: 'renamed' });
    const changes = edit.changes?.[uri] ?? edit.documentChanges?.flatMap(change => change.edits) ?? [];
    assert.deepEqual(changes.map(change => [change.range.start.line, change.range.start.character]).sort(),
      [[1, 6], [3, 28]]);
  });
});

test('the fixture style role exposes real bindings with source-mapped navigation and rename', async () => {
  const source = '<script setup lang="ts">\nconst shade = 42;\n</script>\n<template><p>{{shade}}</p></template>\n<style lang="ink">shade.toUpperCase()</style>';
  await analyze(source, [member('style')], async ({ client, uri, attach }) => {
    await attach();
    const report = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    const error = report.items.find(item => item.code === 2339 && item.message.includes('toUpperCase'));
    assert.ok(error, JSON.stringify(report));
    assert.equal(error.range.start.line, 4);
    const position = { line: 4, character: 18 };
    const definitions = await client.request('textDocument/definition', { textDocument: { uri }, position });
    assert.ok(definitions.some(item => item.uri === uri && item.range.start.line === 1), JSON.stringify(definitions));
    const edit = await client.request('textDocument/rename', { textDocument: { uri }, position, newName: 'renamed' });
    const changes = edit.changes?.[uri] ?? edit.documentChanges?.flatMap(change => change.edits) ?? [];
    assert.deepEqual(changes.map(change => [change.range.start.line, change.range.start.character]).sort(),
      [[1, 6], [3, 15], [4, 18]]);
  });
});

test('the fixture project role enables a real Vue check without writing project configuration', async () => {
  const source = '<script setup lang="ts">\nconst intact = 1;\n</script>\n<template><AbsentThing /></template>';
  await analyze(source, [member('project', { enabled: true })], async ({ client, uri, attach }) => {
    await attach();
    const report = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    assert.ok(report.items.some(item => item.message.includes('AbsentThing')), JSON.stringify(report));
    const hover = await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 1, character: 8 } });
    assert.match(hover.contents.value, /intact: 1/);
  });
});

test('the fixture invalid-mapping mode rejects the complete candidate and permits a valid retry', async () => {
  const source = '<script setup lang="ts">\nconst eco = 42;\n</script>\n<template>{{eco}}</template>';
  await analyze(source, scenarios['invalid-mapping'], async ({ client, uri, attach }) => {
    await assert.rejects(attach(), /mapping/i);
    await attach([member('types')]);
    const report = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    const error = report.items.find(item => item.code === 2345);
    assert.ok(error, JSON.stringify(report));
    assert.deepEqual(error.range, { start: { line: 1, character: 12 }, end: { line: 1, character: 14 } });
  });
});

test('all four independent fixture roles contribute observable semantics in one composition', async () => {
  const source = '<script setup lang="ts">\nconst eco = 42;\nconst count = 42;\nconst shade = 42;\n</script>\n<template lang="quill"><p>{{count.toUpperCase()}}</p><AbsentThing /></template>\n<style lang="ink">shade.toUpperCase()</style>';
  const members = scenarios.combined;
  await analyze(source, members, async ({ client, uri, attach }) => {
    await attach();
    const report = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    assert.ok(report.items.some(item => item.code === 2345 && item.range.start.line === 1), JSON.stringify(report));
    assert.deepEqual(report.items.filter(item => item.code === 2339 && item.message.includes('toUpperCase'))
      .map(item => item.range.start.line).sort(), [5, 6]);
    assert.ok(report.items.some(item => item.message.includes('AbsentThing')), JSON.stringify(report));
    assert.equal(report.items.some(item => item.code === 'nanobug.missingContribution'), false);
  });
});

test('a missing style role keeps the other three actual contributions and reports only Ink as missing', async () => {
  const source = '<script setup lang="ts">\nconst eco = 42;\nconst count = 42;\nconst shade = 42;\n</script>\n<template lang="quill"><p>{{count.toUpperCase()}}</p><AbsentThing /></template>\n<style lang="ink">shade.toUpperCase()</style>';
  await analyze(source, scenarios['without-style'], async ({ client, uri, attach }) => {
    await attach();
    const report = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    assert.ok(report.items.some(item => item.code === 2345 && item.range.start.line === 1), JSON.stringify(report));
    assert.deepEqual(report.items.filter(item => item.code === 2339 && item.message.includes('toUpperCase'))
      .map(item => item.range.start.line), [5]);
    assert.ok(report.items.some(item => item.message.includes('AbsentThing')), JSON.stringify(report));
    const missing = report.items.filter(item => item.code === 'nanobug.missingContribution');
    assert.equal(missing.length, 1, JSON.stringify(report));
    assert.match(missing[0].message, /style language "ink"/);
    assert.deepEqual(missing[0].range, { start: { line: 6, character: 0 }, end: { line: 6, character: 18 } });
  });
});

for (const [scenario, error] of [
  ['exclusive-conflict', /exclusive.*conflict/i],
  ['ordering-cycle', /cycle/i],
  ['configuration-conflict', /configuration conflict/i],
  ['invalid-project-config', /invalid fixture project setting/i],
]) {
  test(`fixture ${scenario} is rejected without poisoning the next valid composition`, async () => {
    const source = '<script setup lang="ts">\nconst eco = 42;\n</script>\n<template>{{eco}}</template>';
    await analyze(source, scenarios[scenario], async ({ client, uri, attach }) => {
      await assert.rejects(attach(), error);
      await attach([member('types')]);
      const report = await client.request('textDocument/diagnostic', { textDocument: { uri } });
      assert.ok(report.items.some(item => item.code === 2345), JSON.stringify(report));
    });
  });
}
