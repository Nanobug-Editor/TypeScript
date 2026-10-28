/** Generated metadata must keep plugin and native archive identities independent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/** Exercise the real generator without staging or executing any native service. */
test('manifest generation preserves separate plugin and runtime versions', async () => {
  const prefix = join(tmpdir(), 'nanobug-typescript-build-');
  const root = await mkdtemp(prefix);
  const archive = Buffer.from('immutable native archive input');
  try {
    await mkdir(join(root, 'artifacts'));
    await writeFile(join(root, 'artifacts/typescript-windows-x86_64.zip'), archive);
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '9.8.7', runtimeVersion: '1.2.3' }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../build.mjs', import.meta.url))], {
      cwd: root, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, '9.8.7');
    const runtime = manifest.services.engine.installation.artifacts[0];
    assert.equal(runtime.version, '1.2.3');
    assert.equal(runtime.sha256, createHash('sha256').update(archive).digest('hex'));
  } finally {
    assert.ok(root.startsWith(prefix));
    await rm(root, { recursive: true, force: true });
  }
});
