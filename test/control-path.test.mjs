/** Rust normalizes Windows drive URIs to lowercase while native realpaths may retain uppercase. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, project } from './client.mjs';

test('host path controls use the exact sealed didOpen URI and revision', {skip:process.platform!=='win32'}, async()=>{
  const input=await project({'main.ts':'export const value = 42;\n'});
  const client=new Client();
  try {
    await client.initialize(input.root);
    const uri=input.uri('main.ts').replace(/^file:\/\/\/([A-Z]):/,(_,drive)=>`file:///${drive.toLowerCase()}:`);
    client.open(uri,'export const value = 42;\n','typescript',7);
    // The actual host synchronizes this same source and seals its metadata for all controls, even
    // resolve/attach. Send the public wrapper directly so the test doesn't normalize it for us.
    const document={id:'native-open',path:'main.ts',revision:23};
    const source={document,uri,version:7};
    const call=(sources)=>new Promise((resolve,reject)=>{
      const id=++client.next;
      const timer=setTimeout(()=>reject(new Error('Control path test timed out')),20000);
      client.pending.set(id,{resolve:value=>resolve(JSON.parse(value.payload)),reject,timer});
      client.send({jsonrpc:'2.0',id,method:'typescript/project/resolve',params:{arguments:{path:'main.ts',payload:'{}'},_nanobug:{owner:'typescript',consumer:'test-consumer',imports:[],sources}}});
    });
    const context=await call([source]);
    assert.equal(context.kind,'inferred');
    await assert.rejects(call([{...source,version:6}]),/revision|snapshot/i);
    const hover=await client.request('textDocument/hover',{textDocument:{uri},position:{line:0,character:15}});
    assert.match(hover.contents.value,/value.*42/);
  } finally {await client.close();await input.cleanup();}
});

test('Windows definitions references and rename retain the exact open URI and wire version', {skip:process.platform!=='win32'}, async()=>{
  const text='export const value = 42;\nvalue;\n';
  const input=await project({'main.ts':text});
  const client=new Client();
  try {
    await client.initialize(input.root);
    const uri=input.uri('main.ts').replace(/^file:\/\/\/([A-Z]):/,(_,drive)=>`file:///${drive.toLowerCase()}:`);
    client.open(uri,text,'typescript',9);
    const params={textDocument:{uri},position:{line:1,character:2}};
    const definitions=await client.request('textDocument/definition',params);
    assert.ok(definitions.length);
    assert.ok(definitions.every(item=>item.uri===uri),JSON.stringify(definitions));
    const references=await client.request('textDocument/references',{...params,context:{includeDeclaration:true}});
    assert.ok(references.length>=2);
    assert.ok(references.every(item=>item.uri===uri),JSON.stringify(references));
    const rename=await client.request('textDocument/rename',{...params,newName:'updated'});
    assert.deepEqual(rename.documentChanges.map(change=>change.textDocument),[{uri,version:9}]);
    assert.equal(rename.documentChanges[0].edits.length,2);
    await assert.rejects(client.request('textDocument/didOpen',{textDocument:{uri:input.uri('main.ts'),text:'const alien=1;',languageId:'typescript',version:1}}),/identity|already open/i);
    const hover=await client.request('textDocument/hover',params);
    assert.match(hover.contents.value,/value.*42/);
  } finally {await client.close();await input.cleanup();}
});
