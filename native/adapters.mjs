/** Adapter admission validates host seals; executable foreign modules run only in owned children. */
import { realpathSync, readFileSync } from 'node:fs';
import { relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ProtocolError, invalid, stale } from './errors.mjs';
import { Engine } from './engine.mjs';
import closure from './module-closure.cjs';
import { compose } from './composition.mjs';
import { loadConfigurations } from './project-candidates.mjs';

/** No caller path, public descriptor or export name alone grants native loading authority. */
export async function attach(projects, params) {
  let candidate;
  try {
    if (projects.retired) throw new ProtocolError(-32001, 'TypeScript service retired');
    const imports = params._nanobug?.imports;
    const composition = compose(imports, params.contributions, projects.engineVersion, params.export);
    const descriptor = imports[0];
    if (descriptor.export_id !== params.export || descriptor.abi !== 'typescript.adapter/1' || descriptor.engine?.typescript !== `=${projects.engineVersion}`) throw invalid('Incompatible adapter ABI or engine seal');
    if (![descriptor.package_digest, descriptor.sha256].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw invalid('Invalid immutable adapter digest');
    const entry = realpathSync.native(descriptor.entry);
    const root = realpathSync.native(descriptor.package_root);
    const rel = relative(root, entry);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw invalid('Adapter entry escapes authorized package');
    if (createHash('sha256').update(readFileSync(entry)).digest('hex') !== descriptor.sha256) throw invalid('Adapter digest mismatch');
    try { closure.verifyClosure(descriptor); } catch (error) { throw invalid(error.message); }
    const context = await projects.describe(params.context, params.consumer);
    if (context.generation !== params.generation) throw stale('Project context generation changed');
    if ((await projects.project(params.uri, context.key)).project !== context.project) throw invalid('Adapter document belongs to another project');
    const previous = projects.adapters.get(context.project);
    if (previous && previous.composition === composition.fingerprint) return { ...context, adapter: previous.export };
    if (previous) throw new ProtocolError(-32005, 'Project already has a different module composition; retire its host configuration before switching');
    if (projects.adapters.size >= 8) throw new ProtocolError(-32000, 'Adapter worker quota exceeded');
    const engine = candidate = new Engine(projects.entry, projects.projectRoot, { ...composition.adapter, entry });
    projects.candidatesInFlight.add(engine);
    await engine.adapterReady;
    await projects.configure(engine);
    // Replaying every admitted open snapshot ensures unsaved imported JS/TS is never replaced by disk.
    // Each engine retains TS's own configured-project graph; no consumer supplies document contents.
    for (const document of projects.documents.values()) await projects.openOn(engine, document);
    if (context.config) await loadConfigurations(projects, engine, [context.config], 'adapter-context');
    await engine.request('projectInfo', { file: projects.document(params.uri).file, needFileNameList: false,
      ...(context.config ? { projectFileName: context.config } : {}) });
    await engine.adapterApplied;
    if (projects.retired) throw new ProtocolError(-32001, 'TypeScript service retired');
    engine.admit(() => projects.failed());
    projects.adapters.set(context.project, { engine, export: descriptor.export_id, digest: descriptor.package_digest, composition: composition.fingerprint });
    projects.candidatesInFlight.delete(engine);
    return { ...context, adapter: descriptor.export_id };
  } catch (error) {
    // This receipt describes only this request's newly reserved imports. Existing successful
    // attachments remain live. Factory failures attest release only after physical child closure;
    // preflight failures have no candidate to retain those imports. External effects are not undone.
    if (candidate) { await candidate.close(); projects.candidatesInFlight.delete(candidate); }
    throw new ProtocolError(error instanceof ProtocolError ? error.code : -32602,
      error instanceof ProtocolError ? error.message : 'Adapter admission failed',
      { version: 1, imports: 'released' });
  }
}
