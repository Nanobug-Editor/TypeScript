/** Standard LSP feature conversion hides tsserver coordinates and never applies edits itself. */
import { location, offset, range, endPosition } from './coordinates.mjs';
import { invalid, ProtocolError } from './errors.mjs';
import { adapterResult } from './adapter-results.mjs';

/** An exact open source is required for every analysis; disk is only used by TS for unopened dependencies. */
export async function feature(projects, method, params) {
  const document = projects.document(params.textDocument.uri);
  const file = document.file;
  const at = params.position ? (offset(document.text, params.position), location(params.position)) : {};
  const project = await projects.project(document.uri);
  const engine = projects.adapters.get(project.project)?.engine ?? projects.engine;
  // An immutable adapter may contribute source-level features using its own readonly protocol.
  // It receives the host-admitted filename and inert request data, never a new source snapshot.
  const adapterMethod = engine.features.get(method);
  if (adapterMethod) {
    const result = await engine.request(adapterMethod, [file, JSON.stringify(params)]);
    // tsserver treats a null body as a failed request, so adapters may return this inert marker.
    // Only this exact single-field envelope delegates to TS; [] remains an explicitly handled result.
    const fallback = result?.$nanobug === 'fallback' && Object.keys(result).length === 1;
    if (result != null && !fallback) return adapterResult(projects, method, result);
  }
  const query = (command, args = {}) => engine.request(command, { file,
    ...(project.config ? { projectFileName: project.config } : {}), ...at, ...args });
  switch (method) {
    case 'textDocument/diagnostic': {
      const syntax = await query('syntacticDiagnosticsSync');
      const semantic = await query('semanticDiagnosticsSync');
      return { kind: 'full', resultId: String(document.version), items: [...syntax, ...semantic].filter(item => item.start && item.end).map(item => ({
        range: range(item), severity: item.category === 'error' ? 1 : item.category === 'warning' ? 2 : 3,
        code: item.code, source: 'TypeScript', message: diagnosticText(item.text),
      })) };
    }
    case 'textDocument/hover': {
      const result = await query('quickinfo');
      return result ? { contents: { kind: 'plaintext', value: [result.displayString, display(result.documentation)].filter(Boolean).join('\n\n') }, range: range(result) } : null;
    }
    case 'textDocument/definition':
    case 'textDocument/typeDefinition': {
      const result = await query(method.endsWith('/definition') ? 'definition' : 'typeDefinition');
      return (result ?? []).map(item => ({ uri: checkedUri(projects, item.file), range: range(item) }));
    }
    case 'textDocument/references': {
      const result = await query('references');
      return (result?.refs ?? []).filter(item => params.context?.includeDeclaration || !item.isDefinition)
        .map(item => ({ uri: checkedUri(projects, item.file), range: range(item) }));
    }
    case 'textDocument/prepareRename': {
      const result = await query('rename', { findInStrings: false, findInComments: false });
      if (!result.info.canRename) return null;
      return { range: range(result.info.triggerSpan), placeholder: result.info.displayName };
    }
    case 'textDocument/rename': {
      if (typeof params.newName !== 'string' || !params.newName.length || params.newName.length > 1024) throw invalid('Invalid rename identifier');
      const result = await query('rename', { findInStrings: false, findInComments: false });
      if (!result.info.canRename) throw invalid(result.info.localizedErrorMessage ?? 'Symbol cannot be renamed');
      return { documentChanges: result.locs.map(group => {
        const uri = checkedUri(projects, group.file);
        return { textDocument: { uri, version: projects.documents.get(uri)?.version ?? null },
          edits: group.locs.map(item => ({ range: range(item), newText: `${item.prefixText ?? ''}${params.newName}${item.suffixText ?? ''}` })) };
      }) };
    }
    case 'textDocument/formatting':
    case 'textDocument/rangeFormatting': {
      const options = formatOptions(params.options);
      const selected = method === 'textDocument/rangeFormatting' ? params.range
        : { start: { line: 0, character: 0 }, end: endPosition(document.text) };
      if (!selected || offset(document.text, selected.end) < offset(document.text, selected.start)) throw invalid('Invalid formatting range');
      const result = await query('format', { ...location(selected.start), endLine: selected.end.line + 1,
        endOffset: selected.end.character + 1, options });
      return (result ?? []).map(item => ({ range: range(item), newText: item.newText }));
    }
    case 'textDocument/completion': {
      const result = await query('completionInfo', { includeExternalModuleExports: true, includeInsertTextCompletions: true });
      // Prefix ranking happens in the editor after this reply. Cutting the compiler's global
      // list first permanently hides later project exports, even when the user types their name.
      // The owned transport enforces its byte budget and fails explicitly instead of dropping names.
      return { isIncomplete: !!result?.isIncomplete,
        items: (result?.entries ?? []).map(item => ({ label: item.name, kind: completionKind(item.kind),
          sortText: item.sortText, insertText: item.insertText ?? item.name,
          ...(item.replacementSpan ? { textEdit: { range: range(item.replacementSpan), newText: item.insertText ?? item.name } } : {}),
          data: { uri: document.uri, version: document.version, context: project.key,
            generation: project.generation, position: params.position, name: item.name, source: item.source, data: item.data },
        })) };
    }
    default: throw new ProtocolError(-32601, 'Unsupported language feature');
  }
}

