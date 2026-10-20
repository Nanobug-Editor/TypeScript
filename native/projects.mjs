/** TypeScript alone resolves configured/inferred projects; consumers receive opaque context references. */
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import { Engine } from './engine.mjs';
import { invalid, stale, ProtocolError } from './errors.mjs';
import { applyChanges, endPosition, location } from './coordinates.mjs';
import { attach } from './adapters.mjs';
import { Configurations } from './configuration.mjs';
import { candidates, contains, loadConfigurations } from './project-candidates.mjs';
const require = createRequire(import.meta.url);

export class Projects {
  constructor(rootUri, options = {}, onUnexpectedFailure = () => {}) {
    // The native host uses canonical verbatim Windows paths. Node's JavaScript realpath walk
    // misreads that prefix as a drive-relative component; the native API preserves the same
    // symlink-boundary checks without attempting lstat on the incomplete drive name.
    this.projectRoot = realpathSync.native(fileURLToPath(rootUri));
    this.root = options.workspace ? realpathSync.native(options.workspace) : this.projectRoot;
    const projectRelative = relative(this.root, this.projectRoot);
    if (projectRelative === '..' || projectRelative.startsWith(`..${sep}`) || isAbsolute(projectRelative)) throw invalid('Project root escapes workspace');
    // An explicitly selected SDK is never replaced by the bundled default after failure.
    const explicit = options.typescript;
    if (explicit !== undefined && (typeof explicit !== 'string' || !isAbsolute(explicit))) throw invalid('Explicit TypeScript SDK must be an absolute path');
    let entry;
    try {
      entry = explicit ? realpathSync.native(join(explicit, 'tsserver.js')) : require.resolve('typescript/lib/tsserver.js');
      const pkg = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'));
      if (pkg.name !== 'typescript' || pkg.version !== '5.9.3') throw new Error('Unsupported engine');
      this.engineVersion = pkg.version;
    } catch { throw new ProtocolError(-32004, 'TypeScript SDK missing or incompatible; tested engine is 5.9.3'); }
    this.entry = entry;
    this.configurations = new Configurations(entry, this.root);
    this.adapters = new Map();
    this.contexts = new Map();
    this.byConfig = new Map();
    this.documents = new Map();
    this.retired = false;
    this.onUnexpectedFailure = onUnexpectedFailure;
    // Admission can be awaiting a factory when another published engine fails. Keep provisional
    // children owned for disposal without including them in normal document synchronization.
    this.candidatesInFlight = new Set();
    // Selected context data comes from this plugin's host-registered descriptor, never a tool path.
    if (options.context?.config !== undefined && (typeof options.context.config !== 'string'
      || !options.context.config || /[\\:\x00-\x1f]/.test(options.context.config)
      || options.context.config.split('/').some(part => !part || part === '.' || part === '..'))) throw invalid('Invalid selected project configuration');
    this.selectedConfig = options.context?.config === undefined ? undefined
      : this.file(pathToFileURL(join(this.root, options.context.config)).href);
    // Validate every selected path before spawning; an invalid initialization owns no orphan engine.
    this.engine = new Engine(entry, this.projectRoot);
    this.ready = this.configure(this.engine).then(() => this.engine.admit(() => this.failed()));
  }
  /** A lost admitted compiler invalidates this service's adapter map and all of its source seals. */
  failed() {
    if (this.retired) return;
    this.retired = true;
    this.onUnexpectedFailure();
  }
  /** All owned engine variants receive the same JavaScript and inference policy. */
  configure(engine) {
    return engine.request('configure', { hostInfo: 'Nanobug', preferences: { includeCompletionsForModuleExports: true, includeCompletionsWithInsertText: true } })
      .then(() => engine.request('compilerOptionsForInferredProjects', { options: { allowJs: true, checkJs: true, strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Node' } }));
  }
  /** Adapter workers remain engine implementations of the same TS-owned project context. */
  async engineFor(uri) { return this.adapters.get((await this.project(uri)).project)?.engine ?? this.engine; }
  /** Filesystem identity is canonical and case-insensitive only on Windows. */
  identity(file) { return process.platform === 'win32' ? file.replaceAll('\\', '/').toLowerCase() : file; }
  candidates(uri) { return candidates(this, uri); }
  attach(params) { return attach(this, params); }
  openOn(engine, document) {
    return engine.notify('open', { file: document.file, fileContent: document.text, scriptKindName: scriptKind(document.languageId), projectRootPath: this.projectRoot });
  }
  engines() { return [this.engine, ...[...this.adapters.values()].map(value => value.engine)]; }
  /** Resolve canonical parents for new files; neither symlinks nor sibling-prefix paths grant access. */
  file(uri) {
    let file;
    try { file = fileURLToPath(uri); } catch { throw invalid('Only local file URIs are supported'); }
    let probe = file;
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    const canonical = join(realpathSync.native(probe), relative(probe, file));
    const rel = relative(this.root, canonical);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw invalid('Document escapes workspace');
    return canonical.replaceAll('\\', '/');
  }
  /** Compiler paths resolve back to one already open native identity. Keep its original URI and
   * version instead of manufacturing a second spelling; unopened dependencies use a normal URI.
   */
  uriForFile(file) {
    const uri = pathToFileURL(file).href;
    const canonical = this.file(uri);
    const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
    const matches = [...this.documents.values()].filter(document => identity(document.file) === identity(canonical));
    if (matches.length > 1) throw invalid('Ambiguous open document identity');
    return matches[0]?.uri ?? uri;
  }
  /** Native source snapshots replace the engine overlay, never source files or a second Undo model. */
  async open(document) {
    await this.ready;
    const file = this.file(document.uri);
    if (!Number.isInteger(document.version) || typeof document.text !== 'string') throw invalid('Invalid document snapshot');
    if (this.documents.has(document.uri)
      || [...this.documents.values()].some(previous => process.platform === 'win32'
        ? previous.file.toLowerCase() === file.toLowerCase() : previous.file === file)) throw invalid('Document identity is already open');
    const admitted = { ...document, file };
    try { for (const engine of this.engines()) await this.openOn(engine, admitted); }
    catch (error) { this.failed(); await this.close(); throw error; }
    this.documents.set(document.uri, admitted);
  }
  /** Versions increase within one open incarnation; old updates never reach the compiler overlay. */
  async change(identity, changes) {
    const previous = this.document(identity.uri);
    if (!Number.isInteger(identity.version) || identity.version <= previous.version) throw stale('Document revision did not increase');
    const text = applyChanges(previous.text, changes);
    await this.synchronize('updateOpen', { changedFiles: [{ fileName: previous.file, textChanges: [{
      start: { line: 1, offset: 1 }, end: location(endPosition(previous.text)), newText: text,
    }] }] });
    this.documents.set(identity.uri, { ...previous, text, version: identity.version });
  }
  async closeDocument(uri) {
    const document = this.document(uri);
    await this.synchronize('close', { file: document.file });
    this.documents.delete(uri);
  }
  /** A partial fan-out must invalidate every copy instead of exposing inconsistent overlays. */
  async synchronize(command, args) {
    try { for (const engine of this.engines()) await engine.notify(command, args); }
    catch (error) { this.failed(); await this.close(); throw error; }
  }
  /** ProjectInfo is the authoritative TS project association, not a duplicated directory walk. */
  async project(uri, selected) {
    await this.ready;
    const document = this.document(uri);
    if (selected !== undefined) {
      const selectedProject = [...this.byConfig.values()].find(project => project.key === selected);
      if (!selectedProject) throw stale('Unknown or retired project membership');
      if (selectedProject.config) {
        const adapter = this.adapters.get(selectedProject.project);
        const member = await contains(this, adapter?.engine ?? this.engine, uri, selectedProject.config);
        // Before a deferred extension's adapter exists, the base compiler cannot include it.
        // Preserve only its nearest conventional configured identity for admission, as in S1;
        // after attachment the adapter's real graph must confirm membership itself.
        const awaitingExtension = !adapter && scriptKind(document.languageId) === 'Deferred'
          && this.nearestConfig(document.file) === selectedProject.config;
        if (!member && !awaitingExtension) throw stale('Unknown or retired project membership');
        await this.refresh(selectedProject);
        return selectedProject;
      }
      if ((await this.project(uri)).project !== selectedProject.project) throw stale('Inferred project membership changed');
      return selectedProject;
    }
    if (this.selectedConfig) {
      await loadConfigurations(this, this.engine, [this.selectedConfig], 'selected-context');
      if (!await contains(this, this.engine, uri, this.selectedConfig)) throw invalid('Document does not belong to the selected project');
      return this.configured(this.selectedConfig);
    }
    const info = await this.engine.request('projectInfo', { file: document.file, needFileNameList: false });
    // tsserver cannot associate an unknown extension until its adapter is admitted. Preserve
    // the containing configured-project identity so mixed framework roots never share an inferred key.
    const reported = info.configFileName.replaceAll('\\', '/');
    const config = /inferredProject\d+\*/.test(reported) ? this.nearestConfig(document.file) ?? reported : reported;
    return this.configured(config);
  }
  /** Context keys survive worker restarts; opaque consumer references remain incarnation-bound. */
  async configured(config) {
    let project = this.byConfig.get(config);
    if (!project) {
      const inferred = /inferredProject\d+\*/.test(config);
      project = { project: randomUUID(), generation: 1, kind: inferred ? 'inferred' : 'configured',
        key: `typescript:${createHash('sha256').update(inferred ? `inferred:${this.identity(this.projectRoot)}` : this.identity(config)).digest('hex')}`,
        root: inferred ? this.projectRoot.replaceAll('\\', '/') : dirname(config).replaceAll('\\', '/'),
        config: inferred ? null : config, engineVersion: this.engineVersion,
        features: ['completion', 'diagnostics', 'hover', 'definition', 'references', 'rename', 'formatting'] };
      this.byConfig.set(config, project);
      project.fingerprint = this.fingerprint(project);
    }
    await this.refresh(project);
    return project;
  }
  /** Conventional TS configuration discovery is used only before an extension adapter is active. */
  nearestConfig(file) {
    let directory = dirname(file);
    for (;;) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const candidate = join(directory, name);
        if (existsSync(candidate)) return this.file(pathToFileURL(candidate).href);
      }
      if (directory === dirname(directory) || !relative(this.root, directory) || relative(this.root, directory).startsWith('..')) return undefined;
      directory = dirname(directory);
    }
  }
  fingerprint(project) { return this.configurations.stamp(project.config ?? join(project.root, 'tsconfig.json')); }
  /** Changed config, extends, project references and package/lock evidence invalidate consumer generations. */
  async refresh(project) {
    const fingerprint = this.fingerprint(project);
    if (fingerprint !== project.fingerprint) {
      project.fingerprint = fingerprint; project.generation++;
      for (const [id, lease] of this.contexts) if (lease.project === project) this.contexts.delete(id);
      // The reload is ordered before the next analysis on every existing owned engine.
      await this.synchronize('reloadProjects', {});
    }
  }
  /** Each consumer receives its own release authority while sharing the same underlying project. */
  async resolve(uri, consumer = 'lsp', selected) {
    const project = await this.project(uri, selected);
    for (const [context, lease] of this.contexts) {
      if (lease.project === project && lease.consumer === consumer && lease.generation === project.generation) return this.describe(context, consumer);
    }
    if (this.contexts.size >= 128) throw new ProtocolError(-32000, 'Project context reference quota exceeded');
    const context = randomUUID();
    this.contexts.set(context, { project, consumer, generation: project.generation });
    return this.describe(context, consumer);
  }
  async describe(id, consumer = 'lsp') {
    const lease = this.contexts.get(id);
    if (!lease) throw stale('Unknown or retired project context');
    if (lease.consumer !== consumer) throw new ProtocolError(-32006, 'Context belongs to another consumer');
    await this.refresh(lease.project);
    if (lease.generation !== lease.project.generation) throw stale('Project context generation changed; resolve again');
    const { fingerprint, ...project } = lease.project;
    return { context: id, ...project, registration: {
      key: project.key, generation: project.generation,
      project_root: relative(this.root, project.root).split(sep).join('/'),
      data: { stamp: fingerprint, ...(project.config ? { config: relative(this.root, project.config).split(sep).join('/') } : {}) },
    } };
  }
  async release(id, consumer = 'lsp') {
    await this.describe(id, consumer); this.contexts.delete(id);
    return null;
  }
  /** Only the owning host transport announces original-consumer retirement. This discards opaque
   * references without stopping another consumer's documents, shared engine or adapter worker. */
  retireConsumers(consumers) {
    if (!Array.isArray(consumers) || consumers.length > 128 || consumers.some(value => typeof value !== 'string' || !value || value.length > 256)) throw invalid('Invalid consumer retirement batch');
    const retired = new Set(consumers);
    for (const [id, lease] of this.contexts) if (retired.has(lease.consumer)) this.contexts.delete(id);
    return null;
  }
  document(uri) {
    const document = this.documents.get(uri);
    if (!document) throw stale('Document is not open');
    return document;
  }
  async close() {
    this.retired = true;
    await Promise.all([...this.engines(), ...this.candidatesInFlight].map(engine => engine.close()));
    this.adapters.clear(); this.candidatesInFlight.clear(); this.documents.clear(); this.contexts.clear(); this.byConfig.clear();
  }
}

/** Protocol language identities select TS parsing without relying on file extensions alone. */
export function scriptKind(language) {
  return ({ typescript: 'TS', typescriptreact: 'TSX', javascript: 'JS', javascriptreact: 'JSX', json: 'JSON' })[language] ?? 'Deferred';
}
