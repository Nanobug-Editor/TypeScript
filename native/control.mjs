/** Collaboration requests expose bounded readonly analysis, not tsserver process control. */
import { invalid, stale, ProtocolError } from './errors.mjs';
import { offset } from './coordinates.mjs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Commands are deliberately a closed vocabulary; document synchronization stays host-owned.
const COMMANDS = new Set(['quickinfo', 'definition', 'typeDefinition', 'references', 'rename',
  'completionInfo', 'completionEntryDetails', 'semanticDiagnosticsSync', 'syntacticDiagnosticsSync', 'format']);
const ARGUMENTS = new Set(['line', 'offset', 'endLine', 'endOffset', 'findInStrings', 'findInComments',
  'includeExternalModuleExports', 'includeInsertTextCompletions', 'entryNames', 'options']);

/** A workspace path is routing metadata, not an alternate document identity. Bind it to exactly
 * one host-sealed open source and its current wire version before resolving/attaching/analyzing.
 * This preserves Rust's original URI spelling and never reads disk to guess a source revision.
 */
export function controlUri(projects, params, sourceRequired) {
  const path = params.path;
  if (typeof path !== 'string' || !path || path.length > 4096 || /[\\:\x00-\x1f]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) throw invalid('Invalid control document path');
  const candidate = pathToFileURL(join(projects.root, path)).href;
  const file = projects.file(candidate);
  if (!sourceRequired) return candidate;
  const sources = params._nanobug?.sources;
  if (!Array.isArray(sources) || !sources.length || sources.length > 128) throw invalid('Control path requires host-sealed source snapshots');
  const matches = sources.filter(source => source?.document?.path === path);
  if (matches.length !== 1) throw invalid('Control target requires one exact host source');
  const source = matches[0];
  if (typeof source.document.id !== 'string' || !source.document.id || source.document.id.length > 128
    || !Number.isSafeInteger(source.document.revision) || source.document.revision < 0
    || typeof source.uri !== 'string' || !Number.isInteger(source.version) || source.version < 1
    || projects.file(source.uri) !== file) throw invalid('Control source identity does not match its target');
  if (projects.document(source.uri).version !== source.version) throw stale('Control source snapshot revision changed');
  return source.uri;
}

/** Analyze only host-synchronized sources; optional caller preconditions use native document IDs. */
export async function analyze(projects, params) {
  const context = await projects.describe(params.context, params.consumer);
  if (params.generation !== context.generation) throw stale('Project context generation changed');
  const sources = params._nanobug?.sources;
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > 128) throw invalid('Analysis requires a host-sealed source snapshot vector');
  const identities = new Set();
  for (const source of sources) {
    const document = source?.document;
    if (!document || typeof document.id !== 'string' || !document.id || document.id.length > 128
      || typeof document.path !== 'string' || !document.path || document.path.length > 4096
      || /[\\:\x00-\x1f]/.test(document.path) || document.path.split('/').some(part => !part || part === '.' || part === '..')
      || !Number.isSafeInteger(document.revision) || document.revision < 0
      || typeof source.uri !== 'string' || !Number.isInteger(source.version) || source.version < 1
      || identities.has(document.id)) throw invalid('Invalid host source snapshot metadata');
    if (projects.file(pathToFileURL(join(projects.root, document.path)).href) !== projects.file(source.uri)) throw invalid('Host source identity does not match its URI');
    identities.add(document.id);
  }
  const versions = sources.map(source => source.document);
  if (params.versions !== undefined) {
    if (!Array.isArray(params.versions) || !params.versions.length || params.versions.length > 128) throw invalid('Invalid native source revision preconditions');
    for (const expected of params.versions) {
      if (!expected || !versions.some(document => document.id === expected.id
        && document.path === expected.path && document.revision === expected.revision)) throw stale('Native source snapshot revision changed');
    }
  }
  const check = async () => {
    await projects.describe(params.context, params.consumer);
    for (const item of sources) {
      if (projects.document(item.uri).version !== item.version) throw stale('Analysis source revision changed');
    }
  };
  await check();
  const targetSource = sources.find(source => source.uri === params.uri);
  if (!targetSource) throw invalid('Analysis target is not in the host source snapshot');
  const target = projects.document(targetSource.uri);
  const engine = projects.adapters.get(context.project)?.engine ?? projects.engine;
  if (!COMMANDS.has(params.command) && !engine.commands.has(params.command)) throw new ProtocolError(-32601, 'Analysis command is not permitted');
  const owned = await projects.project(target.uri);
  if (owned.project !== context.project) throw invalid('Analysis document belongs to another project context');
  const args = params.arguments ?? {};
  if (engine.commands.has(params.command)) {
    if (!Array.isArray(args) || args.length > 16 || args.some(value => typeof value !== 'string' && typeof value !== 'number') || Buffer.byteLength(JSON.stringify(args)) > 8192) throw invalid('Invalid adapter analysis arguments');
    const result = await engine.request(params.command, [target.file, ...args]);
    await check();
    return { context: context.context, generation: context.generation, versions, result };
  }
  if (Object.keys(args).some(key => !ARGUMENTS.has(key)) || Buffer.byteLength(JSON.stringify(args)) > 65536) throw invalid('Invalid or oversized analysis arguments');
  if (args.line !== undefined || args.offset !== undefined) offset(target.text, { line: args.line - 1, character: args.offset - 1 });
  const result = await engine.request(params.command, { ...args, file: target.file });
  await check();
  return { context: context.context, generation: context.generation, versions, result };
}
