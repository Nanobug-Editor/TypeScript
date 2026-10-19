/** Retired opaque references release quota while another consumer and native document remain live. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, project } from './client.mjs';

test('native consumer retirement rejects old contexts and preserves another caller', async () => {
  const fixture = await project({'source.ts':'export const value = 1;'});
  const client = new Client();
  const uri = fixture.uri('source.ts');
  try {
    await client.initialize(fixture.root);
    client.open(uri,'export const value = 1;');
    const first = await client.request('typescript/project/resolve',{uri,consumer:'original-a'});
    const second = await client.request('typescript/project/resolve',{uri,consumer:'original-b'});
    assert.notEqual(first.context,second.context);
    await client.request('nanobug/controlConsumersRetired',{consumers:['original-a']});
    await assert.rejects(client.request('typescript/project/describe',{context:first.context,consumer:'original-a'}),/retired/);
    assert.equal((await client.request('typescript/project/describe',{context:second.context,consumer:'original-b'})).context,second.context);
    await client.request('nanobug/controlConsumersRetired',{consumers:['original-a']});
    // More consumer incarnations than the retained-reference quota can come and go without leaks.
    for (let index=0;index<140;index++) {
      const consumer=`transient-${index}`;
      await client.request('typescript/project/resolve',{uri,consumer});
      await client.request('nanobug/controlConsumersRetired',{consumers:[consumer]});
    }
    assert.ok(await client.request('textDocument/hover',{textDocument:{uri},position:{line:0,character:14}}));
  } finally {await client.close();await fixture.cleanup();}
});
