# Candidate source ledger

- `0.1.1`: S1 candidate already packaged by the coordinator. Its ZIP remains unchanged.
- `0.1.2`: S4 source candidate adds explicit `plugin.services >=1.2` collection discovery,
  immutable multi-module worker composition and the optional `language.contribution` contract.
  `typescript.adapter` advances to 1.1.0; consumers requiring ecosystem discovery require >=1.1,<2
  so a previous engine cannot silently ignore the new `extensionAbi` payload selector.
  The TS guest owns all discovered references; no resource handle is transferred between plugins.
  Native composition has a real TypeScript/LSP regression. Package/Manager ecosystem integration,
  mapped Vue contributions and selection/revocation validation remain pending; this is not a release.

The coordinator rebuilds the host SDK and the full service archive before producing the new ZIP.
Changing the source version alone does not update or validate an existing artifact.

- `0.1.3`: preserves the frozen 0.1.2 ZIP and includes the coordinator's verified completion fix:
  a valid auto-import candidate beyond the first 256 compiler completions is no longer discarded.
  Native protocol errors also retain explicit host-issued/digest descriptions for invalid module
  input. Public adapter contract stays 1.1.0; this is a package candidate increment, not a new API.

- `0.1.4`: preserves the frozen 0.1.3 ZIP and packages pinned JavaScript, JSX, TypeScript and TSX
  Tree-sitter grammars and queries. The language worker is unchanged except its reported version.
  Grammar provenance and licenses travel with the package; native loader/capture validation is
  recorded separately from semantic worker validation.

- `0.1.5`: preserves 0.1.4 and includes the coordinator's verified Windows canonical-path fix.
  Project discovery uses the native realpath implementation so host-issued verbatim drive paths
  initialize and retain workspace/symlink checks. The public LSP regression exercises initialize,
  nested project resolution and actual hover; composition contracts are unchanged.

- `0.1.6`: extends native Windows canonicalization to host-issued immutable module paths and loader
  checks. A real stdio attach/hover/unsealed-neighbor regression failed with EISDIR on 0.1.5 source
  and passes with native realpath calls. The frozen 0.1.5 artifact remains available for evidence.

- `0.1.7`: binds workspace-path controls to host-sealed original URIs and exact source versions,
  preserving lowercase Windows drive spelling through definitions, references and rename proposals.
  Duplicate open identities for one canonical file are rejected. Public stdio regressions cover
  stale source vectors and real TS results; no source version is inferred from a filesystem path.

- `0.1.8`: applies the same source identity rules to standard LSP proposals returned by any adapter.
  Locations keep the exact native open URI, and text-only workspace edits carry its actual wire
  version. Stale versions, duplicate targets, resource operations, annotations and outside-workspace
  paths fail as a whole. Actual Vue CSS and independent invalid-proposal worker tests pass; all 35
  native integration tests pass against the frozen Vue 0.1.8 modules. Host lifecycle acceptance
  remains separate; the frozen TypeScript 0.1.7 candidate is retained for that investigation.

- `0.1.9`: acknowledges the exact native control version/method set during initialize. Unsupported
  offers fail before compiler creation; ordinary LSP remains available without custom control.
  Public framing, cancellation, business-error and payload/result quota regressions are retained.
- `0.1.10`: returns the declared empty snapshot at shutdown, waits for bounded compiler stdin
  writes before releasing document dispatch, and emits a strict import-release failure receipt
  after candidate cleanup. Real paused-SDK transport and throwing-factory regressions first failed
  on the previous source. These transport fixtures do not replace real TypeScript/Vue semantics.
- `0.1.11`: enumerates real configured graph memberships and routes the public native primary
  through a fixed interactive preparation contract. The compiler bootstrap remains an internal
  provider; opaque registered contexts retain exact owner/scope/configuration seals. Native project
  choice, source navigation hints and workspace-local CAS preferences share one facade. A compiler
  fingerprint catalog separates host generations from worker-local counters; inferred identities
  include their canonical root. Source tests cover opposite types for one shared source, independent
  worker restart and configuration changes; actual package/host choice acceptance is recorded by
  the host coordinator separately. This frozen candidate's prefixed SHA-256 name exceeded the
  public 64-byte key limit; real native project choice failed before QuickPick. Requires
  `language.lsp >=1.6` and `workspace.files >=1.4`.
- `0.1.12`: fixes that guest preference key to full lowercase SHA-256 hex over the fixed domain
  `typescript.project.v1`, a NUL byte, then the exact host-issued portable source path in UTF-8.
  The encoding keeps all digest bits within the existing 64-byte contract, with no case folding
  or Unicode normalization. Golden keys and public `PreferenceKey::validate` reproduce the old
  failure and pass after the fix. Native worker/archive bytes remain the verified 0.1.11 closure;
  real native chooser, reopen, F12 and retained-preference acceptance remain separate host gates.

- `0.1.13`: retires the owning stdio service when a fully initialized compiler or admitted adapter
  suffers an unexpected child/pipe failure. Pending requests fail without replay; normal host recovery
  can rebuild the process-local adapters. Provisional admission failure and explicit close remain
  recoverable request/lifecycle paths. Disposal also owns in-flight candidate children. Real stdio
  tests killed only an owned compiler/adapter leaf, observed failed outer exit and retained a peer's
  concrete types; the compiler case reproduced the previous permanently-live outer service first.
  The native archive is rebuilt and versioned separately from the unchanged public contracts.
  The rebuilt native closure passes 47 source and 47 sealed tool tests with no skips. Actual
  installed Vue adapter-child recovery remains a separate host gate; tool success does not replace it.

- `0.1.14`: loads the primary adapter and every contribution through the native canonical entry
  returned by its own verified closure. A real public stdio attachment with host-style Windows paths
  reproduced `Adapter failed to load`; a bounded bootstrap probe isolated Node CJS `EISDIR lstat C:`.
  The prior primary-only normalization missed contribution entries. Existing ownership, complete
  file digests, module hooks and neighbor rejection remain enforced. The regression includes an
  extended-drive contribution path longer than 260 characters and proves actual compiler types.
  A live UNC share was unavailable, so no network-share execution claim is made. Frozen .13 inputs
  remain evidence. The rebuilt closure passes 48 source and 48 sealed tool tests with no skips;
  installed package verification remains a separate host gate.

- `0.1.15`: functional support for the declared Windows x86-64 / TS 5.9.3 / Node 24.19.0
  combinations, with exactly Vue 2.6.14, 2.7.16 and 3.5.22 through the independent Vue plugin's
  26 applicable writing combinations and pinned dependencies. Plugin and native
  artifact versions are separate: all native service 0.1.14 bytes and its archive SHA-256 remain
  unchanged, including serverInfo 0.1.14. The public contracts, permissions and fixed toolchain
  remain identical. Retained host runs passed S4 conflict recovery (280.28s), S5 outer recovery/update
  (164.27s), Worker revocation/live update (67.94s/67.84s), and candidate mixed-version warm-cache
  S1 (97.62s). Ordinary Windows desktop language/edit, real Chinese IME, theme and explicit hover
  reopening evidence is recorded in Editor/docs/plugins/verification/vue-typescript-desktop-2026-10-20.md.
  The existing AccessKit invalid-HWND/COM window-teardown abort remains a recorded upstream limit.
  Earlier failed candidates remain historical evidence. Exact archive identities and final policy/pair
  results belong to the external host delivery receipt; this label does not certify a ZIP run or Release.
