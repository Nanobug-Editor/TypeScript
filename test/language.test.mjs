/** Seven editor features use a real TS engine through standard LSP requests and native text snapshots. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, project } from './client.mjs';

/** Server-wide names must not hide a project auto-import before the editor filters the typed prefix. */
test('auto-import survives a completion set larger than 256 candidates', async () => {
  const input = await project({
    'tsconfig.json': '{"compilerOptions":{"strict":true},"include":["*.ts"]}',
    'math.ts': 'export function double(value: number) { return value * 2; }\n',
    'completion.ts': '',
  });
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('completion.ts');
    client.open(uri, 'doub');
    const result = await client.request('textDocument/completion', {
      textDocument: { uri }, position: { line: 0, character: 4 },
    });
    const item = result.items.find(item => item.label === 'double');
    assert.ok(item, 'the real project export must survive the complete compiler result');
    assert.ok(result.items.length > 256, 'exercise a result beyond the former silent truncation');
    const resolved = await client.request('completionItem/resolve', item);
    assert.ok(resolved.additionalTextEdits.some(edit => /import.*double.*math/.test(edit.newText)));
    assert.equal(await readFile(join(input.root, 'completion.ts'), 'utf8'), '');
  } finally { await client.close(); await input.cleanup(); }
});

test('range formatting returns edits only for the requested source lines', async () => {
  const source = 'const first={x:1};\nconst second={y:2};\n';
  const input = await project({ 'main.ts': source });
  const client = new Client();
  try {
    const initialized = await client.initialize(input.root);
    assert.equal(initialized.capabilities.documentRangeFormattingProvider, true);
    const uri = input.uri('main.ts');
    client.open(uri, source);
    const params = { textDocument: { uri }, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 18 } },
      options: { tabSize: 2, insertSpaces: true } };
    const edits = await client.request('textDocument/rangeFormatting', params);
    assert.ok(edits.length > 0);
    assert.ok(edits.every(edit => edit.range.start.line === 1 && edit.range.end.line === 1));
    await assert.rejects(client.request('textDocument/rangeFormatting', { ...params,
      range: { start: { line: 1, character: 5 }, end: { line: 1, character: 1 } } }), /range/i);
    assert.equal(await readFile(join(input.root, 'main.ts'), 'utf8'), source);
  } finally { await client.close(); await input.cleanup(); }
});

test('seven language features preserve source ranges and unsaved cross-file dependencies', async () => {
  const model = 'export const message = "disk";\n';
  const source = 'import { message } from "./model";\nconst count: number = message;\nmessage.toUpperCase();\n';
  const input = await project({ 'tsconfig.json': '{"compilerOptions":{"strict":true,"target":"ES2022"},"include":["*.ts"]}',
    'model.ts': model, 'main.ts': source });
  const client = new Client();
  const uri = input.uri('main.ts');
  try {
    await client.initialize(input.root);
    client.open(input.uri('model.ts'), 'export const message = "unsaved";\n');
    client.open(uri, source);
    const request = (method, extra = {}) => client.request(`textDocument/${method}`, { textDocument: { uri }, ...extra });
    const diagnostics = await request('diagnostic');
    assert.ok(diagnostics.items.some(item => item.code === 2322));
    const hover = await request('hover', { position: { line: 2, character: 3 } });
    assert.match(hover.contents.value, /unsaved/);
    const completion = await request('completion', { position: { line: 2, character: 11 } });
    assert.ok(completion.items.some(item => item.label === 'toUpperCase'));
    const definition = await request('definition', { position: { line: 2, character: 3 } });
    assert.equal(definition[0].uri, input.uri('model.ts'));
    const references = await request('references', { position: { line: 2, character: 3 }, context: { includeDeclaration: true } });
    assert.ok(references.length >= 3);
    const rename = await request('rename', { position: { line: 2, character: 3 }, newName: 'greeting' });
    assert.ok(rename.documentChanges.some(item => item.textDocument.uri === input.uri('model.ts')));
    assert.ok(rename.documentChanges.some(item => item.textDocument.uri === uri));
    assert.ok(rename.documentChanges.flatMap(item => item.edits).every(item => item.newText.includes('greeting')));
    client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'const a={x:1,y:2};\n' }] });
    const formatting = await request('formatting', { options: { tabSize: 2, insertSpaces: true } });
    assert.ok(formatting.length > 0);
    client.notify('textDocument/didChange', { textDocument: { uri, version: 3 }, contentChanges: [{ text: source }] });
    client.notify('textDocument/didChange', { textDocument: { uri: input.uri('model.ts'), version: 2 }, contentChanges: [{ text: 'export const message = 42;\n' }] });
    const updated = await request('diagnostic');
    assert.ok(updated.items.some(item => item.code === 2339));
    assert.ok(!updated.items.some(item => item.code === 2322));
    assert.equal(await readFile(join(input.root, 'model.ts'), 'utf8'), model);
  } finally { await client.close(); await input.cleanup(); }
});
