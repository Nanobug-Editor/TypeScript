# Unknown ecosystem Package fixture

This independent test plugin contributes semantics through `language.contribution 1.0` and
`vue.language-plugin/1`. It has no host-specific registration. Version **0.1.2** is the current candidate;
the same-ID without-style replacement uses **0.1.3**. Prior `.0` / `.1` packages and their actual
results remain historical inputs. Current SDK rebuilding and native editor acceptance are required.

The component replies to Snapshot with schema 1 / `{}`. Configuration belongs to the admitted Package,
not a saved resource handle. `prepare` reads only its own `contributions.json`, with both
`package.assets` capability negotiation and `assets.read` permission;
it never reads project source, installs tools, starts a process or returns a module path. Metadata uses
the existing public contribution contract unchanged. Input declarations are bounded to 8 KiB / fifteen
members and replies use typed failures. Unknown extension ABIs return no contributions.

## Parameters and actual effects

`scenarios.json` contains the declarations selected for `contributions.json`. IDs, slots,
`compose`/`exclusive`, before/after edges and config are ordinary composition data. The four role exports
and the `check` types alias use independent roots containing identical complete factory bytes. Every import acquires its own
host authorization. The config's `role` must match its declaration and export.

| Scenario | Observable behavior |
| --- | --- |
| `types` (default) | Adds a real TS string constraint to the first `42` in a setup or ordinary script; numeric input produces TS 2345 at that exact source token. `expectedType:"number"` accepts it |
| `template` | Compiles HTML-shaped `lang="quill"` through the locked Vue DOM compiler; `count.toUpperCase()` for numeric `count` produces TS 2339. Definition and rename return original SFC locations |
| `style` | Exposes the exact `shade.toUpperCase()` expression in `lang="ink"` as a source-backed binding; numeric `shade` produces TS 2339, with original definition/rename locations |
| `project` | Contributes the boolean `checkUnknownComponents` setting; `enabled:true` reports `<AbsentThing />`, without editing tsconfig |
| `combined` | All four roles coexist; template explicitly follows the type contribution |
| `without-style` | Retains type/template/project effects while Ink reports its missing dedicated style role |
| `empty` | An installed member deliberately declines contribution; its collection lifetime must still be observed |
| `exclusive-conflict` | Two template declarations compete for one exclusive slot; reject the complete candidate |
| `ordering-cycle` | Two otherwise compatible types declarations form a cycle; reject explicitly |
| `configuration-conflict` | Project contributions disagree on the same boolean option; reject the complete candidate |
| `invalid-mapping` | Intentionally emits an out-of-bounds types segment; Vue must reject it before exposing navigation/edits |
| `invalid-project-config` | Supplies a string instead of the allowed project boolean; factory rejection must remain visible |

`invalid-mapping` uses an identity distinct from the healthy types member. It can therefore be installed
alongside `combined` to reach the actual mapping check rather than fail earlier on a duplicate ID.

One combined source makes the four independent effects visible:

```vue
<script setup lang="ts">
const eco = 42;
const count = 42;
const shade = 42;
</script>
<template lang="quill"><p>{{count.toUpperCase()}}</p><AbsentThing /></template>
<style lang="ink">shade.toUpperCase()</style>
```

For Vue 2.6's ordinary Options API, the type-role sample is:

```vue
<script lang="ts">
import Vue from "vue";
export default Vue.extend({data(){return {eco:42}}});
</script>
<template>{{eco}}</template>
```

The setup sample must not be used to claim that Vue 2.6 supports script setup.

## Prepare and build with the public SDK

From this directory, select a scenario and optionally use a new unknown ID or Package version:

```powershell
node build.mjs --scenario combined --id unfamiliar-combined --version 0.1.2
& $NanobugExe --plugin-package . --output C:/path/to/new-fixture-output
```

