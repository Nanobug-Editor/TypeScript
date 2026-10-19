/** Worker-only adapter loader. The owning plugin supplies already sealed immutable entries. */
'use strict';
const { dirname, join } = require('node:path');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const [engineEntry, encoded] = process.argv.slice(2);
const descriptor = JSON.parse(encoded);
const { verifyClosure, installLoader } = require('./module-closure.cjs');
const closure = verifyClosure(descriptor);
const members = descriptor.contributions ?? [];
const closures = members.map(member => verifyClosure(member.descriptor));
installLoader([closure, ...closures], engineEntry);
const ts = require(join(dirname(engineEntry), 'typescript.js'));
if (createHash('sha256').update(readFileSync(descriptor.entry)).digest('hex') !== descriptor.sha256) throw new Error('Adapter entry changed');
const adapter = require(descriptor.entry);
if (typeof adapter !== 'function') throw new Error('Adapter must export a tsserver plugin factory');
const accepted = adapter.extensionAbis ?? [];
if (!Array.isArray(accepted) || members.some(member => !accepted.includes(member.abi))) throw new Error('Primary adapter rejects contribution ABI');
const contributions = members.map(member => ({ ...member, descriptor: undefined, module: require(member.descriptor.entry) }));
// TypeScript catches plugin factory/create exceptions internally. Report them through owned IPC so
// a supposedly successful projectInfo reply cannot publish an uninitialized or incomplete adapter.
const checkedAdapter = modules => {
  try {
    const plugin = adapter({ ...modules, contributions });
    if (!plugin || typeof plugin.create !== 'function') throw new Error('Adapter factory returned no create hook');
    return { ...plugin, create(info) {
      try {
        const service = plugin.create(info);
        if (!service || typeof service.getSemanticDiagnostics !== 'function') throw new Error('Adapter create returned no language service');
        process.send?.({ type: 'adapterApplied' });
        return service;
      } catch (error) { process.send?.({ type: 'adapterFailed', message: String(error.message).slice(0, 1024) }); throw error; }
    } };
  } catch (error) { process.send?.({ type: 'adapterFailed', message: String(error.message).slice(0, 1024) }); throw error; }
};
const commands = adapter.analysisCommands ?? [];
if (!Array.isArray(commands) || commands.length > 64 || commands.some(name => typeof name !== 'string' || !/^_[a-zA-Z][\w-]*:[\w-]+$/.test(name))) throw new Error('Invalid adapter readonly command declaration');
const features = adapter.languageFeatures ?? {};
const allowedFeatures = new Set(['textDocument/formatting', 'textDocument/rangeFormatting', 'textDocument/hover', 'textDocument/completion', 'textDocument/definition', 'textDocument/typeDefinition', 'textDocument/references', 'textDocument/prepareRename', 'textDocument/rename', 'textDocument/diagnostic']);
if (!features || Array.isArray(features) || typeof features !== 'object' || Object.entries(features).some(([method, command]) => !allowedFeatures.has(method) || !commands.includes(command))) throw new Error('Invalid adapter language feature declaration');
// Project plugin discovery is disabled. Even an explicit tsconfig plugin cannot load outside
// this single host-authorized entry, and the factory receives this worker's exact TS singleton.
ts.sys.require = (_base, name) => name === 'nanobug-managed-adapter'
  ? { module: checkedAdapter, modulePath: descriptor.entry, error: undefined }
  : { module: undefined, modulePath: undefined, error: new Error('Unleased project plugin denied') };
ts.sys.importPlugin = undefined;
process.argv = [process.execPath, engineEntry, '--disableAutomaticTypingAcquisition', '--useInferredProjectPerProjectRoot', '--globalPlugins', 'nanobug-managed-adapter'];
ts.sys.args = process.argv.slice(2);
process.send?.({ type: 'adapterReady', commands, features });
require(engineEntry);
