## Phase goal

Introduce a built-in KV resource and a first-class KV API that replaces Flux `KeyValueStore` ergonomics while preserving datafn signals/events.

## In scope

- Built-in KV resource exists regardless of user schema content.
- KV persistence in:
  - client storage adapters (IndexedDB + Memory)
  - server execution paths (query/mutation/sync treat KV as a normal resource)
- KV API: `get/set/merge/delete/signal` with deterministic semantics.
- Tests for KV behavior and event emission.

## Out of scope

- KV-specific sync optimizations (covered indirectly by later pull/clone work).
- Nucleus refactor to use KV API (Phase 13).

## Deliverables

- Add:
  - `datafn/client/src/kv.ts`
- Modify:
  - `datafn/client/src/client.ts` (attach `client.kv`)
  - `datafn/client/src/index.ts` (export KV API types)
  - `datafn/client/src/adapters/indexedDbStorage.ts` (create kv object store)
  - `datafn/client/src/adapters/memoryStorage.ts` (create kv store)
  - `datafn/server/src/server.ts` (ensure effective schema includes kv)
  - `datafn/server/src/validation/*` (allow kv resource for DFQL)
- Add/modify tests:
  - `datafn/client/__tests__/kv.test.ts` (new) OR extend `offline-mutate.test.ts`
  - `datafn/server/__tests__/kv.test.ts` (new) OR extend `rest.test.ts`

## Requirements covered

- KV-001
- KV-002

## Implementation tasks

- [ ] Define canonical KV record model:
  - resource name: `kv`
  - record: `{ id: "kv:<key>", value: <json> }` (+ optional system fields)
  - deterministic mapping: `kvId(key) = "kv:" + key`
- [ ] Implement `ensureBuiltinKv(schema)` utility (client + server):
  - if schema already has resource `kv`, validate it is compatible
  - else append a resource definition `{ name:"kv", version:1, fields:[{name:"value",type:"object"}], indices:[{fields:["id"]}] }`
  - ensure the same effective schema is used everywhere (tables registry, validation, adapters).
- [ ] Storage adapters:
  - IndexedDB: always create object store `kv` (keyPath `id`) with index on `id`
  - Memory: always create kv store map
- [ ] Implement KV API:
  - `get(key)` → read record `kv:<key>` and return `value` or null
  - `set(key,value)` → mutation `replace`/`merge` on resource `kv` (choose one and document; MUST be deterministic)
  - `merge(key,patch)` → reject unless existing value and patch are plain objects; shallow merge
  - `delete(key)` → mutation delete on `kv:<key>`
  - `signal(key)` → a signal scoped to a single id so it refreshes only for that id
- [ ] Event semantics:
  - KV mutations must emit standard mutation events with `resource:"kv"`, `ids:["kv:<key>"]`, `fields` = changed keys (for merge) or `["value"]` (for set)
- [ ] Tests:
  - TV-KV-001/TV-KV-001N
  - TV-KV-002/TV-KV-002N

## Verification steps

```bash
npm test -w @datafn/client && npm test -w @datafn/server
```

- Expected outcomes:
  - KV API works in local-only mode.
  - KV records round-trip through server query/mutation endpoints in tests.

## Stop condition

Before starting Phase 03, report:

- The final KV id mapping and whether `set` is implemented as `replace` or `merge`.
- Any schema augmentation rules and how conflicts with user-defined `kv` are handled.