`build.mjs` updates only the fixture's generated manifest and inert declaration asset. It hashes the
actual factory bytes; no SDK copy is added. Use the current host's `--plugin-cargo`/`--plugin-package`
entry points, lock its SDK identity and keep each output/hash. Build different scenarios serially and
restore the default source inputs with `node build.mjs` after collecting the variants. To test an
update of the same ID, explicitly increment the Package version and retain the earlier ZIP.

The actual native four-role run on 2026-10-20 rejected `.1` before any role semantics with
`CapabilityUnavailable: package.assets was not negotiated` (119.04 seconds). The guest reads its
declaration asset, so permission alone is insufficient. `.2` declares this public capability;
no host admission or service authority check was weakened. The new packages must pass that same
native test before this correction is counted as accepted.

## Directed semantic checks

From the TypeScript repository:

```powershell
$env:NANOBUG_VUE_FIXTURES = 'C:/path/to/Vue-for-Nanobug'
node --test --test-concurrency=1 test/fixtures/ecosystem/ecosystem.test.mjs
```

These tests run the actual fixture factory through the TS-owned stdio service and the immutable Vue
adapters. The test client supplies host seals; it does not prove WASM service discovery or Package
authority. Every case checks the original SFC and tsconfig stay unchanged. Template/style cases also
check exact definition/rename coordinates. Invalid candidates are followed by a valid composition on
the same connection. The Vue 2.6 type case uses the legacy backend and real Vue 2.6 dependency fixture;
the other cases currently use the modern backend.

REDs were observed for the ignored type requirement, missing template/style semantics, incorrect
project role, accepted invalid mapping and the setup-only type hook. Each minimal factory change was
followed by its directed GREEN. Two initial test expectations were corrected independently: template
`count` begins at character 28, and the Vue 2.6 numeric token begins at character 46. The first combined
assertion also included the separate `AbsentThing` diagnostic's 2339; it now selects `toUpperCase`
diagnostics explicitly. Earlier failures are not counted as full-suite passes.

On 2026-10-19, Node 24.19.0 ran the complete directed suite: **11 passed, 0 failed, 0 skipped**,
18.52 seconds. The 15 TS native service files were hashed before and after; none changed during that
run. Snapshot/Package execution remains pending and is not included in this count.

The first actual `.1` build through the public `--plugin-package` entry on 2026-10-19 compiled the
guest successfully (14.17 seconds, SDK `9187`) but Package admission rejected its five aliases with
`Module export roots must not overlap`. This was a fixture layout defect. `build.mjs` now writes the
same complete factory bytes into independent `modules/{types,template,style,project,check}` roots,
hashing those bytes for every closure. The existing host root-isolation check is unchanged; the
same public Package build then passed with SDK `9187f5a734591977dc2f6bce15402d3bae6a99a26d63eebd41dcc2d1ba4a38b1`
(0.10 seconds Cargo fresh; exit 0). The actual fixture workspace root and host-managed Cargo target
were checked with `cargo metadata --locked --no-deps --format-version 1` and the exported SDK config.
This establishes Package admission, not Manager lifecycle or native role semantics; the final SDK
rebuild and those checks remain separate requirements.

## Package and native acceptance still required

- First reproduce the old `.0` missing-Snapshot failure through the public Manager, then check `.1`
  Snapshot/disable/re-enable/checked-shutdown with the current SDK. No Cargo or WASM execution is
  claimed by the Node suite.
- Install independently built types/template/style/project/combined variants through Package and the
  production Worker. Observe real mapped diagnostics, navigation and edits; use a separate explicit
  output directory for each candidate.
- Exercise two unknown IDs, selection versus composition, empty-to-member transitions, replacement,
  uninstall, original A/B caller exits and multi-hop cancellation. Check old requests/mappings/references
  fail and actual process/lease counts reach zero while healthy consumers survive.
- Combine transformed-source rename with S2's preview/cancel/conflict/Undo transactions and stale-source
  rejection. Node rename proposals alone are not an editor transaction acceptance result.
- Perform Windows native observation and final S4/S6 gates. Quill/Ink are fixture syntax; they do not
  establish support for production Pug, Stylus or Nuxt plugins.
