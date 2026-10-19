/** Unknown immutable factories contribute real mapped Vue types through the TS-owned LSP worker. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, project } from './client.mjs';
const vue = process.env.NANOBUG_VUE_FIXTURES;
const globals = `/** This declaration is checked by the actual TS engine, not a response stub. */
module.exports = () => ({version:2.2, resolveEmbeddedCode(file,sfc,code) {
  if(code.id === 'script_ts') code.content.push('\\ndeclare function __ecosystem_check(value: string): void;\\n');
}});`;
const mapped = `/** Preserve the original UTF-16 source range while adding a domain type constraint. */
module.exports = () => ({version:2.2, resolveEmbeddedCode(file,sfc,code) {
  if(code.id !== 'script_ts' || !sfc.scriptSetup) return;
  const block = sfc.scriptSetup; const offset = block.content.indexOf('42');
  if(offset < 0) return;
  code.content.push('\\n__ecosystem_check(',['42',block.name,offset,{verification:true}],');\\n');
}});`;

/** The harness stands in for host admission; each immutable closure contains exactly its entry. */
function seal(root, folder, code) {
  const hash = createHash('sha256').update(code).digest('hex');
  return {export_id:'contribution', entry:join(root,folder,'index.cjs'),package_root:root,module_root:join(root,folder),
    files:{'index.cjs':hash}, package_digest:hash,sha256:hash,abi:'vue.language-plugin/1',engine:{typescript:'=5.9.3'}};
}

for (const [directory, backend, target, invalidMap] of [['vue3','modern',3.5,false],['vue27','legacy',2.7,false],['vue3','modern',3.5,true]]) {
test(`${backend}: ${invalidMap ? 'invalid contributed map rejects the complete candidate' : 'unknown factories contribute a real mapped diagnostic from the unsaved SFC'}`, {skip:!vue}, async () => {
  const source = '<script setup lang="ts">\n// 中文😀 preserves UTF-16 coordinates\nconst eco = 42;\n</script>\n<template>{{eco}}</template>\n';
  const disk = source.replace('42', '"saved"');
  const contribution = invalidMap ? mapped.replace("block.name,offset", "block.name,100000") : mapped;
  const input = await project({'App.vue':disk,
    'tsconfig.json':JSON.stringify({compilerOptions:{strict:true,skipLibCheck:true,moduleResolution:'Bundler',module:'ESNext',target:'ES2020'},include:['*.vue'],vueCompilerOptions:{target}}),
    'globals/index.cjs':globals,'mapped/index.cjs':contribution});
  await symlink(await realpath(join(vue,'tests/projects',directory,'node_modules')),join(input.root,'node_modules'),'junction');
  const client = new Client();
  try {
    await client.initialize(input.root);
    const uri = input.uri('App.vue'); client.open(uri,source,'vue');
    const context = await client.request('typescript/project/resolve',{uri});
    const descriptor = JSON.parse(await readFile(join(vue,'module-exports.json'),'utf8'))[backend];
    const primary = { ...descriptor,export_id:backend,entry:join(vue,descriptor.root,descriptor.entry),package_root:vue,module_root:join(vue,descriptor.root),
      package_digest:createHash('sha256').update(JSON.stringify(descriptor.files)).digest('hex') };
    const declaration = id => ({id,role:'types',slot:'script-types',mode:'compose',abi:'vue.language-plugin/1',export:'contribution',config:{},before:[],after:id==='mapped'?['globals']:[]});
    const attach = client.request('typescript/adapter/attach',{uri,context:context.context,generation:context.generation,export:backend,
      imports:[primary,seal(input.root,'globals',globals),seal(input.root,'mapped',contribution)],contributions:['globals','mapped'].map(declaration)});
    if (invalidMap) { await assert.rejects(attach,/mapping/i); return; }
    await attach;
    const diagnostics = await client.request('textDocument/diagnostic',{textDocument:{uri}});
    const error = diagnostics.items.find(item => item.code===2345);
    assert.ok(error,JSON.stringify(diagnostics));
    assert.deepEqual(error.range,{start:{line:2,character:12},end:{line:2,character:14}});
    client.notify('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text:disk}]});
    assert.equal((await client.request('textDocument/diagnostic',{textDocument:{uri}})).items.filter(item=>item.code===2345).length,0);
    assert.equal(await readFile(join(input.root,'App.vue'),'utf8'),disk);
  } finally {await client.close();await input.cleanup();}
});
}
