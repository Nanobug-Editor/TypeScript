/** An adapter's source-level LSP proposals retain the native host's open-document identity. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client, project } from './client.mjs';
const vue=process.env.NANOBUG_VUE_FIXTURES;

/** This independent adapter deliberately proposes invalid transport edits; it does not simulate
 * TypeScript analysis. The real worker must reject each proposal before returning any edit prefix.
 */
test('unknown adapter edit proposals reject stale versions, duplicate targets and resource operations', async()=>{
  const code=`module.exports=()=>({create(info){info.session.addProtocolHandler('_fixture:rename',request=>{
    const params=JSON.parse(request.arguments[1]);
    const edit={range:{start:{line:0,character:6},end:{line:0,character:11}},newText:'other'};
    const group={textDocument:{uri:params.textDocument.uri,version:8},edits:[edit]};
    let response={documentChanges:[group]};
    if(params.newName==='duplicate')response.documentChanges.push(group);
    if(params.newName==='stale')group.textDocument.version=7;
    if(params.newName==='operation')response.documentChanges.push({kind:'delete',uri:params.textDocument.uri});
    if(params.newName==='annotation')edit.annotationId='unapproved';
    if(params.newName==='outside')group.textDocument.uri=new URL('../outside.ts',params.textDocument.uri).href;
    return {response,responseRequired:true};
  });return info.languageService;}});
  module.exports.languageFeatures={'textDocument/rename':'_fixture:rename'};
  module.exports.analysisCommands=['_fixture:rename'];`;
  const source='const value = 1;';
  const input=await project({'main.ts':source,'tsconfig.json':'{"include":["*.ts"]}','module/index.cjs':code});
  const client=new Client();
  try {
    await client.initialize(input.root);
    const uri=input.uri('main.ts');client.open(uri,source,'typescript',8);
    const context=await client.request('typescript/project/resolve',{uri});
    const hash=createHash('sha256').update(code).digest('hex');
    const imported={export_id:'unknown',entry:join(input.root,'module/index.cjs'),module_root:join(input.root,'module'),
      package_root:input.root,package_digest:hash,files:{'index.cjs':hash},sha256:hash,abi:'typescript.adapter/1',engine:{typescript:'=5.9.3'}};
    await client.request('typescript/adapter/attach',{uri,context:context.context,generation:context.generation,export:'unknown',imports:[imported]});
    const params={textDocument:{uri},position:{line:0,character:8}};
    for(const [newName,error] of [['duplicate',/Duplicate/],['stale',/version changed/],['operation',/only text changes/],['annotation',/Invalid adapter text edit/],['outside',/escapes workspace/]]) {
      await assert.rejects(client.request('textDocument/rename',{...params,newName}),error);
    }
    const valid=await client.request('textDocument/rename',{...params,newName:'valid'});
    assert.deepEqual(valid.documentChanges[0].textDocument,{uri,version:8},'business errors preserve the same connection');
    assert.equal(await readFile(join(input.root,'main.ts'),'utf8'),source);
  } finally {await client.close();await input.cleanup();}
});

test('adapter locations and workspace edits preserve the opened URI and source version', {skip:!vue||process.platform!=='win32'}, async()=>{
  const source='<script setup lang="ts">const count=1;</script>\n<template><p>{{count}}</p></template>\n<style>:root { --accent: red; } p { color: var(--accent); }</style>';
  const input=await project({'App.vue':source,'tsconfig.json':'{"compilerOptions":{"strict":true,"skipLibCheck":true},"include":["*.vue"]}'});
  await mkdir(join(input.root,'node_modules'));
  await symlink(await realpath(join(vue,'tests/projects/vue3/node_modules/vue')),join(input.root,'node_modules/vue'),'junction');
  const client=new Client();
  try {
    await client.initialize(input.root);
    const uri=input.uri('App.vue').replace(/^file:\/\/\/([A-Z]):/,(_,drive)=>`file:///${drive.toLowerCase()}:`);
    client.open(uri,source,'vue',12);
    const context=await client.request('typescript/project/resolve',{path:'App.vue'});
    const descriptor=JSON.parse(await readFile(join(vue,'module-exports.json'),'utf8')).modern;
    const primary={...descriptor,export_id:'modern',entry:join(vue,descriptor.root,descriptor.entry),package_root:vue,module_root:join(vue,descriptor.root),package_digest:createHash('sha256').update(JSON.stringify(descriptor.files)).digest('hex')};
    await client.request('typescript/adapter/attach',{path:'App.vue',context:context.context,generation:context.generation,export:'modern',imports:[primary]});
    const position={line:2,character:source.split('\n')[2].lastIndexOf('--accent')+3};
    const params={textDocument:{uri},position};
    const result=await client.request('textDocument/definition',params);
    const definitions=Array.isArray(result)?result:[result];
    assert.ok(definitions.length);
    assert.ok(definitions.every(item=>(item.uri??item.targetUri)===uri),JSON.stringify(definitions));
    const references=await client.request('textDocument/references',{...params,context:{includeDeclaration:true}});
    assert.equal(references.length,2);
    assert.ok(references.every(item=>item.uri===uri),JSON.stringify(references));
    const rename=await client.request('textDocument/rename',{...params,newName:'--changed'});
    assert.equal(rename.changes,undefined,'native worker seals adapter edits with current wire versions');
    assert.deepEqual(rename.documentChanges.map(change=>change.textDocument),[{uri,version:12}]);
    assert.equal(rename.documentChanges[0].edits.length,2);
    assert.equal(await readFile(join(input.root,'App.vue'),'utf8'),source);
  } finally {await client.close();await input.cleanup();}
});
