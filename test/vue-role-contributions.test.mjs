/** Real unknown template and style compilers must affect the TS-owned source-mapped analysis. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, project } from './client.mjs';
const vue = process.env.NANOBUG_VUE_FIXTURES;

test('missing ecosystem roles report only their blocks and preserve script analysis', {skip:!vue}, async()=>{
  const source='<script setup lang="ts">\nconst retained: number = "bad";\n</script>\n<template lang="quill"><p>unknown syntax</p></template>\n<style lang="ink">unknown style</style>';
  const input=await project({'App.vue':source,'tsconfig.json':'{"compilerOptions":{"strict":true,"skipLibCheck":true},"include":["*.vue"]}'});
  await mkdir(join(input.root,'node_modules'));
  await symlink(await realpath(join(vue,'tests/projects/vue3/node_modules/vue')),join(input.root,'node_modules/vue'),'junction');
  const client=new Client();
  try {
    await client.initialize(input.root);
    const uri=input.uri('App.vue');client.open(uri,source,'vue');
    const context=await client.request('typescript/project/resolve',{uri});
    const descriptor=JSON.parse(await readFile(join(vue,'module-exports.json'),'utf8')).modern;
    const primary={...descriptor,export_id:'modern',entry:join(vue,descriptor.root,descriptor.entry),package_root:vue,module_root:join(vue,descriptor.root),package_digest:createHash('sha256').update(JSON.stringify(descriptor.files)).digest('hex')};
    await client.request('typescript/adapter/attach',{uri,context:context.context,generation:context.generation,export:'modern',imports:[primary]});
    const report=await client.request('textDocument/diagnostic',{textDocument:{uri}});
    assert.ok(report.items.some(item=>item.code===2322),JSON.stringify(report));
    const missing=report.items.filter(item=>item.code==='nanobug.missingContribution');
    assert.deepEqual(missing.map(item=>item.range.start.line).sort(),[3,4],JSON.stringify(report));
    assert.ok(missing.some(item=>item.message.includes('quill')));
    assert.ok(missing.some(item=>item.message.includes('ink')));
    const hover=await client.request('textDocument/hover',{textDocument:{uri},position:{line:1,character:8}});
    assert.match(hover.contents.value,/retained: number/);
    assert.equal(await readFile(join(input.root,'App.vue'),'utf8'),source);
  } finally {await client.close();await input.cleanup();}
});

const template = `/** Quill is fixture syntax with HTML-shaped offsets, compiled by the real Vue compiler. */
module.exports = ({modules}) => ({version:2.2, compileSFCTemplate(lang,text,options) {
  if(lang==='quill') return modules['@vue/compiler-dom'].compile(text,options);
}});`;
const style = `/** Ink exposes one source expression as a real style binding, without fabricating diagnostics. */
module.exports = () => ({version:2.2, compileSFCStyle(lang,text) {
  if(lang!=='ink') return;
  const expression='shade.toUpperCase()';
  return {imports:[],classNames:[],bindings:[{text:expression,offset:text.indexOf(expression)}]};
}});`;

/** Only the test harness acts as host admission; modules use normal immutable closure descriptors. */
function sealed(root, code) {
  const hash=createHash('sha256').update(code).digest('hex');
  return {export_id:'role',entry:join(root,'role/index.cjs'),package_root:root,module_root:join(root,'role'),
    files:{'index.cjs':hash},package_digest:hash,sha256:hash,abi:'vue.language-plugin/1',engine:{typescript:'=5.9.3'}};
}

for (const backend of ['modern', 'legacy']) {
test(`${backend}: unknown project contribution configures Vue checks; conflicting options reject the whole composition`, {skip:!vue}, async()=>{
  const source='<script setup lang="ts">\nconst intact = 1;\n</script>\n<template><AbsentThing /></template>';
  const code='module.exports=({config})=>({version:2.2,vueCompilerOptions:{checkUnknownComponents:config.enabled}});';
  const config=JSON.stringify({compilerOptions:{strict:true,skipLibCheck:true,moduleResolution:'Node',module:'ESNext',target:'ES2020'},include:['*.vue'],vueCompilerOptions:{target:backend==='legacy'?2.7:3.5,strictTemplates:true,checkUnknownComponents:false}});
  const input=await project({'App.vue':source,'tsconfig.json':config,'role/index.cjs':code});
  await mkdir(join(input.root,'node_modules'));
  await symlink(await realpath(join(vue,'tests/projects',backend==='legacy'?'vue27':'vue3','node_modules/vue')),join(input.root,'node_modules/vue'),'junction');
  const client=new Client();
  try {
    await client.initialize(input.root);
    const uri=input.uri('App.vue');client.open(uri,source,'vue');
    const context=await client.request('typescript/project/resolve',{uri});
    const descriptor=JSON.parse(await readFile(join(vue,'module-exports.json'),'utf8'))[backend];
    const primary={...descriptor,export_id:'modern',entry:join(vue,descriptor.root,descriptor.entry),package_root:vue,module_root:join(vue,descriptor.root),package_digest:createHash('sha256').update(JSON.stringify(descriptor.files)).digest('hex')};
    const member=(id,enabled)=>({id,role:'project',slot:'vue-options',mode:'compose',abi:'vue.language-plugin/1',export:'role',config:{enabled},before:[],after:[]});
    const request={uri,context:context.context,generation:context.generation,export:'modern'};
    await assert.rejects(client.request('typescript/adapter/attach',{...request,imports:[primary,sealed(input.root,code),sealed(input.root,code)],
      contributions:[member('a',true),member('b',false)]}),/configuration conflict/i);
    await client.request('typescript/adapter/attach',{...request,imports:[primary,sealed(input.root,code)],contributions:[member('a',true)]});
    const diagnostics=await client.request('textDocument/diagnostic',{textDocument:{uri}});
    assert.ok(diagnostics.items.some(item=>item.message.includes('AbsentThing')),JSON.stringify(diagnostics));
    const hover=await client.request('textDocument/hover',{textDocument:{uri},position:{line:1,character:8}});
    assert.match(hover.contents.value,/intact/);
    assert.equal(await readFile(join(input.root,'tsconfig.json'),'utf8'),config);
  } finally {await client.close();await input.cleanup();}
});

for (const [role,code,source,expression] of [
  ['template',template,'<script setup lang="ts">\nconst count = 42;\n</script>\n<template lang="quill"><p>{{count.toUpperCase()}}</p></template>','count'],
  ['style',style,'<script setup lang="ts">\nconst shade = 42;\n</script>\n<template><p>{{shade}}</p></template>\n<style lang="ink">shade.toUpperCase()</style>','shade'],
]) {
test(`${backend}: unknown ${role} compiler contributes diagnostics, navigation and rename with original offsets`, {skip:!vue}, async()=>{
  const config=JSON.stringify({compilerOptions:{strict:true,skipLibCheck:true,moduleResolution:'Node',module:'ESNext',target:'ES2020'},include:['*.vue'],vueCompilerOptions:{target:backend==='legacy'?2.7:3.5,strictTemplates:true,checkUnknownComponents:false}});
  const input=await project({'App.vue':source,'tsconfig.json':config,'role/index.cjs':code});
  await mkdir(join(input.root,'node_modules'));
  await symlink(await realpath(join(vue,'tests/projects',backend==='legacy'?'vue27':'vue3','node_modules/vue')),join(input.root,'node_modules/vue'),'junction');
  const client=new Client();
  try {
    await client.initialize(input.root);
    const uri=input.uri('App.vue'); client.open(uri,source,'vue');
    const context=await client.request('typescript/project/resolve',{uri});
    const descriptor=JSON.parse(await readFile(join(vue,'module-exports.json'),'utf8'))[backend];
    const primary={...descriptor,export_id:'modern',entry:join(vue,descriptor.root,descriptor.entry),package_root:vue,module_root:join(vue,descriptor.root),package_digest:createHash('sha256').update(JSON.stringify(descriptor.files)).digest('hex')};
    await client.request('typescript/adapter/attach',{uri,context:context.context,generation:context.generation,export:'modern',imports:[primary,sealed(input.root,code)],
      contributions:[{id:'unknown-role',role,slot:`${role}-compiler`,mode:'exclusive',abi:'vue.language-plugin/1',export:'role',config:{},before:[],after:[]}]});
    const diagnostics=await client.request('textDocument/diagnostic',{textDocument:{uri}});
    const error=diagnostics.items.find(item=>item.code===2339 && item.message.includes('toUpperCase'));
    assert.ok(error,JSON.stringify(diagnostics));
    const offset=source.lastIndexOf(expression+'.');
    const prefix=source.slice(0,offset); const position={line:prefix.split('\n').length-1,character:prefix.length-prefix.lastIndexOf('\n')-1};
    assert.equal(error.range.start.line,position.line);
    const definitions=await client.request('textDocument/definition',{textDocument:{uri},position});
    assert.ok(definitions.some(item=>(item.range??item.targetSelectionRange).start.line===1),JSON.stringify(definitions));
    const edit=await client.request('textDocument/rename',{textDocument:{uri},position,newName:'renamed'});
    const edits=edit.changes?.[uri]??edit.documentChanges?.flatMap(change=>change.edits)??[];
    assert.ok(edits.some(item=>item.range.start.line===position.line),JSON.stringify(edit));
    assert.ok(edits.some(item=>item.range.start.line===1),JSON.stringify(edit));
    assert.equal(await readFile(join(input.root,'App.vue'),'utf8'),source);
    assert.equal(await readFile(join(input.root,'tsconfig.json'),'utf8'),config);
  } finally {await client.close();await input.cleanup();}
});
}
}
