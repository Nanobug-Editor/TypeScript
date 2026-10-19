/** Optional cross-repository acceptance consumes a real immutable Vue export, never a fake compiler. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, cp, symlink, realpath } from 'node:fs/promises';
import { join, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Client, project } from './client.mjs';

const vue = process.env.NANOBUG_VUE_FIXTURES;
test('Windows host-canonical immutable module paths attach and retain actual analysis', { skip: process.platform !== 'win32' }, async () => {
  const code = '/** Transparent fixture adapter; all semantic work remains in the real TS engine. */\nmodule.exports=()=>({create:info=>info.languageService});';
  const input = await project({ 'tsconfig.json': '{}', 'main.ts': 'export const value = 42;', 'module/index.cjs': code });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('main.ts'); client.open(uri, 'export const value = 42;');
    const context = await client.request('typescript/project/resolve', { uri });
    const hash = createHash('sha256').update(code).digest('hex');
    const lease = { export_id: 'canonical', entry: toNamespacedPath(join(input.root, 'module/index.cjs')),
      package_root: toNamespacedPath(input.root), module_root: toNamespacedPath(join(input.root, 'module')),
      files: { 'index.cjs': hash }, package_digest: hash, sha256: hash, abi: 'typescript.adapter/1', engine: { typescript: '=5.9.3' } };
    await client.request('typescript/adapter/attach', { uri, context: context.context, generation: context.generation, export: 'canonical', imports: [lease] });
    const hover = await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 15 } });
    assert.match(hover.contents.value, /value.*42/);
    await writeFile(join(input.root, 'module/unsealed.cjs'), 'module.exports=1;');
    await assert.rejects(client.request('typescript/adapter/attach', { uri, context: context.context, generation: context.generation, export: 'canonical', imports: [lease] }), /Unlisted module neighbor/);
  } finally { await client.close(); await input.cleanup(); }
});

test('host-sealed Vue adapter shares real unsaved TS snapshots and rejects unsealed entries', { skip: !vue }, async () => {
  const exports = JSON.parse(await readFile(join(vue, 'module-exports.json'), 'utf8'));
  const descriptor = exports.modern;
  const root = join(vue, 'tests/projects/vue3');
  // Match the native Rust editor's drive spelling, not Node's default uppercase URI generation.
  const uri = pathToFileURL(join(root, 'App.vue')).href.replace(/^file:\/\/\/([A-Z]):/, (_, drive) => `file:///${drive.toLowerCase()}:`);
  const source = await readFile(join(root, 'App.vue'), 'utf8');
  const client = new Client();
  try {
    await client.initialize(root);
    client.open(uri, source, 'vue');
    const context = await client.request('typescript/project/resolve', { path: 'App.vue' });
    const entry = join(vue, descriptor.root, descriptor.entry);
    const lease = { export_id: 'modern', entry, package_root: vue, module_root: join(vue, descriptor.root), files: descriptor.files,
      package_digest: createHash('sha256').update(JSON.stringify(descriptor.files)).digest('hex'),
      sha256: descriptor.sha256, abi: descriptor.abi, engine: descriptor.engine };
    const request = { uri, context: context.context, generation: context.generation, export: 'modern', imports: [lease] };
    await assert.rejects(client.request('typescript/adapter/attach', { ...request, imports: [{ ...lease, sha256: '0'.repeat(64) }] }), /digest/i);
    await client.request('typescript/adapter/attach', request);
    const props = await client.request('typescript/analysis/request', { uri, context: context.context, generation: context.generation,
      command: '_vue:getComponentProps', arguments: [9] });
    assert.ok(props.result.some(prop => prop.name === 'title'));
    const position = positionOf(source, 'message', true);
    const hover = await client.request('textDocument/hover', { textDocument: { uri }, position });
    assert.match(hover.contents.value, /message|string|hello/);
    const definitions = await client.request('textDocument/definition', { textDocument: { uri }, position });
    assert.ok(definitions.some(value => value.uri === uri && value.range.start.line === 2));
    const references = await client.request('textDocument/references', { textDocument: { uri }, position, context: { includeDeclaration: true } });
    assert.ok(references.length >= 2);
    const rename = await client.request('textDocument/rename', { textDocument: { uri }, position, newName: 'greeting' });
    assert.ok(rename.documentChanges.flatMap(value => value.edits).length >= 2);
    const completion = await client.request('textDocument/completion', { textDocument: { uri }, position });
    assert.ok(completion.items.some(value => value.label === 'message'));
    client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: source.replace("'hello'", '42') }] });
    const diagnostics = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    assert.ok(diagnostics.items.some(item => item.code === 2322));
    const formatSource = source.replace('<template><Child :title="message" /></template>', '<template> <Child :title = "message" /> </template>') + '<style>.example{color:red}</style>\r\n';
    client.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: formatSource }] });
    const formatting = await client.request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } });
    assert.ok(formatting.some(edit => /color: red;/.test(edit.newText) && /:title="message"/.test(edit.newText) && /const message = "hello";/.test(edit.newText)), JSON.stringify(formatting));
    assert.equal(await readFile(join(root, 'App.vue'), 'utf8'), source);
  } finally { await client.close(); }
});

