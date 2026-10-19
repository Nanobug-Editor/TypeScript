/** Standard LSP entry point and versioned TypeScript collaboration control endpoint. */
import { serve } from './transport.mjs';
import { Projects } from './projects.mjs';
import { invalid, ProtocolError } from './errors.mjs';
import { feature, resolveCompletion } from './features.mjs';
import { analyze, controlUri } from './control.mjs';
import { related } from './related.mjs';
let projects;
let shutdown = false;
let control = false;
/** Exact readonly request range selected by this implementation; lifecycle notifications stay
 * reserved to the owning stdio host and never become callable plugin methods. */
const CONTROL_METHODS = Object.freeze([
  'typescript/adapter/attach',
  'typescript/analysis/request',
  'typescript/project/describe',
  'typescript/project/documents',
  'typescript/project/release',
  'typescript/project/resolve',
]);

/** One dispatcher owns all source synchronization before any following analysis operation. */
async function dispatch(method, params, notify) {
  if (method === 'typescript/project/documents') {
    if (!control || params?._nanobug?.native !== true || !projects || shutdown) throw new ProtocolError(-32006, 'Related documents require the negotiated native host channel');
    return related(projects, params.arguments);
  }
  if (method?.startsWith('typescript/')) {
    const metadata = params?._nanobug;
    const envelope = params?.arguments;
    if (!control || typeof metadata?.consumer !== 'string' || !metadata.consumer || metadata.consumer.length > 256 || typeof metadata?.owner !== 'string' || !metadata.owner || metadata.owner.length > 256) {
      throw new ProtocolError(-32006, 'A negotiated host control channel and consumer identity are required');
    }
    if (typeof envelope?.payload !== 'string' || Buffer.byteLength(envelope.payload) > 48 * 1024) throw invalid('Invalid control payload');
    let values;
    try { values = JSON.parse(envelope.payload); } catch { throw invalid('Invalid control JSON'); }
    if (!values || Array.isArray(values) || typeof values !== 'object' || ['consumer', '_nanobug', 'path'].some(key => key in values)) throw invalid('Reserved control metadata');
    const result = await handle(method, { ...values, path: envelope.path, consumer: metadata.consumer, _nanobug: metadata }, notify);
    const payload = JSON.stringify(result ?? null);
    if (Buffer.byteLength(payload) > 48 * 1024) throw new ProtocolError(-32000, 'Control result exceeds quota');
    return { payload };
  }
  return handle(method, params, notify);
}

/** The host wrapper never mixes authority metadata with caller-controlled request properties. */
async function handle(method, params, notify) {
  if (method === 'initialize') {
    if (projects) throw invalid('Worker already initialized');
    const offeredControl = params.capabilities?.experimental?.nanobugControl;
    // Reject unsupported offers before constructing a project or compiler. A rejected handshake
    // leaves the same owned transport available for a corrected initialization request.
    if (offeredControl !== undefined && offeredControl !== 1) {
      throw new ProtocolError(-32006, 'Unsupported native control protocol version');
    }
    projects = new Projects(params.rootUri, params.initializationOptions ?? {});
    await projects.ready;
    control = offeredControl === 1;
    return { capabilities: { positionEncoding: 'utf-16', textDocumentSync: { openClose: true, change: 2, save: true },
      completionProvider: { resolveProvider: true, triggerCharacters: ['.', '"', "'", '/', '@'] },
      hoverProvider: true, definitionProvider: true, typeDefinitionProvider: true, referencesProvider: true,
      renameProvider: { prepareProvider: true }, documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
      experimental: control ? { nanobugControl: { version: 1, methods: CONTROL_METHODS } } : {} },
      serverInfo: { name: 'Nanobug TypeScript', version: '0.1.10' } };
  }
  if (method === 'exit') { await dispose(); process.stdin.destroy(); return null; }
  if (method === 'shutdown') { shutdown = true; await dispose(); return null; }
  if (!projects || shutdown) throw new ProtocolError(-32002, 'Worker is not initialized');
  if (method?.startsWith('typescript/')) {
    // This metadata is supplied only by the owning host's authenticated control dispatcher.
    // It is not a secret or a standalone socket authentication mechanism; the stdio owner is trusted.
    if (params.path !== undefined) {
      params.uri = controlUri(projects, params, ['typescript/project/resolve', 'typescript/adapter/attach', 'typescript/analysis/request'].includes(method));
    }
  }
  switch (method) {
    case 'initialized': return null;
    case 'nanobug/controlConsumersRetired':
      if (!control) throw new ProtocolError(-32006, 'Consumer retirement requires the native host channel');
      return projects.retireConsumers(params?.consumers);
    case 'textDocument/didOpen': await projects.open(params.textDocument); return null;
    case 'textDocument/didChange': await projects.change(params.textDocument, params.contentChanges); return null;
    case 'textDocument/didClose': await projects.closeDocument(params.textDocument.uri); return null;
    case 'textDocument/didSave': return null;
    case 'completionItem/resolve': return resolveCompletion(projects, params);
    case 'typescript/project/resolve': return projects.resolve(params.uri, params.consumer);
    case 'typescript/project/describe': return projects.describe(params.context, params.consumer);
    case 'typescript/project/release': return projects.release(params.context, params.consumer);
    case 'typescript/analysis/request': return analyze(projects, params);
    case 'typescript/adapter/attach': return projects.attach(params);
    default:
      if (!method?.startsWith('textDocument/')) throw new ProtocolError(-32601, 'Unsupported protocol method');
      return feature(projects, method, params);
  }
}

/** EOF, shutdown and signal paths all await the owned TypeScript process before returning. */
async function dispose() { if (projects) await projects.close(); }
serve(process.stdin, process.stdout, dispatch, dispose);
process.on('SIGTERM', () => { void dispose().finally(() => process.exit(0)); });
process.on('SIGINT', () => { void dispose().finally(() => process.exit(0)); });
