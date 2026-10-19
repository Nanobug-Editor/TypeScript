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