/** JavaScript offsets are UTF-16 code units, matching this plugin's negotiated LSP encoding. */
function positionOf(source, word, last = false) {
  const index = (last ? source.lastIndexOf(word) : source.indexOf(word)) + 1;
  const lines = source.slice(0, index).split('\n');
  return { line: lines.length - 1, character: lines.at(-1).length };
}

test('Vue analysis sees an auxiliary TypeScript dependency changing only in editor memory', { skip: !vue }, async () => {
  const descriptor = JSON.parse(await readFile(join(vue, 'module-exports.json'), 'utf8')).modern;
  const original = "export const message = 'hello';\n";
  const input = await project({
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2020', module: 'ESNext', moduleResolution: 'Bundler', strict: true, skipLibCheck: true }, include: ['*.vue', '*.ts'], vueCompilerOptions: { target: 3.5, strictTemplates: true } }),
    'model.ts': original,
    'App.vue': '<script setup lang="ts">\nimport Child from "./Child.vue";\nimport { message } from "./model";\n</script>\n<template><Child :title="message" /></template>\n',
    'Child.vue': await readFile(join(vue, 'tests/projects/vue3/Child.vue'), 'utf8'),
  });
  await symlink(await realpath(join(vue, 'tests/projects/vue3/node_modules')), join(input.root, 'node_modules'), 'junction');
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('App.vue');
    const auxiliary = input.uri('model.ts');
    client.open(uri, await readFile(join(input.root, 'App.vue'), 'utf8'), 'vue');
    client.open(auxiliary, original);
    const context = await client.request('typescript/project/resolve', { uri });
    await client.request('typescript/adapter/attach', { uri, context: context.context, generation: context.generation, export: 'modern', imports: [{
      export_id: 'modern', entry: join(vue, descriptor.root, descriptor.entry), package_root: vue, module_root: join(vue, descriptor.root), files: descriptor.files,
      package_digest: createHash('sha256').update(JSON.stringify(descriptor.files)).digest('hex'), sha256: descriptor.sha256, abi: descriptor.abi, engine: descriptor.engine,
    }] });
    assert.equal((await client.request('textDocument/diagnostic', { textDocument: { uri } })).items.length, 0);
    client.notify('textDocument/didChange', { textDocument: { uri: auxiliary, version: 2 }, contentChanges: [{ text: 'export const message = 42;\n' }] });
    const diagnostics = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    assert.ok(diagnostics.items.some(item => item.code === 2322));
    assert.equal(await readFile(join(input.root, 'model.ts'), 'utf8'), original);
  } finally { await client.close(); await input.cleanup(); }
});

