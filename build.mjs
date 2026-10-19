/** Prepare a self-contained Windows service; archive creation remains a direct native tool step. */
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const stage = 'target/service';
if (process.argv.includes('--stage')) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v24.19.0') throw new Error('Service staging requires the tested Windows x64 Node 24.19.0 runtime');
  await mkdir(stage, { recursive: true });
  await cp('native', join(stage, 'native'), { recursive: true });
  await cp(dirname(require.resolve('typescript/package.json')), join(stage, 'node_modules/typescript'), { recursive: true, dereference: true });
  await cp(process.execPath, join(stage, 'node.exe'));
  await cp('licenses/node-LICENSE.txt', join(stage, 'node-LICENSE.txt'));
  process.exit(0);
}
const archive = 'artifacts/typescript-windows-x86_64.zip';
const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
const string = max_bytes => ({ type: 'string', max_bytes });
const record = fields => ({ type: 'record', fields });
const payload = string(49152);
const document = record({ path: string(4096), generation: { type: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER } });
const result = record({ payload });
const method = (native = false, attach = false) => ({ parameters: native ? record({ path: string(4096), payload }) : record({ document, payload }),
  result: attach && !native ? record({ payload, binding: string(128) }) : result,
  permissions: attach ? ['editor.read', 'workspace.read', 'native.modules'] : ['editor.read', 'workspace.read'] });
const contracts = {
  'typescript.project': { version: '1.0.0', methods: { resolve: method(), describe: method(), release: method() } },
  'typescript.analysis': { version: '1.0.0', methods: { request: method() } },
  'typescript.adapter': { version: '1.1.0', methods: { attach: method(false, true) } },
};
// Discovery is explicitly composable. The final module-loading guest owns all returned references;
// adapters supply domain-specific ABIs, while the host and TS facade keep only bounded metadata.
const contribution = { version: '^1', optional: true, collection: true, methods: { prepare: method(false, true) } };
contribution.methods.prepare.result = result;
// Exporting exact public schemas lets independent consumers negotiate without private source imports.
await writeFile('contracts.json', JSON.stringify(contracts, null, 2) + '\n');
await writeFile('contribution-contract.json', JSON.stringify({ 'language.contribution': { version: '1.0.0', collection: true, methods: contribution.methods } }, null, 2) + '\n');
const control_methods = {};
for (const [contract, value] of Object.entries(contracts)) for (const name of Object.keys(value.methods)) {
  control_methods[`${contract.replace('.', '/')}/${name}`] = method(true, name === 'attach');
}
// Native overlay membership is a readonly graph query with host-supplied document metadata only.
const graphDocument = record({ id: string(128), uri: string(16384), revision: { type: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER } });
control_methods['typescript/project/documents'] = {
  parameters: record({ target: graphDocument, candidates: { type: 'array', items: graphDocument, max_items: 128 } }),
  result: record({ generation: string(128), documents: { type: 'array', items: string(128), max_items: 128 } }),
  permissions: ['editor.read', 'workspace.read'],
};
const manifest = {
  id: 'typescript', name: 'TypeScript', version: '0.1.10', protocol: 7, scope: 'workspace',
  component: 'typescript.wasm', contributions: 'plugin.toml', storage_limit: 1024,
  permissions: ['editor.read', 'editor.write', 'workspace.read', 'process.service.engine', 'dependencies.prepare', 'native.modules', 'services.call'],
  api: { base: '^1', required: { 'plugin.services': '>=1.2,<2', 'language.lsp': '>=1.5,<2',
    'language.control': '^1', 'language.modules': '^1', 'language.editing': '^1', 'language.formatting': '^1',
    'configuration': '^1', 'workspace.files': '>=1.3,<2', 'editor.edit': '>=1.1,<2', 'process': '^1', 'dependencies': '>=1.2,<2', 'editor.documents': '>=1.1,<2' } },
  settings: { 'typescript.sdk': { title: 'TypeScript SDK / TypeScript 引擎目录', value_type: { kind: 'string', max_length: 4096 }, default: '', scope: 'project' } },
  plugin_services: { provides: contracts, requires: { 'language.contribution': contribution } },
  services: { engine: { program: 'node', platforms: ['windows-x86_64'], args: ['${dependency:tools}/native/main.mjs'],
    installation: { executable: 'tools/node.exe', artifacts: [{ id: 'tools', version: '0.1.10', platform: 'windows-x86_64',
      sha256, source: { kind: 'package', path: archive }, format: { kind: 'zip' } }] } } },
  language_servers: [{ id: 'analysis', language: 'typescript', languages: ['javascript', 'javascriptreact', 'typescriptreact'],
    service: 'engine', hook: true, primary: true, formatting: true, editing: true, control_methods,
    related_documents: 'typescript/project/documents',
    completion_triggers: ['.', '"', "'", '/', '@'] }],
};
await writeFile('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
