/** Compiler references and an in-workspace package link must preserve actual dirty source identity. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, project } from './client.mjs';

/** An explicit reference can point into a conventionally omitted build directory; only the
 * compiler's real graph, paths configuration and canonical package target prove membership.
 */
test('project references and legal package junctions resolve aliases to the same unsaved library', async () => {
  const library = "export const word = 'disk' as const;\r\n";
  const source = "import { word as aliasWord } from '@alias/index';\r\n"
    + "import { word as packageWord } from '@demo/lib';\r\n"
    + 'export const both: [string, string] = [aliasWord, packageWord];\r\n';
  const input = await project({
    'tsconfig.json': JSON.stringify({ files: [], references: [{ path: './target/library' }, { path: './packages/app' }] }),
    'target/library/tsconfig.json': JSON.stringify({ compilerOptions: {
      composite: true, declaration: true, strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'Node',
    }, include: ['src/*.ts'] }),
    'target/library/package.json': JSON.stringify({ name: '@demo/lib', version: '1.0.0', types: './src/index.ts' }),
    'target/library/src/index.ts': library,
    'packages/app/tsconfig.json': JSON.stringify({ compilerOptions: {
      composite: true, strict: true, target: 'ES2020', module: 'ESNext', moduleResolution: 'Node', baseUrl: '.',
      paths: { '@alias/*': ['../../target/library/src/*'] },
    }, files: ['src/main.ts'], references: [{ path: '../../target/library' }] }),
    'packages/app/src/main.ts': source,
    'unrelated/tsconfig.json': '{"files":["entry.ts"]}',
    'unrelated/entry.ts': 'export const unrelated = true;\r\n',
  });
  const client = new Client();
  try {
    await mkdir(join(input.root, 'node_modules/@demo'), { recursive: true });
    // Both endpoints belong to this exact disposable workspace; no external directory gains access.
    await symlink(await realpath(join(input.root, 'target/library')), join(input.root, 'node_modules/@demo/lib'), 'junction');
    await client.initialize(input.root);
    const uri = input.uri('packages/app/src/main.ts');
    const libraryUri = input.uri('target/library/src/index.ts');
    client.open(uri, source);
    client.open(libraryUri, 'export const word = 42 as const;\r\n');
    client.open(input.uri('unrelated/entry.ts'), 'export const unrelated = true;\r\n');
    const configured = await client.request('typescript/project/candidates', { uri: libraryUri });
    assert.ok(configured.some(candidate => candidate.config === 'target/library/tsconfig.json'),
      'explicit project references must survive conventional target-directory discovery omission');
    const line = source.split('\n')[2];
    for (const name of ['aliasWord', 'packageWord']) {
      const position = { line: 2, character: line.indexOf(name) + 2 };
      const hover = await client.request('textDocument/hover', { textDocument: { uri }, position });
      assert.match(hover.contents.value, /42/, `${name} must read the original library overlay`);
      const definitions = await client.request('textDocument/definition', { textDocument: { uri }, position });
      assert.equal(definitions.length, 1);
      assert.equal(definitions[0].uri, libraryUri, 'a package link cannot replace the original open-source URI');
      const span = definitions[0].range;
      assert.equal(span.start.line, 0);
      assert.equal(span.end.line, 0);
      assert.equal(library.slice(span.start.character, span.end.character), 'word');
    }
    const diagnostics = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    const mismatches = diagnostics.items.filter(item => item.code === 2322);
    assert.equal(mismatches.length, 2, JSON.stringify(diagnostics));
    assert.deepEqual(mismatches.map(item => {
      assert.equal(item.range.start.line, 2);
      assert.equal(item.range.end.line, 2);
      return line.slice(item.range.start.character, item.range.end.character);
    }).sort(), ['aliasWord', 'packageWord']);
    const target = { id: 'target', uri, revision: 1 };
    const members = await client.request('typescript/project/documents', {
      arguments: { target, candidates: [target, { id: 'library', uri: libraryUri, revision: 1 },
        { id: 'unrelated', uri: input.uri('unrelated/entry.ts'), revision: 1 }] }, _nanobug: { native: true },
    });
    assert.deepEqual(members.documents.sort(), ['library', 'target']);
    assert.equal(await readFile(join(input.root, 'target/library/src/index.ts'), 'utf8'), library);
    assert.equal(await readFile(join(input.root, 'packages/app/src/main.ts'), 'utf8'), source);
  } finally { await client.close(); await input.cleanup(); }
});