test('one workspace keeps Vue 2.6, 2.7 and 3 project contexts and adapter workers separate', { skip: !vue }, async () => {
  const exports = JSON.parse(await readFile(join(vue, 'module-exports.json'), 'utf8'));
  const workspace = join(vue, 'tests/projects');
  const client = new Client();
  const contexts = [];
  try {
    await client.initialize(workspace);
    for (const [directory, adapter, propArgument] of [['vue26', 'legacy', 'Child'], ['vue27', 'legacy', 'Child'], ['vue3', 'modern', 9]]) {
      const uri = pathToFileURL(join(workspace, directory, 'App.vue')).href;
      const source = await readFile(join(workspace, directory, 'App.vue'), 'utf8');
      client.open(uri, source, 'vue');
      const context = await client.request('typescript/project/resolve', { uri });
      const descriptor = exports[adapter];
      const lease = { export_id: adapter, entry: join(vue, descriptor.root, descriptor.entry), package_root: vue, module_root: join(vue, descriptor.root), files: descriptor.files,
        package_digest: createHash('sha256').update(JSON.stringify(descriptor.files)).digest('hex'), sha256: descriptor.sha256,
        abi: descriptor.abi, engine: descriptor.engine };
      await client.request('typescript/adapter/attach', { uri, context: context.context, generation: context.generation, export: adapter, imports: [lease] });
      const props = await client.request('typescript/analysis/request', { uri, context: context.context, generation: context.generation,
        command: '_vue:getComponentProps', arguments: [propArgument] });
      assert.ok(props.result.some(prop => prop.name === 'title'), directory);
      assert.equal(context.kind, 'configured');
      contexts.push(context);
      client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: source.replace("'hello'", '42') }] });
      const diagnostics = await client.request('textDocument/diagnostic', { textDocument: { uri } });
      assert.ok(diagnostics.items.some(item => item.code === 2322), directory);
    }
    assert.equal(new Set(contexts.map(context => context.project)).size, 3);
  } finally { await client.close(); }
});

test('adding an unsealed module neighbor rejects even an already attached real adapter', { skip: !vue }, async () => {
  const descriptor = JSON.parse(await readFile(join(vue, 'module-exports.json'), 'utf8')).modern;
  const input = await project({ 'tsconfig.json': '{}', 'main.ts': 'export const value = 1;' });
  const moduleRoot = join(input.root, 'sealed');
  await cp(join(vue, descriptor.root), moduleRoot, { recursive: true });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('main.ts');
    client.open(uri, 'export const value = 1;');
    const context = await client.request('typescript/project/resolve', { uri });
    const lease = { export_id: 'modern', entry: join(moduleRoot, descriptor.entry), package_root: input.root,
      module_root: moduleRoot, files: descriptor.files, package_digest: createHash('sha256').update(JSON.stringify(descriptor.files)).digest('hex'),
      sha256: descriptor.sha256, abi: descriptor.abi, engine: descriptor.engine };
    const request = { uri, context: context.context, generation: context.generation, export: 'modern', imports: [lease] };
    await client.request('typescript/adapter/attach', request);
    await writeFile(join(moduleRoot, 'unexpected.cjs'), 'module.exports = 42;');
    await assert.rejects(client.request('typescript/adapter/attach', request), /Unlisted module neighbor/);
  } finally { await client.close(); await input.cleanup(); }
});

test('a real worker refuses ordinary require outside its sealed adapter closure', async () => {
  // This hostile module is input to a real TS process, not a mock of its analysis internals.
  const input = await project({ 'tsconfig.json': '{}', 'main.ts': 'export const value = 1;',
    'sealed/index.cjs': "require('../outside.cjs'); module.exports = () => ({ create(info) { return info.languageService; } });",
    'outside.cjs': "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'escaped.txt'), 'executed');",
  });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('main.ts');
    client.open(uri, 'export const value = 1;');
    const context = await client.request('typescript/project/resolve', { uri });
    const sha256 = createHash('sha256').update(await readFile(join(input.root, 'sealed/index.cjs'))).digest('hex');
    await assert.rejects(client.request('typescript/adapter/attach', { uri, context: context.context, generation: context.generation,
      export: 'hostile', imports: [{ export_id: 'hostile', entry: join(input.root, 'sealed/index.cjs'), package_root: input.root,
        module_root: join(input.root, 'sealed'), files: { 'index.cjs': sha256 }, package_digest: sha256, sha256,
        abi: 'typescript.adapter/1', engine: { typescript: '=5.9.3' } }] }), /Adapter failed to load/);
    await assert.rejects(readFile(join(input.root, 'escaped.txt')), { code: 'ENOENT' });
    const hover = await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 14 } });
    assert.match(hover.contents.value, /value/);
  } finally { await client.close(); await input.cleanup(); }
});
