/** Verify the host's complete immutable export before loading; this is not an operating-system sandbox. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { registerHooks, isBuiltin } = require('node:module');
const { fileURLToPath } = require('node:url');

/** Canonical containment is independent of sibling prefixes and Windows drive spelling. */
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function identity(file) { return process.platform === 'win32' ? file.toLowerCase() : file; }
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

/** Reject missing, altered, linked or newly added runtime neighbors on every attachment. */
function verifyClosure(descriptor) {
  if (typeof descriptor.module_root !== 'string' || !descriptor.files || Array.isArray(descriptor.files) || typeof descriptor.files !== 'object') throw new Error('Missing sealed module closure');
  const definitions = Object.entries(descriptor.files);
  if (!definitions.length || definitions.length > 512) throw new Error('Invalid module closure size');
  if (fs.lstatSync(descriptor.module_root).isSymbolicLink()) throw new Error('Module links are forbidden');
  const root = fs.realpathSync.native(descriptor.module_root);
  const packageRoot = fs.realpathSync.native(descriptor.package_root);
  const entry = fs.realpathSync.native(descriptor.entry);
  if (!inside(packageRoot, root) || !inside(root, entry)) throw new Error('Module closure escapes package');
  const files = new Map();
  for (const [relative, hash] of definitions) {
    if (relative.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part)) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid sealed module file');
    const key = identity(path.resolve(root, relative));
    if (!inside(root, key) || files.has(key)) throw new Error('Ambiguous module closure path');
    files.set(key, hash);
  }
  if (files.get(identity(entry)) !== descriptor.sha256) throw new Error('Module entry is not sealed');
  const found = new Set();
  let bytes = 0;
  let nodes = 0;
  function walk(directory) {
    for (const name of fs.readdirSync(directory)) {
      if (++nodes > 1024) throw new Error('Module directory quota exceeded');
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Module links are forbidden');
      if (stat.isDirectory()) { walk(file); continue; }
      if (!stat.isFile()) throw new Error('Module entry is not a regular file');
      const key = identity(fs.realpathSync.native(file));
      const expected = files.get(key);
      if (!expected) throw new Error('Unlisted module neighbor');
      bytes += stat.size;
      if (bytes > 128 * 1024 * 1024) throw new Error('Module closure quota exceeded');
      if (digest(fs.readFileSync(file)) !== expected) throw new Error('Module closure digest mismatch');
      found.add(key);
    }
  }
  walk(root);
  if (found.size !== files.size) throw new Error('Module closure is incomplete');
  return { root, entry, files };
}

/** Restrict ordinary Node require/import to the approved engine and exact sealed adapter files.
 * Synchronous hooks also cover createRequire (Node's documented module.registerHooks API).
 * Native modules still have OS process rights; VM/eval or arbitrary filesystem calls are not sandboxed.
 * https://nodejs.org/api/module.html#moduleregisterhooksoptions
 */
function installLoader(closure, engineEntry) {
  // A composition is the union of independently verified immutable closures. Equal paths with
  // differing hashes are rejected, rather than allowing member order to choose executable bytes.
  const closures = Array.isArray(closure) ? closure : [closure];
  const approved = new Map();
  for (const item of closures) for (const [file, hash] of item.files) {
    if (approved.has(file) && approved.get(file) !== hash) throw new Error('Conflicting module closures');
    approved.set(file, hash);
  }
  const engineRoot = fs.realpathSync.native(path.dirname(engineEntry));
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (isBuiltin(result.url)) return result;
      if (!result.url.startsWith('file:')) throw new Error('Unapproved module protocol');
      const target = fs.realpathSync.native(fileURLToPath(result.url));
      if (!inside(engineRoot, target) && !approved.has(identity(target))) throw new Error('Module require is outside the sealed closure');
      return result;
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.startsWith('file:')) {
        const expected = approved.get(identity(fs.realpathSync.native(fileURLToPath(url))));
        if (expected && (!result.source || digest(result.source) !== expected)) throw new Error('Loaded module bytes changed');
      }
      return result;
    },
  });
}
module.exports = { verifyClosure, installLoader };
