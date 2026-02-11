## Phase goal

Add mutation context propagation, context-aware event filtering, and selective + debounced signal invalidation to match Nucleus subscription semantics without Flux.

## In scope

- DFQL mutation `context` support and propagation.
- Event payload completeness (`mutation_applied` / `mutation_rejected`).
- Event filter: `contextKeys` and shallow `context` equality matching.
- Signal invalidation:
  - footprint derivation (resource + referenced relations in select tokens)
  - selective refresh
  - batching/debouncing
- Unit tests validating filtering and invalidation behavior.

## Out of scope

- KV support (Phase 02).
- Relation offline apply and join sync (Phases 03–05).
- Clone/pull cursor protocol changes (Phases 05–06).

## Deliverables

- Modify:
  - `datafn/core/src/types.ts` (event + filter typings, context typing)
  - `datafn/client/src/events/filter.ts` (matching logic)
  - `datafn/client/src/mutate.ts` (context propagation, event emission correctness)
  - `datafn/client/src/signals/querySignal.ts` (invalidation engine)
  - `datafn/client/src/signals/registry.ts` (if needed for footprint registry)
- Add/modify tests:
  - `datafn/client/__tests__/events.test.ts`
  - `datafn/client/__tests__/subscribe.test.ts`
  - `datafn/client/__tests__/signals.test.ts`

## Requirements covered

- API-002
- EVT-001
- EVT-002
- SIG-001
- SIG-002

## Implementation tasks

- [ ] Update DFQL mutation types:
  - add `context?: Record<string, unknown>`
  - validate context JSON-serializability deterministically (reject functions/symbols/bigints/cycles).
- [ ] Ensure event emission uses the normalized/enriched mutation:
  - `mutationId`, `clientId`, and `context` MUST be present in events when available.
  - Derive `action` = operation.
  - Derive `fields` = sorted keys from `record` excluding `id`.
- [ ] Implement event filter context matching:
  - `contextKeys`: require keys exist on event.context
  - `context`: require shallow equality for each key/value pair
  - deterministic behavior when event.context is missing (always non-match)
- [ ] Implement signal footprint derivation:
  - footprint includes primary resource
  - parse select tokens for relation base segments and map to schema relation targets
  - include join-store keys for many-many expansions
- [ ] Implement selective invalidation:
  - refresh signals only if event affects any footprint member
  - include join events (join-store mutations) as affecting relation expansions
- [ ] Implement batching/debouncing:
  - coalesce refreshes per signal within a window (default: microtask or 16ms; choose and document)
  - ensure “event during in-flight fetch” queues exactly one follow-up refresh
- [ ] Add tests:
  - context propagation into events
  - context filtering positive/negative
  - signals refresh only for related events
  - debounce/batching correctness

## Verification steps

```bash
npm test -w @datafn/client
```

- Expected outcomes:
  - New tests cover TV-CTX-001/TV-CTX-001N, TV-EVT-002/TV-EVT-002N, TV-SIG-001/TV-SIG-001N, TV-SIG-002/TV-SIG-002N.

## Stop condition

Before starting Phase 02, report:

- The exact footprint derivation rules implemented.
- The chosen debounce window and its determinism properties.
- Any changes required in `@datafn/svelte` or Nucleus consumption patterns due to context typing.

