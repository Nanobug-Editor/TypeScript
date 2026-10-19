/** Independent immutable contributions change real TypeScript inference through public LSP only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, project } from './client.mjs';

/** The harness is the trusted host: descriptors seal exact fixture bytes and carry no project plugin path. */
function descriptor(root, directory, code, abi, name) {
  const hash = createHash('sha256').update(code).digest('hex');
  return { export_id: name, entry: join(root, directory, 'index.cjs'), package_root: root,
    module_root: join(root, directory), files: { 'index.cjs': hash }, package_digest: hash,
    sha256: hash, abi, engine: { typescript: '=5.9.3' } };
}

/** A failure may release host authority only after the candidate owns no live imported worker. */
function released(pattern) {
  return error => {
    assert.match(error.message, pattern);
    assert.deepEqual(error.data, { version: 1, imports: 'released' });
    return true;
  };
}

const base = `/** Fixture adapter composes declarations, while the real TS engine performs every analysis. */
module.exports = ({typescript: ts, contributions = []}) => ({create(info) {
  const suffix = contributions.map(member => member.module({typescript:ts, config:member.config})).join('\\n');
  const original = info.languageServiceHost.getScriptSnapshot.bind(info.languageServiceHost);
  info.languageServiceHost.getScriptSnapshot = file => {
    const snapshot = original(file);
    return snapshot && file.endsWith('/main.ts') ? ts.ScriptSnapshot.fromString(snapshot.getText(0,snapshot.getLength())+'\\n'+suffix) : snapshot;
  };
  return info.languageService;
}});
module.exports.extensionAbis = ['fixture.types/1'];
`;
const first = `/** A real declared global contributes a type; no diagnostics or hover responses are fabricated. */
module.exports = ({config}) => 'declare const contributed: '+config.type+';';`;
const second = `/** The independent second declaration must coexist with the first module. */
module.exports = () => 'declare const label: string;';`;

test('two sealed unknown modules compose actual types; conflicts and throwing factories preserve the previous engine', async () => {
  const source = 'const first: number = contributed;\nconst second: string = label;\n';
  const input = await project({ 'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
    'main.ts': source, 'base/index.cjs': base, 'first/index.cjs': first, 'second/index.cjs': second,
    'broken/index.cjs': 'module.exports = () => { throw new Error("fixture factory failure"); };' });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('main.ts'); client.open(uri, source);
    const context = await client.request('typescript/project/resolve', { uri });
    const before = await client.request('textDocument/diagnostic', { textDocument: { uri } });
    assert.equal(before.items.filter(item => item.code === 2304).length, 2);
    const imports = [descriptor(input.root, 'base', base, 'typescript.adapter/1', 'base'),
      descriptor(input.root, 'first', first, 'fixture.types/1', 'types'), descriptor(input.root, 'second', second, 'fixture.types/1', 'types')];
    const contributions = [{ id: 'first', role: 'types', slot: 'globals', mode: 'compose', abi: 'fixture.types/1', export: 'types', config: { type: 'number' }, before: [], after: [] },
      { id: 'second', role: 'types', slot: 'globals', mode: 'compose', abi: 'fixture.types/1', export: 'types', config: {}, before: [], after: ['first'] }];
    const request = { uri, context: context.context, generation: context.generation, export: 'base', imports, contributions };
    const broken = await readFile(join(input.root, 'broken/index.cjs'), 'utf8');
    await assert.rejects(client.request('typescript/adapter/attach', { ...request,
      imports: [imports[0], descriptor(input.root, 'broken', broken, 'fixture.types/1', 'types')], contributions: [contributions[0]] }), released(/fixture factory failure/i));
    assert.equal((await client.request('textDocument/diagnostic', { textDocument: { uri } })).items.filter(item => item.code === 2304).length, 2,
      'a throwing contribution cannot replace the usable unextended engine');
    await client.request('typescript/adapter/attach', request);
    assert.equal((await client.request('textDocument/diagnostic', { textDocument: { uri } })).items.length, 0);
    const hover = await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 25 } });
    assert.match(hover.contents.value, /contributed: number/);
    await assert.rejects(client.request('typescript/adapter/attach', { ...request, contributions: contributions.map(member => ({ ...member, mode: 'exclusive' })) }), released(/conflict|exclusive/i));
    await assert.rejects(client.request('typescript/adapter/attach', { ...request, contributions: [ { ...contributions[0], after: ['second'] }, contributions[1] ] }), /cycle/i);
    await assert.rejects(client.request('typescript/adapter/attach', { ...request,
      imports: [imports[0], descriptor(input.root, 'broken', broken, 'fixture.types/1', 'types')], contributions: [contributions[0]] }), released(/factory|adapter|composition/i));
    assert.equal((await client.request('textDocument/diagnostic', { textDocument: { uri } })).items.length, 0, 'failed candidate must preserve the previous complete composition');
    assert.equal(await readFile(join(input.root, 'main.ts'), 'utf8'), source);
  } finally { await client.close(); await input.cleanup(); }
});
