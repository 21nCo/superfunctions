# PHASE_03 completion report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-18T06:27:49Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin arm64; shell `zsh`; Node `v20.20.0`; npm `10.8.2` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before and after the phase; pre-existing and earlier-phase work was preserved |
| Runtime definition hash | `078dfda1a8174c6ec8feb37dfb8434dcd994a8fd0a39d57ad4041b6f8ecbc526` |
| Lockfile hash | `c7c392d5f1b5da44fecf87486b7c19bdf42097a9c124a9d8541e1e49df413315` |
| Evidence | `uifn/.conduct/evidence/phase-03/2026-07-18T062749Z-PHASE-03-b56ff5be.json` |

## Phase

- Phase: `PHASE_03`
- Status: **PASS**
- Requirements delivered: `ARCH-001`, `CORE-001`, `CORE-002`, `CORE-003`, `CORE-004`
- Objective: implement one non-exported, deterministic behavior/effect runtime for portable UI semantics, prove its lifecycle and mutation invariants, and make those checks stable-blocking.

## Outcome

`@uifn/core` now has one private runtime rooted at `uifn/core/src/internal/runtime/service.ts#createRuntimeService`. The runtime has no public package export, build entry, internal declaration path, framework dependency, or DOM dependency. The packed ESM/CJS declarations contain zero `Runtime*`, `createRuntimeService`, or `internal/runtime` references.

The existing behavior paths that previously had independent mutable stores now funnel through this constructor:

- the shared primitive store;
- the legacy `StateMachine` compatibility wrapper;
- controllable state compatibility logic;
- the presence manager;
- avatar state;
- toast state and timer activity.

The catalog instrumentation test creates, interacts with, and destroys all 50 interactive-controller definitions through the same constructor. Those definitions cover all eight interactive behavior families. The 11 `static-foundation` definitions correctly need no runtime.

## Runtime invariants

1. A service has one synchronous FIFO and drains run-to-completion. Reentrant event, input, ref, and child work appends to the same queue instead of recursively interleaving.
2. Every semantic change publishes one detached, deeply frozen snapshot with monotonically increasing `version`. A state-preserving context/computed/input/child change publishes; a structural no-op is silent.
3. Snapshot data is deterministic JSON-compatible data. Cycles, functions, symbols, bigints, non-finite numbers, refs, and unsupported class instances fail with `UIFN_SNAPSHOT_NON_SERIALIZABLE`. Objects with a deterministic `toJSON()` contract are normalized to data.
4. Inputs are shallow-copied, validated, queued as patches, merged in FIFO order, and recomputed atomically. Refs stay in a private map and never enter snapshots.
5. Scope IDs and counters are per instance/root, deterministic for an SSR replay seed, unique within a scope, and isolated across concurrent roots. Duplicate claims fail with `UIFN_SCOPE_ID_COLLISION`.
6. Selectors publish only when their selected value changes. Subscriber failures are isolated and cannot stop later subscribers or the queue.
7. Service status is explicit (`running`, `stopped`, `done`, `error`, `destroyed`). Mutation after destroy fails with `UIFN_CONTROLLER_DESTROYED`; repeated destroy is a no-op.
8. All effects, activities, child services, timers, intervals, animation frames, microtasks, observers, listeners, tracked promises, and custom resources are owned and observable through resource counts.
9. Every effect/activity must return cleanup. Cleanup is once-only, reverse-owned-resource order, abort-first, and failure-isolated so one faulty cleanup cannot prevent the remaining teardown.
10. Production builds replace trace buffers with an empty implementation and compile out trace-record construction. The packed architecture scan measured `productionTracePayloads: 0`.

## Queue and effect order

For an event envelope, the order is:

1. dequeue and resolve the first passing guard;
2. run the reducer against read-only inputs/context/state/computed/snapshot;
3. normalize and freeze the proposed state/context;
4. compute derived state against the proposal;
5. determine changed keys and commit exactly once, or record a test/development no-op;
6. notify selectors in subscription order;
7. reconcile activities;
8. replace/start transition effects;
9. run eligible always transitions to stability, then continue with the next queued reentrant envelope.

