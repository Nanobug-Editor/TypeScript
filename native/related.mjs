/** A host-owned readonly project graph query selects which existing native overlays belong together. */
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { invalid } from './errors.mjs';

/** Return only supplied IDs; paths and source text never become authority supplied by a guest.
 * The active engine's project graph includes unsaved imports after ordered source synchronization.
 * Its generation is independent of candidate batching, so the host can reach a stable fixed point.
 */
export async function related(projects, arguments_) {
  const valid = value => value && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128
    && typeof value.uri === 'string' && value.uri.length <= 16384
    && Number.isSafeInteger(value.revision) && value.revision >= 0;
  if (!valid(arguments_?.target) || !Array.isArray(arguments_?.candidates) || arguments_.candidates.length > 128
    || !arguments_.candidates.every(valid) || new Set(arguments_.candidates.map(item => item.id)).size !== arguments_.candidates.length
    || Buffer.byteLength(JSON.stringify(arguments_)) > 65536) throw invalid('Invalid related document query');
  const target = projects.document(arguments_.target.uri);
  const project = await projects.project(target.uri);
  const engine = projects.adapters.get(project.project)?.engine ?? projects.engine;
  const info = await engine.request('projectInfo', { file: target.file, needFileNameList: true,
    ...(project.config ? { projectFileName: project.config } : {}) });
  if (!Array.isArray(info.fileNames)) throw invalid('Compiler did not return a project graph');
  const members = new Set([target.file]);
  for (const file of info.fileNames) {
    // Compiler libraries and virtual helpers may live outside this workspace; neither is an
    // invitation to synchronize unrelated editors or to reveal a foreign filesystem location.
    try { members.add(projects.file(pathToFileURL(file).href)); } catch { /* external compiler input */ }
  }
  const generation = createHash('sha256').update(JSON.stringify([
    project.project, project.generation, [...members].sort(),
  ])).digest('hex');
  return {generation, documents: arguments_.candidates.filter(item => members.has(projects.file(item.uri))).map(item => item.id)};
}
