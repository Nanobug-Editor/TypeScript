/** The selected TS parser discovers configuration dependencies; hashes seal their observed contents. */
import { createRequire } from 'node:module';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ProtocolError } from './errors.mjs';
const require = createRequire(import.meta.url);

export class Configurations {
  /** Parsing uses compiler public APIs only; this module creates no independent language service. */
  constructor(engineEntry, workspace) {
    this.ts = require(join(dirname(engineEntry), 'typescript.js'));
    this.workspace = workspace;
    this.cache = new Map();
  }
  /** Any prior input change reparses extends/references before publishing the next generation. */
  stamp(config) {
    if (!config) return '';
    const previous = this.cache.get(config);
    if (previous && fingerprint(previous.inputs) === previous.stamp) return previous.stamp;
    const inputs = new Set([config]);
    const visited = new Set();
    const parse = path => {
      if (visited.has(path)) return;
      if (visited.size >= 32) throw new ProtocolError(-32000, 'Project configuration reference quota exceeded');
      visited.add(path); inputs.add(path);
      if (!existsSync(path)) return;
      const host = { ...this.ts.sys, onUnRecoverableConfigFileDiagnostic() {}, readFile: file => {
        inputs.add(file); return this.ts.sys.readFile(file);
      } };
      const result = this.ts.getParsedCommandLineOfConfigFile(path, {}, host);
      for (const reference of result?.projectReferences ?? []) {
        parse(reference.path.endsWith('.json') ? reference.path : join(reference.path, 'tsconfig.json'));
      }
    };
    parse(config);
    // Absence is itself evidence: creating or deleting a manifest/lockfile invalidates the seal.
    let directory = dirname(config);
    for (;;) {
      for (const name of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']) inputs.add(join(directory, name));
      const rel = relative(this.workspace, directory);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || dirname(directory) === directory) break;
      directory = dirname(directory);
    }
    const stamp = fingerprint(inputs);
    this.cache.set(config, { inputs, stamp });
    return stamp;
  }
}

/** Input ordering is stable; missing files differ from empty files and retain their path identity. */
function fingerprint(inputs) {
  const hash = createHash('sha256');
  for (const file of [...inputs].sort()) {
    hash.update(file); hash.update('\0');
    try { hash.update('present\0'); hash.update(readFileSync(file)); } catch { hash.update('missing'); }
    hash.update('\0');
  }
  return hash.digest('hex');
}