Replacing an effect or activity aborts its signal, runs its returned cleanup, releases owned resources in reverse order, removes effect-owned children, and only then starts the replacement. Error, stop, done, and destroy paths release children and owned work before publishing the terminal snapshot. Recursive destroy was tested twice and leaves every runtime resource count at zero.

## Snapshot, metadata, trace, and error schemas

Published snapshots contain:

```text
version, status, state, context, computed, children[{status, version}]
```

Every semantic publication carries typed metadata:

```text
transactionId, event, action, source, reason, inputModality,
previousSnapshot, nextSnapshot, changedKeys, requestedValue, timestamp
```

Development/test trace records are sequence-numbered, bounded by the scope limit, and contain semantic identifiers rather than event values:

```text
kind, operation, definitionId, scopeId, transactionId, eventType,
eventKeys, source, reason, previousVersion, nextVersion,
changedKeys, status, code, redacted details, timestamp
```

Trace detail keys matching password/passcode/secret/token/authorization/cookie/clipboard/file/content/raw/value are redacted. Arrays, depth, and string lengths are bounded. The semantic comparator checks event, snapshot, callbacks, parts, DOM, focus, and cleanup domains independently.

The stable runtime failure inventory includes:

- architecture/privacy: `UIFN_MULTIPLE_BEHAVIOR_RUNTIME`, `UIFN_PRIVATE_RUNTIME_EXPORTED`;
- queue/snapshot: `UIFN_EVENT_ORDER_DIVERGED`, `UIFN_SNAPSHOT_CHANGE_NOT_PUBLISHED`, `UIFN_SNAPSHOT_NON_SERIALIZABLE`;
- inputs/scope/environment: `UIFN_RUNTIME_INPUT_INVALID`, `UIFN_SCOPE_ID_COLLISION`, `UIFN_ENV_CAPABILITY_MISSING`;
- effects/children: `UIFN_EFFECT_CLEANUP_MISSING`, `UIFN_STALE_EFFECT_MUTATION`, `UIFN_RUNTIME_CHILD_DUPLICATE`, `UIFN_RUNTIME_CHILD_FAILED`;
- metadata/errors/traces: `UIFN_CHANGE_META_INVALID`, `UIFN_UNSTABLE_ERROR`, `UIFN_TRACE_DIVERGED`, `UIFN_TRACE_SECRET`;
- lifecycle/events: `UIFN_RUNTIME_EVENT_INVALID`, `UIFN_RUNTIME_EVENT_CYCLE`, `UIFN_RUNTIME_NOT_RUNNING`, `UIFN_CONTROLLER_DESTROYED`.

Raw errors from reducers, guards, activities, effects, promises, and subscribers are normalized or isolated at the defined boundary. Mutation fixtures retain the exact required failure classifications.

## Requirement evidence

### `ARCH-001` — PASS

Acceptance criterion 1: every interactive primitive uses the same private service constructor.

- `service.test.ts` instruments one canonical interaction for all 50 interactive catalog definitions and observes 50 matching create/destroy callbacks from `createRuntimeService`.
- Static source analysis proves the shared store, state-machine/controllable wrapper, presence manager, avatar, and toast all funnel to the canonical constructor and contain no local state loop, subscriber registry, queue, or ambient scheduler.

Acceptance criterion 2: no alternative queue/store/transition/effect lifecycle exists.

- `verify-uifn-runtime-architecture.mjs` finds exactly one constructor definition at the canonical path and rejects seeded mutable state, listener sets, event queues, and ambient timers with `UIFN_MULTIPLE_BEHAVIOR_RUNTIME`.
- The shared store, controllable state, presence, avatar, state-machine compatibility, and toast paths were migrated rather than grandfathered.

Acceptance criterion 3: internals are absent from exports and packed declarations.

