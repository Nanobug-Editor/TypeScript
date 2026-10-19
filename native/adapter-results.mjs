/** Adapter proposals cross the same source-identity boundary as native TypeScript results.
 * Only known LSP URI fields are normalized; opaque completion data and source text stay untouched.
 */
import { fileURLToPath } from 'node:url';
import { invalid, stale } from './errors.mjs';

/** Resolve one source URI within the admitted workspace, preserving an exact open incarnation. */
function sourceUri(projects, uri) {
  if (typeof uri !== 'string') throw invalid('Adapter source URI is missing');
  let file;
  try { file = fileURLToPath(uri); } catch { throw invalid('Adapter source URI must be a local file'); }
  return projects.uriForFile(file);
}

/** Locations may be singular, arrays, or links; source coordinates already belong to the adapter. */
function sourceLocation(projects, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('Invalid adapter location');
  if ('targetUri' in value) return { ...value, targetUri: sourceUri(projects, value.targetUri) };
  return { ...value, uri: sourceUri(projects, value.uri) };
}

/** Seal text-only proposals without applying them. Unsupported operations reject the whole result,
 * and explicit versions cannot be silently upgraded to the current source incarnation.
 */
function workspaceEdit(projects, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['changes', 'documentChanges'].includes(key))
    || (value.changes !== undefined && value.documentChanges !== undefined)) throw invalid('Invalid adapter workspace edit');
  let groups;
  if (value.changes !== undefined) {
    if (!value.changes || typeof value.changes !== 'object' || Array.isArray(value.changes)) throw invalid('Invalid adapter edit map');
    groups = Object.entries(value.changes).map(([uri, edits]) => ({ textDocument: { uri, version: null }, edits }));
  } else groups = value.documentChanges ?? [];
  if (!Array.isArray(groups) || groups.length > 128) throw invalid('Invalid adapter edit targets');
  const seen = new Set();
  const documentChanges = groups.map(group => {
    if (!group || typeof group !== 'object' || Object.keys(group).some(key => !['textDocument', 'edits'].includes(key))
      || !group.textDocument || !Array.isArray(group.edits)) throw invalid('Adapter edits must contain only text changes');
    const uri = sourceUri(projects, group.textDocument.uri);
    if (seen.has(uri)) throw invalid('Duplicate adapter edit target');
    seen.add(uri);
    const version = projects.documents.get(uri)?.version ?? null;
    const supplied = group.textDocument.version;
    if (supplied != null && (!Number.isInteger(supplied) || supplied !== version)) throw stale('Adapter edit source version changed');
    for (const edit of group.edits) {
      if (!edit || typeof edit !== 'object' || Object.keys(edit).some(key => !['range', 'newText'].includes(key))
        || typeof edit.newText !== 'string' || !validRange(edit.range)) throw invalid('Invalid adapter text edit');
    }
    return { textDocument: { uri, version }, edits: group.edits };
  });
  return { documentChanges };
}

/** Validate inert UTF-16 coordinates; host snapshot preflight performs full range/overlap validation. */
function validRange(range) {
  const valid = point => point && Number.isSafeInteger(point.line) && point.line >= 0
    && Number.isSafeInteger(point.character) && point.character >= 0;
  return range && valid(range.start) && valid(range.end)
    && (range.end.line > range.start.line || range.end.line === range.start.line && range.end.character >= range.start.character);
}

/** Normalize only standardized source-bearing results, preserving each method's public result shape. */
export function adapterResult(projects, method, value) {
  if (method === 'textDocument/definition' || method === 'textDocument/typeDefinition') {
    return Array.isArray(value) ? value.map(item => sourceLocation(projects, item)) : sourceLocation(projects, value);
  }
  if (method === 'textDocument/references') {
    if (!Array.isArray(value)) throw invalid('Invalid adapter references');
    return value.map(item => sourceLocation(projects, item));
  }
  if (method === 'textDocument/rename') return workspaceEdit(projects, value);
  if (method === 'textDocument/diagnostic' && Array.isArray(value?.items)) {
    return { ...value, items: value.items.map(item => !item.relatedInformation ? item : {
      ...item, relatedInformation: item.relatedInformation.map(related => ({
        ...related, location: sourceLocation(projects, related.location),
      })),
    }) };
  }
  return value;
}
