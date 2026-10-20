/** Shared source ownership crosses the real compiler wire; directory proximity is not membership. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, project } from './client.mjs';

/** Two configured graphs intentionally give the same original file different imported types. */
test('shared sources enumerate real configured graphs and analyze an explicitly selected context', async () => {
  const shared = 'import { value } from "context-value"; export const selected = value;';
  const configuration = { compilerOptions: { strict: true, baseUrl: '.',
    paths: { 'context-value': ['./value.ts'] } }, files: ['entry.ts', '../shared.ts'] };
  const input = await project({
    'left/tsconfig.json': JSON.stringify(configuration),
    'left/entry.ts': 'import { selected } from "../shared"; export const left = selected;',
    'left/value.ts': 'export const value = "left" as const;',
    'right/tsconfig.json': JSON.stringify(configuration),
    'right/entry.ts': 'import { selected } from "../shared"; export const right = selected;',
    'right/value.ts': 'export const value = 42 as const;',
    'unrelated/tsconfig.json': '{"files":["entry.ts"]}',
    'unrelated/entry.ts': 'export const unrelated = true;',
    'shared.ts': shared,
  });
  const client = new Client();
  try {
    await client.initialize(input.root);
    client.open(input.uri('shared.ts'), shared);
    const candidates = await client.request('typescript/project/candidates', { uri: input.uri('shared.ts') });
    assert.deepEqual(candidates.map(candidate => candidate.config).sort(), ['left/tsconfig.json', 'right/tsconfig.json']);
    assert.equal(new Set(candidates.map(candidate => candidate.key)).size, 2);
    for (const candidate of candidates) assert.match(candidate.stamp, /^[a-f0-9]{64}$/,
      'registered configuration evidence remains comparable across independent native workers');
    for (const [name, expected] of [['left', /"left"/], ['right', /42/]]) {
      const candidate = candidates.find(candidate => candidate.root === name);
      assert.ok(candidate);
      const context = await client.request('typescript/project/resolve', {
        uri: input.uri('shared.ts'), project: candidate.key,
      });
      const result = await client.request('typescript/analysis/request', {
        uri: input.uri('shared.ts'), context: context.context, generation: context.generation,
        command: 'quickinfo', arguments: { line: 1, offset: shared.lastIndexOf('selected') + 1 },
      });
      assert.match(result.result.displayString, expected);
    }
    await assert.rejects(client.request('typescript/project/resolve', {
      uri: input.uri('shared.ts'), project: 'unregistered-or-foreign-project',
    }), /Unknown|retired|project/i);
    const independent = new Client();
    try {
      await independent.initialize(input.root);
      independent.open(input.uri('shared.ts'), shared);
      const restarted = await independent.request('typescript/project/candidates', { uri: input.uri('shared.ts') });
      assert.deepEqual(restarted, candidates, 'a fresh worker must not invent a new configuration identity');
      await writeFile(join(input.root, 'left/tsconfig.json'), JSON.stringify({ ...configuration,
        compilerOptions: { ...configuration.compilerOptions, noUnusedLocals: true } }));
      const changed = await independent.request('typescript/project/candidates', { uri: input.uri('shared.ts') });
      assert.notEqual(changed.find(candidate => candidate.root === 'left').stamp,
        candidates.find(candidate => candidate.root === 'left').stamp);
      assert.equal(changed.find(candidate => candidate.root === 'right').stamp,
        candidates.find(candidate => candidate.root === 'right').stamp);
    } finally { await independent.close(); }
    assert.equal(await readFile(join(input.root, 'shared.ts'), 'utf8'), shared);
  } finally { await client.close(); await input.cleanup(); }
});
