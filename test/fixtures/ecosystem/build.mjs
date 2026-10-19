/** Produce the independent admission manifest from its exact public contract and immutable bytes. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const method = JSON.parse(await readFile('../../../contribution-contract.json','utf8'))['language.contribution'];
const hash = createHash('sha256').update(await readFile('modules/check/index.cjs')).digest('hex');
await writeFile('manifest.json',JSON.stringify({id:'unfamiliar-ecosystem',name:'Unfamiliar ecosystem fixture',version:'0.1.0',protocol:7,
  component:'plugin.wasm',storage_limit:1024,
  api:{base:'^1',required:{'plugin.services':'>=1.2,<2','language.modules':'^1'}},
  permissions:['native.modules','editor.read','workspace.read'],plugin_services:{provides:{'language.contribution':method}},
  module_exports:{check:{root:'modules/check',entry:'index.cjs',sha256:hash,files:{'index.cjs':hash},abi:'vue.language-plugin/1',engine:{typescript:'=5.9.3'}}}
},null,2)+'\n');
