/** Real compiler-child failure must reach the managed stdio boundary without retiring a peer. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client, project } from './client.mjs';
const execute = promisify(execFile);

/** execFile rejects only after the bounded, forcibly terminated helper has closed and been reaped. */
async function powershell(script, input = undefined) {
  const helper = execute(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 });
  // Proof data is UTF-8 JSON on stdin, never interpolated into executable PowerShell source.
  helper.child.stdin.on('error', () => {});
  helper.child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  return (await helper).stdout;
}

/** Query only direct children of this test's known worker PID, never all Node processes. */
async function compilerChild(client, adapter = false) {
  const owner = client.child.pid;
  assert.ok(Number.isSafeInteger(owner) && owner > 0, 'owned worker has no PID');
  const fields = "Select-Object ProcessId,ParentProcessId,CommandLine,@{Name='Created';Expression={$_.CreationDate.ToUniversalTime().Ticks.ToString()}}";
  const snapshot = JSON.parse(await powershell(`$owner = Get-CimInstance Win32_Process -Filter 'ProcessId = ${owner}'; $children = @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${owner}'); @{ owner = ($owner | ${fields}); children = @($children | ${fields}) } | ConvertTo-Json -Depth 4 -Compress`));
  assert.equal(snapshot.owner.ProcessId, owner);
  assert.equal(snapshot.owner.ParentProcessId, process.pid, 'outer worker is no longer owned by this test');
  const children = snapshot.children.filter(child =>
    child.ParentProcessId === owner && /tsserver\.js/.test(child.CommandLine)
      && /engine-bootstrap\.cjs/.test(child.CommandLine) === adapter);
  assert.equal(children.length, 1, 'test must identify exactly one owned real TypeScript compiler');
  assert.ok(children[0].ProcessId !== owner && children[0].ProcessId !== process.pid);
  assert.match(children[0].Created, /^\d+$/);
  assert.match(snapshot.owner.Created, /^\d+$/);
  return { pid: children[0].ProcessId, parent: owner, root: process.pid, created: children[0].Created,
    ownerCreated: snapshot.owner.Created, command: children[0].CommandLine, target: adapter ? 'adapter' : 'compiler' };
}

/** Hold the leaf's process handle while the same bounded helper rechecks both creation identities.
 * JSON carries the exact command as data, so unusual fixture paths cannot inject a command.
 */
async function terminateOwnedChild(proof) {
  assert.equal(proof.root, process.pid);
  assert.ok(Number.isSafeInteger(proof.pid) && proof.pid > 0 && Number.isSafeInteger(proof.parent) && proof.parent > 0);
  await powershell(`
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false);
    $proof = [Console]::In.ReadToEnd() | ConvertFrom-Json;
    $victim = [System.Diagnostics.Process]::GetProcessById([int]$proof.pid);
    try {
      $null = $victim.Handle;
      $owner = @(Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$proof.parent + " AND ParentProcessId = " + [int]$proof.root));
      $leaf = @(Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$proof.pid + " AND ParentProcessId = " + [int]$proof.parent));
      if ($owner.Count -ne 1 -or $leaf.Count -ne 1) { throw 'Owned child parent changed' };
      if ($owner[0].CreationDate.ToUniversalTime().Ticks.ToString() -cne $proof.ownerCreated -or $leaf[0].CreationDate.ToUniversalTime().Ticks.ToString() -cne $proof.created) { throw 'Owned child creation changed' };
      if ($leaf[0].CommandLine -cne $proof.command -or $leaf[0].CommandLine -notmatch 'tsserver\\.js') { throw 'Owned child command changed' };
      $adapter = $leaf[0].CommandLine -match 'engine-bootstrap\\.cjs';
      if (($proof.target -ceq 'adapter' -and -not $adapter) -or ($proof.target -ceq 'compiler' -and $adapter) -or $proof.target -cnotin @('adapter','compiler')) { throw 'Owned child target changed' };
      $victim.Kill();
      if (-not $victim.WaitForExit(5000)) { throw 'Owned child did not exit' };
    } finally { $victim.Dispose() }
  `, proof);
}