/** Public resolver preserves auto-import edits and refuses details from another source revision. */
export async function resolveCompletion(projects, item) {
  const data = item.data;
  const document = projects.document(data?.uri);
  if (document.version !== data.version) throw new ProtocolError(-32801, 'Completion source changed');
  const project = await projects.project(document.uri);
  if (data.context !== project.key || data.generation !== project.generation) throw new ProtocolError(-32801, 'Completion project context changed');
  offset(document.text, data.position);
  const details = await (await projects.engineFor(document.uri)).request('completionEntryDetails', { file: document.file, ...location(data.position),
    ...(project.config ? { projectFileName: project.config } : {}),
    entryNames: [{ name: data.name, source: data.source, data: data.data }] });
  const detail = details?.[0];
  if (!detail) return item;
  const edits = [];
  for (const action of detail.codeActions ?? []) for (const change of action.changes) {
    if (checkedUri(projects, change.fileName) !== document.uri) throw new ProtocolError(-32005, 'Completion requires edits in another document');
    for (const edit of change.textChanges) edits.push({ range: range(edit), newText: edit.newText });
  }
  return { ...item, detail: display(detail.displayParts), documentation: { kind: 'plaintext', value: display(detail.documentation) }, additionalTextEdits: edits };
}

function display(value) { return typeof value === 'string' ? value : (value ?? []).map(item => item.text).join(''); }
function diagnosticText(value) { return typeof value === 'string' ? value : value?.messageText ?? 'TypeScript diagnostic'; }
function checkedUri(projects, file) { return projects.uriForFile(file); }
function completionKind(kind) { return ({ method: 2, function: 3, class: 7, interface: 8, property: 10, const: 21, keyword: 14, module: 9 })[kind] ?? 6; }
function formatOptions(options) {
  if (!Number.isInteger(options?.tabSize) || options.tabSize < 1 || options.tabSize > 16) throw invalid('Invalid formatting tab size');
  return { tabSize: options.tabSize, indentSize: options.tabSize, convertTabsToSpaces: !!options.insertSpaces,
    insertSpaceAfterCommaDelimiter: true, insertSpaceAfterSemicolonInForStatements: true,
    insertSpaceBeforeAndAfterBinaryOperators: true, insertSpaceAfterKeywordsInControlFlowStatements: true,
    insertSpaceAfterOpeningAndBeforeClosingNonemptyBraces: true, newLineCharacter: '\n' };
}
