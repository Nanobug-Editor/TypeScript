/** Project graph membership is queried through real compiler IO and readonly native metadata. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, project } from './client.mjs';

test('related overlays include shared imports, exclude another project and stabilize across batches', async () => {
  const fixture = await project({
    'first/tsconfig.json': '{"compilerOptions":{"strict":true},"files":["source.ts"]}',
    'first/source.ts': "import { shared } from '../shared'; export const first = shared;",
    'second/tsconfig.json': '{"files":["source.ts"]}',
    'second/source.ts': "export const second = 2;",
    'shared.ts': "export const shared = 'text';",
    'later.ts': "export const later = 3;",
  });
  const client = new Client();
  const target = {id:'first',uri:fixture.uri('first/source.ts'),revision:1};
  const shared = {id:'shared',uri:fixture.uri('shared.ts'),revision:1};
  const second = {id:'second',uri:fixture.uri('second/source.ts'),revision:1};
  const later = {id:'later',uri:fixture.uri('later.ts'),revision:1};
  const query = candidates => client.request('typescript/project/documents', {arguments:{target,candidates},_nanobug:{native:true}});
  try {
    await client.initialize(fixture.root);
    client.open(target.uri,"import { shared } from '../shared'; export const first = shared;");
    client.open(second.uri,'export const second = 2;');
    const first = await query([target,shared,second,later]);
    assert.deepEqual(first.documents.sort(),['first','shared']);
    assert.equal((await query([shared])).generation,first.generation);
    assert.equal((await query([second,later])).generation,first.generation);
    client.notify('textDocument/didChange',{textDocument:{uri:target.uri,version:2},contentChanges:[{text:"import { later } from '../later'; export const first = later;"}]});
    const changed = await query([target,shared,second,later]);
    assert.deepEqual(changed.documents.sort(),['first','later']);
    assert.notEqual(changed.generation,first.generation);
    await assert.rejects(client.request('typescript/project/documents',{arguments:{target,candidates:[]},_nanobug:{}}),/native host/);
    await assert.rejects(query([shared,shared]),/Invalid related/);
    assert.ok(await client.request('textDocument/hover',{textDocument:{uri:target.uri},position:{line:0,character:13}}));
  } finally {await client.close();await fixture.cleanup();}
});
