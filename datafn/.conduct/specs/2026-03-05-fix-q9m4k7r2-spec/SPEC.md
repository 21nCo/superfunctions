# SPEC: Fix Merge Regression Causing KV False Success and Missing Persistence

## Metadata

- **Timestamp**: 2026-03-05T07:18:42Z
- **agent_name**: codex-gpt5
- **model**: gpt-5
- **launcher**: CLI
- **workspace/project path**: /Users/serro/Documents/dev/n/superfunctions
- **OS + shell**: Darwin 25.3.0 / zsh
- **git branch**: `next`
- **git commit**: `664f92c880a6a5a150d115bf60e30f37c4107062`
- **git dirty status**: dirty (`215` changed files)
- **spec_folder**: `2026-03-05-fix-q9m4k7r2-spec`
- **spec_folder full path**: `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-05-fix-q9m4k7r2-spec`
- **spec_type**: `fix`
- **spec_id**: `q9m4k7r2`
- **input paths**:
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/issues/2026-02-27-x8k3m9v7-issue.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/issue-completions/2026-02-27-x8k3m9v7-completion.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/issues/2026-03-01-m4k7x9v2-issue.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/issues/2026-03-01-n4k8v2m7-issue.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/issues/2026-03-03-r4k7m9x3-issue.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/issue-completions/2026-03-05-k7m9x4r3-completion.md`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/client/src/kv.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/sync/push.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/mutation/execute.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/db/src/adapters/drizzle/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/db/src/adapter/row-level-namespace.ts`

## Overview

A regression chain caused KV theme mutations to return success while no `kv` row exists in the database for the namespace:

1. KV client `set()` was changed to use `merge` (upsert intent).
2. Server `merge` for push/mutation was changed to `update`-only to avoid SQL NOT NULL failures for partial todo updates.
3. Drizzle adapter `update()` returns `undefined` on zero matched rows (Postgres/SQLite returning empty result) instead of throwing, so server code treats missing-row updates as success.
4. Push marks mutation as applied and records change-tracking despite no persisted row.

This spec fixes the semantic mismatch and false-success path without reintroducing the todo NOT NULL regression.

## Context

- **Project name**: datafn
- **One-sentence goal**: Restore correct merge persistence semantics so KV first-write persists while todo partial merges remain safe.
- **Target users**: datafn server/client integrators and apps using namespace-scoped KV + sync.
- **Target environments**: TypeScript server/client, Node.js runtime, SQL adapters (especially Drizzle-backed Postgres/SQLite), offline/online sync.
- **Languages/packages required**: TypeScript, `@datafn/*`, `@superfunctions/db` (drizzle + namespace wrapper).
- **Existing systems to integrate with**: datafn sync endpoints (`/datafn/mutation`, `/datafn/push`, `/datafn/pull`), change tracking, idempotency.
- **Data model summary**: namespace-scoped resources with `id` keys; `kv` resource (`id`, `value`) and `todos` resource with required non-null fields.
- **Security model**: row-level namespace isolation via `__ns`, deny-by-default authz model already in place.
- **Performance constraints**: keep merge path bounded (no unbounded retries); avoid extra DB round-trips in steady state.
- **Non-goals**: no wire-protocol redesign, no namespace model rewrite, no broad replace semantics change.
- **Hard constraints**: deterministic merge decisioning, no false-success mutation reporting, backward-compatible envelopes.

## Glossary

- **Merge mutation**: Partial update operation intended to modify only provided fields.
- **Merge-create eligibility**: Whether a missing-row merge may create a row from the provided payload.
- **False success**: API returns applied/success although no database row was written.
- **Namespace row isolation**: Row-level `__ns` filtering/stamping by adapter wrapper.
- **Adapter not-found contract**: `Adapter.update()` behavior when `where` matches zero rows.
- **KV first-write**: First `kv.set(key, value)` for a key that has no server row yet.

## Goals

1. `kv.set()` and `kv.merge()` MUST persist correctly for first-write and update paths.
2. Todo partial `merge` MUST continue to avoid invalid INSERT/NOT NULL behavior.
3. Push/mutation endpoints MUST NOT report success when no row is persisted.
4. Merge semantics MUST be deterministic across adapters (memory + drizzle).
5. The fix MUST cover both `/datafn/mutation` and `/datafn/push` execution paths.