/** Wait for the real outer process rather than treating a typed business error as a crash signal. */
async function retired(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  let timer;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try {
    return await Promise.race([exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('owned stdio service remained alive after its compiler exited')), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

test('unexpected inner compiler exit retires its service while a peer retains real types',
  { skip: process.platform !== 'win32' }, async t => {
    const input = await project({ 'main.ts': 'export const value = "unaffected" as const;\n' });
    const a = new Client();
    const b = new Client();
    const uri = input.uri('main.ts');
    const hover = client => client.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 15 } });
    try {
      await a.initialize(input.root);
      await b.initialize(input.root);
      a.open(uri, 'export const value = "unaffected" as const;\n');
      b.open(uri, 'export const value = "unaffected" as const;\n');
      assert.match((await hover(a)).contents.value, /"unaffected"/);
      assert.match((await hover(b)).contents.value, /"unaffected"/);
      const inner = await compilerChild(a);
      await assert.rejects(terminateOwnedChild({ ...inner, created: '0' }), /Owned child creation changed/);
      assert.match((await hover(a)).contents.value, /"unaffected"/, 'a rejected reused-PID proof must not touch the original compiler');
      t.diagnostic(`owned outer PID ${a.child.pid}; terminated inner PID ${inner.pid}; peer PID ${b.child.pid}`);
      await terminateOwnedChild(inner);
      assert.notEqual((await retired(a.child)).code, 0, 'unexpected compiler loss must retire the managed service as a failure');
      assert.match((await hover(b)).contents.value, /"unaffected"/);
      assert.equal(b.child.exitCode, null, 'healthy peer must retain its original process');
    } finally {
      await Promise.all([a.close(), b.close()]);
      await input.cleanup();
    }
  });

test('unexpected admitted adapter exit retires its service without a peer losing its compiler',
  { skip: process.platform !== 'win32' }, async t => {
    const source = 'export const value = "adapter retained" as const;\n';
    const code = '/** The real TypeScript language service performs every fixture analysis. */\nmodule.exports=()=>({create:info=>info.languageService});';
    const input = await project({ 'tsconfig.json': '{}', 'main.ts': source, 'module/index.cjs': code });
    const a = new Client();
    const b = new Client();
    const uri = input.uri('main.ts');
    const hover = client => client.request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 15 } });
    try {
      await a.initialize(input.root);
      await b.initialize(input.root);
      a.open(uri, source);
      b.open(uri, source);
      const context = await a.request('typescript/project/resolve', { uri });
      const hash = createHash('sha256').update(code).digest('hex');
      await a.request('typescript/adapter/attach', { uri, context: context.context, generation: context.generation,
        export: 'transparent', imports: [{ export_id: 'transparent', entry: join(input.root, 'module/index.cjs'),
          package_root: input.root, module_root: join(input.root, 'module'), files: { 'index.cjs': hash },
          package_digest: hash, sha256: hash, abi: 'typescript.adapter/1', engine: { typescript: '=5.9.3' } }] });
      assert.match((await hover(a)).contents.value, /"adapter retained"/);
      assert.match((await hover(b)).contents.value, /"adapter retained"/);
      const inner = await compilerChild(a, true);
      t.diagnostic(`admitted adapter outer PID ${a.child.pid}; terminated inner PID ${inner.pid}; peer PID ${b.child.pid}`);
      await terminateOwnedChild(inner);
      assert.notEqual((await retired(a.child)).code, 0);
      assert.match((await hover(b)).contents.value, /"adapter retained"/);
      assert.equal(b.child.exitCode, null);
    } finally {
      await Promise.all([a.close(), b.close()]);
      await input.cleanup();
    }
  });
