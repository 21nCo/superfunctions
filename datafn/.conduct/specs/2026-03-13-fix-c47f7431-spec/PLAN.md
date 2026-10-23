# Implementation Plan

## Architecture sketch
Modules and responsibilities:
1. `datafn/core`
- Owns canonical SearchProvider contract surface used by client/server.

2. `datafn/client`
- Owns `client.search()` request validation, source routing, and option forwarding.
- Owns local mutation index lifecycle calls to `searchProvider.updateIndices()`.
- Owns plugin bridging behavior (`clientSearch` provider-delegation mode).

3. `datafn/server`
- Owns request/query validation for search options.
- Owns per-resource and cross-resource option forwarding to provider/native fallback paths.

4. `datafn/examples/todo-app/*`
- Demonstrates production-relevant local (IndexedDB) and server (Elasticsearch/OpenSearch) option parity.

5. `datafn/docs`
- Documents canonical search envelopes, local-first semantics, and plugin deprecation behavior.

## Dependency graph
1. Contract changes (`core` + server mirror types) must land before forwarding code updates.
2. Client validation/forwarding and server forwarding can proceed in parallel after contract updates.
3. Client mutation lifecycle updates depend on stable provider contract and existing mutation path instrumentation.
4. Plugin unification depends on provider contract and client routing semantics.
5. Example/docs updates depend on finalized runtime semantics.
6. Regression tests gate all phases and must run last with complete updated behavior.

## Phases overview
- Phase 00 -> Goal: Lock intent and canonical envelopes.
Delivered capability: frozen contract and routing semantics for implementation.
Verification method: spec checklist and intent-audit cross-map complete.

- Phase 01 -> Goal: Contract propagation.
Delivered capability: SearchProvider + server transport/query type parity for `prefix/fuzzy/fieldBoosts`.
Verification method: typecheck for affected packages.

- Phase 02 -> Goal: Client search boundary fix.
Delivered capability: client validation, local-first default, `source` override, and option forwarding.
Verification method: client search tests + local/remote path assertions.

- Phase 03 -> Goal: Client index lifecycle completion.
Delivered capability: mutation-triggered `updateIndices` wiring with fail-soft behavior.
Verification method: mutation tests for insert/merge/delete/debounce and failure handling.

- Phase 04 -> Goal: Server boundary fix.
Delivered capability: query/search route parsing + execution forwarding across per-resource and cross-resource search.
Verification method: server execution + route tests for forwarding and validation errors.

- Phase 05 -> Goal: Client search unification.
Delivered capability: provider-delegation mode in `clientSearch` plugin and explicit legacy-mode deprecation behavior.
Verification method: plugin tests for provider path and legacy compatibility mode.

- Phase 06 -> Goal: Example app parity.
Delivered capability: todo app client/server search configured and demonstrated with parity options + local-first behavior.
Verification method: example smoke run and manual search scenario checks.

- Phase 07 -> Goal: Docs + release gate.
Delivered capability: updated docs and full regression pass across touched packages.
Verification method: targeted tests, typechecks, and docs consistency checks.

## Definition of Done (global)
No phase is complete unless its verification steps pass and all referenced requirement IDs are satisfied.