## Non-goals

1. Changing public route envelopes or introducing new endpoints.
2. Reworking replace semantics globally.
3. Changing namespace model (`__ns`) or conflict-target strategy.
4. Broad refactor of all adapter implementations beyond update-not-found contract compliance.

## Public API

No new public API is introduced. Existing envelopes remain canonical.

### Canonical `/datafn/mutation` response envelope

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "mutationId": "mut-123",
    "affectedIds": ["kv:pref:theme"],
    "errors": []
  }
}
```

Error form:

```json
{
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Record not found: kv:pref:theme",
    "details": { "path": "id" }
  }
}
```

### Canonical `/datafn/push` result envelope

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "applied": ["mut-1"],
    "errors": [],
    "cursor": "17",
    "cursorBefore": "16",
    "cursors": { "kv": "17" }
  }
}
```

## Data Formats / Protocol

### Merge decision input (internal canonical shape)

```ts
{
  resource: string;
  id: string;
  delta: Record<string, unknown>;
  schemaRequiredFields: string[];
}
```

### Merge decision output (internal canonical shape)

```ts
{
  mode: "update" | "create" | "not_found";
  createRecord?: Record<string, unknown>;
}
```

## Semantics

1. Server merge execution MUST follow this sequence:
   - Attempt `update` for `(namespace, id)`.
   - If update matched a row: success.
   - If update matched zero rows: evaluate merge-create eligibility.
   - If eligible: attempt `create` with `{ id, ...delta }`, with one conflict retry to `update`.
   - If not eligible: return `NOT_FOUND`.
2. Merge-create eligibility MUST be schema-driven:
   - Required resource fields (excluding `id` and system namespace column) MUST be present in delta or have schema defaults.
3. Adapter update contract MUST be strict:
   - Zero-row `update` MUST throw `NotFoundError` (or equivalent typed not-found) for all adapter paths used by server merge.
4. Push mutation accounting MUST be persistence-backed:
   - Mutation ID MUST be added to `applied` only when the write path persisted a row (update/create).
   - Change tracking MUST only record successful writes.
5. KV behavior:
   - First `kv.set` for missing key MUST create the row.
   - Subsequent `kv.set` MUST update existing value.
   - `kv.merge` patch path MUST preserve existing object merge behavior and create on first write when eligible.

## Invariants

1. **INV-1**: No successful merge response without a persisted DB write.
2. **INV-2**: Partial merge on resources missing required fields never silently creates invalid rows.
3. **INV-3**: Merge outcome is deterministic for identical `(resource, id, delta, existingRowState)` inputs.
4. **INV-4**: Namespace isolation remains enforced for all update/create/read operations.

## Determinism Rules

1. For the same resource schema, namespace, record existence, and merge payload, server merge decision (`update | create | not_found`) MUST be identical across runs.
2. Create-race handling MUST perform at most one retry; retry count MUST NOT depend on timing after the single retry window.
3. Error mapping for equivalent failure classes MUST be stable (`NOT_FOUND`, `DFQL_INVALID`, `INTERNAL`) with stable `path` fields.

## Security

1. Namespace scoping MUST remain mandatory where configured.
2. Error responses MUST keep existing genericity boundaries (`INTERNAL` message remains generic).
3. Logs MUST NOT include full mutation payloads beyond existing safe metadata fields.

## Limits / Caps

1. Merge create-race retry is capped to one retry (`create conflict -> update once`).
2. No unbounded retry loops are allowed in merge write path.

## Observability

1. Merge not-found paths SHOULD log structured debug/warn context with resource/id and decision mode.
2. False-success conditions MUST be test-detectable via applied list and change log assertions.

## Compatibility / Versioning Strategy

1. Backward compatible wire format: no request/response shape changes.
2. Behavioral change is corrective: success now means persisted write, not attempted write.
3. Existing clients continue to use `merge`; server correctness is restored without client API change.

## Undefined / Explicitly User-Deferred Only

- No user-deferred items were specified.
- Any behavior not explicitly defined in this spec is undefined and not required for implementation.