- The built package has 92 declaration files and zero internal runtime path/symbol references.
- The package export map and tsup entry list contain no internal entry; the negative export fixture produces `UIFN_PRIVATE_RUNTIME_EXPORTED`.

Vectors: `TV-ARCH-001-P` and `TV-ARCH-001-N` passed.

### `CORE-001` — PASS

Acceptance criterion 1: same-state context changes publish once and no-ops are silent.

- The queue test observes versions `1` and `2` for a same-state context change and its reentrant change; a following no-op does not publish or increment the version.

Acceptance criterion 2: reentrant work is deterministic FIFO.

- A subscriber sends a second event during the first commit. The observed sequence is count `1`/version `1`, then count `3`/version `2`, with no recursive interleaving.
- Three fixed property seeds (`0x1a2b3c4d`, `0x5eed1234`, `0x7f00aa55`) execute 750 total model steps. Failure messages retain `seed`, step index, and a one-event minimized case.

Acceptance criterion 3: snapshot mutation cannot corrupt service state.

- Prior/current snapshots remain detached and frozen; attempted context mutation throws and both snapshot versions retain their original data.

Vectors: `TV-CORE-001-P` passed; recursive-dispatch and suppressed-publication mutations classify as `UIFN_EVENT_ORDER_DIVERGED` and `UIFN_SNAPSHOT_CHANGE_NOT_PUBLISHED` for `TV-CORE-001-N`.

### `CORE-002` — PASS

Acceptance criterion 1: controlled inputs recompute atomically without recreation.

- Instrumentation observes one service creation while input changes update computed output and versions.
- Reentrant disjoint patches merge in FIFO order (`multiplier: 4`, `label: after`) and computed output reflects the combined input/context state.

Acceptance criterion 2: refs are absent from snapshots and computed values are atomic.

- An element-like ref changes `computed.hasElement` but its ID is absent from serialized snapshots.
- Invalid inputs retain the prior accepted input and fail with `UIFN_RUNTIME_INPUT_INVALID`.

Acceptance criterion 3: scopes and SSR IDs are deterministic without a singleton.

- Two root scopes generate distinct root-prefixed IDs; a replayed root/seed generates the same sequence; duplicate claims within one scope fail.
- Node execution uses no browser capability or global.

Vectors: `TV-CORE-002-P` passed; actual non-serializable snapshot and duplicate-scope fixtures plus the mutation classifier pass `TV-CORE-002-N`.

### `CORE-003` — PASS

Acceptance criterion 1: setup/cleanup order is exact across transition, update, and destroy.

- The lifecycle trace is setup A → abort/cleanup A → observer cleanup A → setup B; destroy aborts/cleans B exactly once.
- Activity input predicates, replacement, missing cleanup, and double destroy are covered.

Acceptance criterion 2: replaced asynchronous work is aborted and stale results are ignored.

- A guarded stale callback from effect A cannot mutate after effect B replaces it; only B's scheduled completion commits.
- Tracked promises become inactive on replacement/destroy and cannot call their fulfillment/rejection continuations afterward.

Acceptance criterion 3: recursive destroy releases all owned work.

- The resource sweep owns timeout, interval, frame, microtask, observer, listener, promise, activity, and child-service resources. Parent and child end destroyed; every count is zero and the manual scheduler has zero pending tasks after its inert microtask flush.
- Effect-owned children are removed before replacement and the same child key is successfully reused.
- Child error isolation and propagation policies are both tested.

Vectors: `TV-CORE-003-P` passed; missing cleanup returns `UIFN_EFFECT_CLEANUP_MISSING`, and the stale-mutation mutation is classified `UIFN_STALE_EFFECT_MUTATION` for `TV-CORE-003-N`.

### `CORE-004` — PASS

Acceptance criterion 1: metadata is complete and typed.

- The metadata test asserts event/action/source/reason/modality, transaction ID, changed keys, timestamp, and versions `0 → 1`; malformed metadata fails `UIFN_CHANGE_META_INVALID`.

Acceptance criterion 2: stable errors cover required invalid paths.

