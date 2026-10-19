/** Copy only the published contract schemas into an independently packaged unknown consumer. */
import {readFile,writeFile} from 'node:fs/promises';
const contracts=JSON.parse(await readFile(new URL('../../../contracts.json',import.meta.url),'utf8'));
const requires=Object.fromEntries(['typescript.project','typescript.analysis'].map(name=>[name,{...contracts[name],version:'^1'}]));
await writeFile(new URL('manifest.json',import.meta.url),JSON.stringify({
  id:'unknown-project-consumer',name:'Unknown project consumer fixture',version:'0.1.0',protocol:7,
  component:'plugin.wasm',scope:'workspace',storage_limit:1024,
  api:{base:'^1',required:{'plugin.services':'>=1.1,<2','ui.native':'^1'}},
  permissions:['services.call','editor.read','workspace.read'],plugin_services:{requires},
  commands:[{id:'run',title:'Run public project sequence'}],
  panels:[{id:'receipt',title:'Project sequence receipt',position:'right'}],
},null,2)+'\n');
