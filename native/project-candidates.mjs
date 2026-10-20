/** Bounded configuration discovery delegates membership to the selected compiler's real graphs. */
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProtocolError } from './errors.mjs';

const OMIT = new Set(['node_modules', '.git', 'target', 'dist']);

/** Conventional roots and explicit references are candidates, never proof that a file belongs. */
function configurations(projects) {
  const found = new Set();
  const visited = new Set();
  const canonical = path => projects.file(pathToFileURL(path).href);
  const visit = path => {
    let directory;
    try { directory = canonical(path); } catch { return; }
    if (visited.has(directory)) return;
    if (visited.size >= 4096) throw new ProtocolError(-32000, 'Project discovery directory quota exceeded');
    visited.add(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (OMIT.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // Reparse points remain subject to the same workspace containment as ordinary sources.
        // visit canonicalizes before enumeration; even a transient outside link reveals no names.
        try { visit(path); } catch (error) {
          if (error instanceof ProtocolError) throw error;
        }
      } else if (entry.name === 'tsconfig.json' || entry.name === 'jsconfig.json') add(path);
    }
  };
  const add = path => {
    const config = canonical(path);
    if (found.has(config)) return;
    if (found.size >= 128) throw new ProtocolError(-32000, 'Project configuration quota exceeded');
    found.add(config);
    const parsed = projects.configurations.ts.getParsedCommandLineOfConfigFile(config, {}, {
      ...projects.configurations.ts.sys, onUnRecoverableConfigFileDiagnostic() {},
    });
    for (const reference of parsed?.projectReferences ?? []) {
      const candidate = reference.path.endsWith('.json') ? reference.path : join(reference.path, 'tsconfig.json');
      try { add(candidate); } catch (error) {
        if (error instanceof ProtocolError) throw error;
        // A missing reference is an engine diagnostic, not an invented selectable project.
      }
    }
  };
  visit(projects.root);
  return [...found].sort();
}

/** Public tsserver ExternalProject semantics load configured projects without creating disk files. */
export async function loadConfigurations(projects, engine, configs, identity = 'catalog') {
  await engine.request('openExternalProject', {
    projectFileName: join(projects.root, `.nanobug-${identity}`),
    rootFiles: configs.map(fileName => ({ fileName })), options: {}, typeAcquisition: { enable: false },
  });
}

/** Check the returned identity as tsserver otherwise silently falls back for an unknown project. */
export async function contains(projects, engine, uri, config) {
  const file = projects.document(uri).file;
  const info = await engine.request('projectInfo', { file, projectFileName: config, needFileNameList: true });
  if (projects.identity(info.configFileName) !== projects.identity(config) || !Array.isArray(info.fileNames)) return false;
  return info.fileNames.some(member => {
    try { return projects.identity(projects.file(pathToFileURL(member).href)) === projects.identity(file); }
    catch { return false; }
  });
}

/** Only compiler-confirmed memberships are exposed; directory scans cannot grant an analysis context. */
export async function candidates(projects, uri) {
  await projects.ready;
  projects.document(uri);
  const configs = configurations(projects);
  if (configs.length) await loadConfigurations(projects, projects.engine, configs);
  const result = [];
  for (const config of configs) {
    if (!await contains(projects, projects.engine, uri, config)) continue;
    const project = await projects.configured(config);
    result.push({ key: project.key, generation: project.generation, stamp: project.fingerprint,
      root: relative(projects.root, dirname(config)).split(sep).join('/'),
      config: relative(projects.root, config).split(sep).join('/') });
  }
  return result;
}
