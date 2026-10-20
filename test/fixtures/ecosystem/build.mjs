/** Select inert fixture data and seal the same immutable factory for every public role.
 * This prepares source inputs only; Nanobug --plugin-package supplies the SDK and builds the ZIP.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

/** CLI variants become ordinary Package metadata and assets, never a special host switch. */
const options = { scenario: 'types', id: 'unfamiliar-ecosystem', version: '0.1.2' };
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index].slice(2);
  if (!process.argv[index].startsWith('--') || !Object.hasOwn(options, name) || !process.argv[index + 1]) {
    throw new Error('Usage: node build.mjs [--scenario name] [--id plugin-id] [--version 0.1.2]');
  }
  options[name] = process.argv[index + 1];
}
if (!/^[a-z][a-z0-9-]{0,63}$/.test(options.id)
  || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(options.version)) {
  throw new Error('Expected a bounded fixture plugin ID and an exact semantic version');
}
const scenarios = JSON.parse(await readFile(new URL('scenarios.json', import.meta.url), 'utf8'));
if (!Object.hasOwn(scenarios, options.scenario)) throw new Error(`Unknown fixture scenario: ${options.scenario}`);
const contributions = JSON.stringify(scenarios[options.scenario], null, 2) + '\n';
if (Buffer.byteLength(contributions) > 8192) throw new Error('Fixture contributions exceed the 8 KiB guest quota');
const method = JSON.parse(await readFile(new URL('../../../contribution-contract.json', import.meta.url), 'utf8'))['language.contribution'];
const factory = await readFile(new URL('modules/check/index.cjs', import.meta.url));
const hash = createHash('sha256').update(factory).digest('hex');

/** Independent export roots satisfy Package admission without weakening each import's authority.
 * Copies contain the same complete immutable factory bytes; they are not forwarding wrappers.
 */
const moduleExports = {};
for (const name of ['types', 'template', 'style', 'project', 'check']) {
  const root = `modules/${name}`;
  await mkdir(new URL(`${root}/`, import.meta.url), { recursive: true });
  if (name !== 'check') await writeFile(new URL(`${root}/index.cjs`, import.meta.url), factory);
  moduleExports[name] = { root, entry: 'index.cjs', sha256: hash, files: { 'index.cjs': hash },
    abi: 'vue.language-plugin/1', engine: { typescript: '=5.9.3' } };
}
const manifest = {
  id: options.id, name: 'Unfamiliar ecosystem fixture', version: options.version,
  protocol: 7, component: 'plugin.wasm', storage_limit: 1024,
  // Reading the immutable declaration asset needs capability negotiation as well as permission.
  api: { base: '^1', required: { 'plugin.services': '>=1.2,<2', 'language.modules': '^1', 'package.assets': '^1' } },
  permissions: ['assets.read', 'native.modules', 'editor.read', 'workspace.read'],
  plugin_services: { provides: { 'language.contribution': method } }, module_exports: moduleExports,
};
await writeFile(new URL('manifest.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(new URL('contributions.json', import.meta.url), contributions);
