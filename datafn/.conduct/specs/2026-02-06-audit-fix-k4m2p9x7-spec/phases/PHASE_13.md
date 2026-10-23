## Phase goal

Refactor Nucleus to remove Flux entirely and use datafn directly for reactivity, subscriptions, sync/offline, and KV state (no intermediate abstractions).

## In scope

- Replace Flux usage in Nucleus client with:
  - `createDatafnClient` initialization
  - direct `table.query/mutate/signal/subscribe` usage
  - `@datafn/svelte` adapters (`toSvelteStore`) and small helper utilities
- Replace window-level mutation event listeners with datafn subscriptions and/or signals.
- Replace Flux KeyValueStore usage with `client.kv`.
- Update Nucleus sync integration to use datafn sync engine and endpoints.

## Out of scope

- Maintaining any Flux compatibility APIs.

## Deliverables

- Nucleus (examples of expected touched areas; exact list is discovered during implementation but MUST be tracked):
  - Remove/stop using `client/components/flux/**` in application runtime paths
  - Update reactive layers:
    - `client/layout/layers/ComponentBaseLayer.svelte` (replace GlobalEvent.MUTATION)
  - Replace ResourceStore-like patterns:
    - migrate per-resource access to `datafn.table("resource")` usage
    - move UI-only “active editing state” into Svelte local stores (not datafn)
  - Replace KV:
    - `client/components/flux/resourceStores/kv.store.ts` → `client.kv`
- Datafn integration glue in Nucleus:
  - Add `client/data/datafn.ts` (or similar) that constructs the datafn client with schema + storage + sync config
  - Add Nucleus-local utility functions for common operations (archive/trash/lock/etc) implemented as small functions calling `mutate`

## Requirements covered

- DX-001
- NUC-001
- NUC-002
- NUC-003
- NUC-004

## Implementation tasks

- [ ] Introduce a single authoritative datafn client instance in Nucleus:
  - configure `clientId`
  - configure IndexedDB storage adapter
  - configure `sync.remote` (web) OR `sync.remoteAdapter` (extension)
  - configure hydration plan (`bootResources` etc) for Nucleus
- [ ] Replace Flux global mutation event usage:
  - remove `window` custom event dispatch/listening patterns
  - replace with datafn `subscribe()` filters and/or direct signals
  - implement the Nucleus equivalent of:
    - filtering by resource
    - filtering by specific ids
    - filtering by context tag/value
    - filtering by fields for “merge property changed” style updates
- [ ] Replace ResourceStore/ActiveResourceStore:
  - direct usage of datafn signals for record lists and record detail views
  - move UI editing state into Svelte component state or dedicated UI stores
  - implement shared “resource operations” as pure functions (not wrapper classes)
- [ ] Replace KeyValueStore:
  - migrate reads/writes to `client.kv.get/set/merge/delete/signal`
  - ensure any persisted UI prefs continue to work across reloads
- [ ] Backend integration:
  - mount `@datafn/server` in Nucleus backend with schema including Nucleus resources + relations + KV
  - ensure DB tables exist for all resources and join tables as required
- [ ] Verification:
  - Nucleus builds
  - core flows (list/create/update/delete) still work
  - offline mode (airplane) still allows CRUD and queues mutations
  - sync catches up when back online

## Verification steps

- From `/Users/ar/dev/nucleus`:

```bash
npm run build:nucleus
```

- Expected outcomes:
  - Nucleus app builds without Flux references in runtime paths.

## Stop condition

Before closing the spec execution:

- Provide a list of Nucleus files changed and the mapping from old Flux behaviors to new datafn equivalents.
- Provide a short manual test checklist (offline → mutate → online → sync; extension path if applicable).