- Tests cover invalid input, undeclared event, missing environment capability, duplicate scope ID, non-serializable snapshot, missing effect cleanup, raw reducer error, and mutation after destroy.

Acceptance criterion 3: semantic traces detect all domains and redact content.

- Comparison reports divergences for event, snapshot, callbacks, parts, DOM, focus, and cleanup.
- Secret/value details are replaced before entering the bounded buffer; the negative scanner produces `UIFN_TRACE_SECRET`.
- Production ESM/CJS bundles contain zero development trace-record payloads.

Vectors: `TV-CORE-004-P` passed; unknown metadata, raw error, and secret-trace mutations produce the three exact `TV-CORE-004-N` codes.

## Measured baseline overhead

The reproducible informational command `node scripts/benchmark-uifn-core-runtime.mjs` ran 50,000 public avatar-store dispatches on Node `v20.20.0` after a 1,000-dispatch warmup:

| Measurement | Result |
| --- | ---: |
| Iterations | 50,000 |
| Elapsed | 130.609 ms |
| Mean | 2,612 ns/dispatch |

This is a PHASE_03 engineering baseline, not a release budget. Formal latency, memory, and regression budgets remain owned by `PERF-001`/`PHASE_17`.

## Controller integration points

PHASE_04 can build the uniform public controller without exporting runtime definitions or services:

1. keep `createRuntimeService`, scopes, scheduler, trace helpers, and all runtime types under `core/src/internal`;
2. have each private controller definition provide typed inputs/context/state/events/computed/refs and expose only immutable public state, actions, parts, `update`, `subscribe`, and idempotent `destroy`;
3. translate runtime `RuntimeChangeMeta` to the public controller metadata type without returning internal snapshots/services;
4. create IDs from the controller/root scope and inject non-serializable DOM refs through `setRef`;
5. express timers, callbacks, observers, and subordinate behaviors as owned activities/effects/children;
6. use the existing shared-store, presence, state-machine, avatar, and toast migrations as temporary compatibility funnels, then remove the public legacy surfaces under PHASE_04's migration inventory.

## Deliverables

### Files added

- `uifn/core/src/internal/runtime/types.ts`
- `uifn/core/src/internal/runtime/immutable.ts`
- `uifn/core/src/internal/runtime/scheduler.ts`
- `uifn/core/src/internal/runtime/scope.ts`
- `uifn/core/src/internal/runtime/trace.ts`
- `uifn/core/src/internal/runtime/service.ts`
- `uifn/core/src/internal/runtime/service.test.ts`
- `scripts/verify-uifn-runtime-architecture.mjs`
- `scripts/verify-uifn-runtime-architecture.test.mjs`
- `scripts/verify-uifn-core-node-import.mjs`
- `scripts/verify-uifn-core-node-matrix.mjs`
- `scripts/benchmark-uifn-core-runtime.mjs`
- `scripts/verify-uifn-phase-03.mjs`
- `uifn/.conduct/evidence/phase-03/2026-07-18T062749Z-PHASE-03-b56ff5be.json`
- this completion report

### Files modified

- `uifn/core/src/errors.ts` — stable runtime error-code inventory.
- `uifn/core/src/primitives/shared.ts` — shared primitive compatibility store now delegates to the private runtime.
- `uifn/core/src/primitives/avatar.ts` — removed the local state/listener implementation.
- `uifn/core/src/primitives/toast.ts` — moved state, timer, callback, and destroy lifecycle under the runtime.
- `uifn/core/src/state/machine.ts` — state-machine and controllable-state compatibility APIs now delegate to the runtime.
- `uifn/core/src/utils/presence.ts` — presence state now delegates to the runtime.
- `uifn/core/src/primitives/controller-adapters.ts` — avatar/toast controller teardown reaches the delegated runtime.
- `uifn/core/package.json` — supported Node engine is now `>=20 <25`.
- `uifn/core/tsup.config.ts` — production trace build flag is compile-time false.
- `scripts/verify-uifn-stable.mjs` — core typecheck/test/build, architecture/privacy, and Node matrix are stable-blocking.
- `package.json` — added `verify:uifn-phase-03`.
- `package-lock.json` — synchronized core engine metadata.
- `uifn/.conduct/contracts/ownership.json` — assigned the PHASE_03 gate owner and review cadence.

