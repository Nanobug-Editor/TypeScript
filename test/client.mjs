/** Real stdio client and isolated projects shared by public integration tests. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Create disposable disk inputs; callers retain their independent expected source strings. */
export async function project(files) {
  const root = await mkdtemp(join(tmpdir(), 'nanobug-typescript-'));
  for (const [name, source] of Object.entries(files)) {
    const file = join(root, name);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, source);
  }
  return { root, uri: name => pathToFileURL(join(root, name)).href,
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Exercise only published JSON-RPC, with no imports from the implementation. */
export class Client {
  constructor() {
    this.next = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.events = [];
    this.stderr = '';
    this.hostSources = new Map();
    this.incarnation = 0;
    this.child = spawn(process.execPath, [fileURLToPath(new URL('../native/main.mjs', import.meta.url))],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', data => { this.stderr += data; });
    this.child.stdout.on('data', data => this.receive(data));
    this.child.on('exit', code => {
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error(`Worker exited ${code}: ${this.stderr}`)); }
      this.pending.clear();
    });
  }
  /** Decode complete byte-counted frames, leaving partial UTF-8 messages untouched. */
  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const split = this.buffer.indexOf('\r\n\r\n');
      if (split < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, split).toString())[1]);
      const end = split + 4 + length;
      if (this.buffer.length < end) return;
      const message = JSON.parse(this.buffer.subarray(split + 4, end).toString());
      this.buffer = this.buffer.subarray(end);
      const item = this.pending.get(message.id);
      if (item) {
        this.pending.delete(message.id); clearTimeout(item.timer);
        if (message.error) item.reject(Object.assign(new Error(message.error.message), message.error));
        else item.resolve(message.result);
      } else this.events.push(message);
    }
  }
  /** Send notifications in the same stream as requests to preserve snapshot ordering. */
  notify(method, params) {
    const document = params?.textDocument;
    if (method === 'textDocument/didOpen') {
      this.hostSources.set(document.uri, { uri: document.uri, version: document.version,
        document: { id: `native-test-${++this.incarnation}`,
          path: relative(this.root, fileURLToPath(document.uri)).split(sep).join('/'), revision: 1 } });
    } else if (method === 'textDocument/didChange') {
      const source = this.hostSources.get(document.uri);
      if (source) this.hostSources.set(document.uri, { ...source, version: document.version,
        document: { ...source.document, revision: source.document.revision + 1 } });
    } else if (method === 'textDocument/didClose') this.hostSources.delete(document.uri);
    this.send({ jsonrpc: '2.0', method, params });
  }
  send(message) {
    const body = Buffer.from(JSON.stringify(message));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }
  /** Requests fail with a useful transport error rather than hanging a test runner. */
  request(method, params, hostSources) {
    const collaboration = method.startsWith('typescript/') && method !== 'typescript/project/documents';
    // Integration fixtures explicitly act as the trusted host that seals an invocation's caller.
    if (collaboration) {
      const { consumer = 'test-consumer', imports = [], path, ...arguments_ } = params;
      const sources = method === 'typescript/analysis/request' || path !== undefined ? hostSources ?? [...this.hostSources.values()] : undefined;
      params = { arguments: { path, payload: JSON.stringify(arguments_) },
        _nanobug: { consumer, owner: 'typescript', imports, ...(sources ? { sources } : {}) } };
    }
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}; ${this.stderr}`)); }, 20000);
      this.pending.set(id, { resolve: result => resolve(collaboration ? JSON.parse(result.payload) : result), reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async initialize(root, options = {}) {
    this.root = options.workspace ?? root;
    return this.request('initialize', { rootUri: pathToFileURL(root).href,
      capabilities: { experimental: { nanobugControl: 1 } }, initializationOptions: options });
  }
  open(uri, text, languageId = 'typescript', version = 1) {
    this.notify('textDocument/didOpen', { textDocument: { uri, text, languageId, version } });
    return this.hostSources.get(uri).document;
  }
  async close() {
    if (this.child.exitCode !== null) return;
    await this.request('shutdown', null);
    const done = new Promise(resolve => this.child.once('exit', resolve));
    this.notify('exit', null);
    await done;
  }
}
