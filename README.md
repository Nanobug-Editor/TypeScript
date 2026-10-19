# TypeScript for Nanobug

[简体中文](README.zh-CN.md)

An independent Nanobug plugin owning TypeScript project contexts and native compiler workers. Version 0.1.10 is an implementation candidate, not a published release. The tested default engine is TypeScript 5.9.3 on Windows x86-64 with Node 24.19.0. Each nearest configured root (or inferred source directory) has its own host transport lifetime; the original workspace boundary still contains shared source snapshots.

Standard LSP provides completion and resolve, diagnostics, hover, definitions, references, cross-file rename, and formatting for JS/JSX/TS/TSX. Source synchronization uses editor snapshots; it never writes source files. Configured and inferred contexts are shared through consumer-specific opaque references. Explicit incompatible SDK selection fails instead of falling back silently. Selectable Tree-sitter providers supply syntax highlighting for all four languages; pinned sources, hashes and licenses are included under `grammar/`.

Compiler input is byte-bounded and ordered through physical pipe completion; paused engines apply backpressure to document dispatch. Failed adapter admission reports a versioned import-release receipt only after its candidate worker is gone (or before any candidate exists). Saved guest state is empty: compiler references and pending invocations are never restored as durable state.

Public collaboration contracts and exact schemas are in `contracts.json`; usage, revision rules and authority boundaries are documented beside `src/lib.rs`, `native/control.mjs` and `native/adapters.mjs`. Only a host-sealed immutable export with ABI `typescript.adapter/1`, matching engine range and complete file digests may enter an owned adapter worker. Every attachment rechecks the closure and rejects unlisted neighbors. Node module hooks restrict ordinary require/import to that closure and the selected engine; the worker disables project TypeScript plugin loading. Native adapters retain process privileges: this does not sandbox filesystem access, VM/eval or other operating-system actions.

Adapter contract 1.1 supports explicitly requested ecosystem composition. Asynchronous preparation uses `plugin.services >=1.2` OpenSet and `contribution-contract.json`; TypeScript owns every reference and loads only host-sealed exports. Exclusive slots, incompatible ABIs and ordering cycles fail explicitly. Selection/membership changes retire the affected native composition, including a previously empty set. Older single-adapter callers remain compatible; ecosystem callers require adapter >=1.1.

Build from the repository root, using a host containing the matching public SDK:

```powershell
pnpm install --frozen-lockfile --ignore-scripts
node build.mjs --stage
Compress-Archive -Path target/service/* -DestinationPath artifacts/typescript-windows-x86_64.zip -Force
node build.mjs
$hostExe = 'C:/path/to/editor-app.exe'
& $hostExe --plugin-cargo Cargo.toml build --target wasm32-wasip2 --release -j 2
& $hostExe --plugin-build .
& $hostExe --plugin-package .
```

The staging command copies the executing Node runtime and locked TypeScript distribution. Run it with Node 24.19.0; its upstream license is retained under `licenses/`. All runtime bytes are packaged with their SHA-256, so deployment needs no project-wide installation or global environment changes. The guest depends only on the host-exported SDK.

Verify with `node --test --test-concurrency=1 test/*.test.mjs`, `node node_modules/typescript/bin/tsc -p jsconfig.json`, and `cargo fmt --check`. Cross-repository Vue acceptance is explicit: set `NANOBUG_VUE_FIXTURES` to the independent Vue plugin checkout before running tests. Without it, that integration case is skipped and must not be reported as passed.

Current limits: only TS 5.9.3 is admitted. Navigation and edits are workspace-contained; external SDK/library targets return an explicit unsupported result. Configuration, extended/referenced configurations and ancestor manifest/lock changes advance generations; replacing installed dependencies without changing this evidence still requires host retirement. A different adapter for an already active project requires host configuration retirement. Consumer snapshot vectors must include relevant open dependencies. Host integration, Vue provider delegation and full lifecycle acceptance remain required before claiming production readiness.