No files were intentionally deleted in PHASE_03. Generated `uifn/core/dist` output was used for packed privacy and Node execution checks and remains build output rather than a source deliverable.

## Verification summary

| Command | Result |
| --- | --- |
| `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` | PASS — lock metadata synchronized; unrelated optional visualizer Node warning remained non-failing |
| `npm --workspace @uifn/core run typecheck` | PASS |
| `npm --workspace @uifn/core run test` | PASS — 33 files, 123 tests |
| `npm --workspace @uifn/core run build` | PASS — ESM, CJS, and declarations |
| `node --test scripts/verify-uifn-runtime-architecture.test.mjs` | PASS — 3/3 positive/mutation tests |
| `node scripts/verify-uifn-runtime-architecture.mjs --require-dist` | PASS — one constructor, 92 declarations, 0 private leaks, 0 production trace payloads |
| `node scripts/verify-uifn-core-node-matrix.mjs` | PASS — Node `20.20.2`, `22.23.1`, `24.18.0`; DOM globals throw on read |
| `node scripts/benchmark-uifn-core-runtime.mjs` | PASS — 50,000 dispatches, 2,612 ns/dispatch informational baseline |
| `npm run verify:uifn-governance` | PASS — 10/10 checks, 78 owned surfaces; overall baseline correctly remains `FAIL` |
| `npm run verify:uifn-stable` | PASS — full 16-package stable lane, clean consumers, and tarball checks |
| `npm run verify:uifn-phase-03` | PASS — all five requirements and ten positive/negative vectors |
| `git diff --check` | PASS |

The existing Vite CJS deprecation warning remains non-failing and unrelated. The first stable attempt correctly failed because the new dependency scanner named removed framework identifiers; the scanner was narrowed to active supported dependencies, the clean-source vectors passed, and the complete stable lane was rerun successfully.

## Phase audit

- All five assigned requirements have objective evidence for every acceptance criterion.
- All ten required positive and negative vectors pass with the exact specified error classifications.
- The property suite retains fixed seeds and minimized failure-case output.
- The constructor count is exactly one and its path is private.
- Packed declarations contain no runtime symbol or internal path.
- Production bundles contain no trace-record construction.
- All resource kinds and recursive child teardown reach zero.
- Node 20, 22, and 24 execute real packed interactions with DOM globals configured to throw.
- The runtime imports no framework or DOM package.
- No TODO, FIXME, HACK, or new deferral was introduced.
- Evidence records the dirty tree honestly and is a phase audit record, not immutable release evidence.
- The project tracker remains open because PHASE_20, not PHASE_03, is the final phase.

## Notes

- Runtime modules use TypeScript exports only for private module composition and tests; none are package-public.
- Existing public legacy names remain temporarily available for compatibility. Their behavior now delegates to the runtime; PHASE_04 owns their public removal/replacement.
- Public compatibility signatures were preserved, with idempotent `destroy` added where required to make owned teardown reachable.
- User callback failures remain user-code failures at compatibility facades; runtime-owned reducer/guard/effect/activity/promise work uses stable runtime errors.
- Debug traces are available in source development/test execution and compiled out of production package builds.
- No DOM service, public controller migration, part composition, adapter work, or later primitive implementation was added.

## Ready for next phase?

**Yes.** PHASE_04 can build the uniform public controller, typed parts, and expanded environment on a deterministic, private, resource-owning runtime with stable evidence and no export leak.

## Blockers

None for PHASE_04 entry. The overall 1.0 program remains intentionally open; PHASE_04 through PHASE_20 still own public architecture, DOM, primitive, adapter, styled, docs, accessibility, security, performance, and release maturity.
