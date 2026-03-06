# Datafn Remaining Audit Fix Spec

## Metadata
- Timestamp: 2026-03-05T16:56:59Z
- agent_name: unknown-agent
- model: gpt-5 (Codex)
- launcher: Codex Desktop
- workspace: /Users/serro/Documents/dev/n/superfunctions/datafn
- OS/Shell: Darwin 25.3.0 / zsh
- Git branch: next
- Git commit: 664f92c880a6a5a150d115bf60e30f37c4107062
- Git status: dirty
- spec_type: audit-fix
- spec_id: nv5royb4
- spec_folder: 2026-03-05-audit-fix-nv5royb4-spec
- spec_folder_path: /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-03-05-audit-fix-nv5royb4-spec
- Input paths read:
  - /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/audits/2026-02-28-k7m4x9r3-full-audit.md
  - /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec/REQUIREMENTS.md
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/routes/mutation.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/routes/sync.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/routes/query.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/validation/query.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/mutation/execute.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/sync/push.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/sync/change-tracking.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/db-store.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/query/search.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/execution/query/select.ts
  - /Users/serro/Documents/dev/n/superfunctions/datafn/server/src/logging.ts
- Audit linkage:
  - Fixing remaining findings from audit: /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/audits/2026-02-28-k7m4x9r3-full-audit.md
  - Related prior spec bundle: /Users/serro/Documents/dev/n/superfunctions/datafn/.conduct/specs/2026-02-27-audit-fix-v7k3m9x4-spec

## Overview
Project name: Datafn

One-sentence goal: Close all still-open findings from the 2026-02-28 datafn full audit with deterministic, testable behavior changes and no silent regressions.

Target users: Datafn server maintainers, SDK maintainers, and downstream application developers running multi-tenant sync workloads.

Target environments:
- Node.js server runtime (TypeScript)
- Server adapters via `@superfunctions/db` (memory, drizzle, prisma, kysely)
- HTTP and WS routes in `@datafn/server`

Languages/packages required:
- TypeScript
- Existing repo packages only (`@datafn/*`, `@superfunctions/*`)

Existing systems to integrate with:
- `@superfunctions/db` adapter interface and internal CRUD
- Existing Datafn route envelope and error code patterns
- Existing test stack (Vitest)

Data model summary:
- Resource records in user-defined tables
- Internal tables: `__datafn_meta`, `__datafn_changes`, `__datafn_idempotency`
- Optional relations (`many-one`, `one-many`, `many-many`) and join rows

Security model:
- Per-request namespace isolation (multi-tenant)
- Route-level authz + schema validation
- Defensive validation against prototype-pollution keys
- No sensitive payload data in request logs

Performance constraints:
- Bounded mutation batch size
- Bounded query concurrency for batch execution
- Search candidate processing MUST not silently truncate beyond cap

Non-goals:
- Re-implementing already-passed audit findings
- Changing public response envelope format
- Introducing new external dependencies

Hard constraints:
- Deterministic error envelopes and codes
- No hidden fallback that weakens security or consistency
- Keep behavior backward compatible unless explicitly documented in this spec

## Glossary
- Batch mutation endpoint: `POST /datafn/mutation` with array body.
- Push endpoint: `POST /datafn/push` with `{ clientId, mutations[] }`.
- Atomic mutation unit: mutation DB operation and its change-tracking writes succeed or fail together when transactions are supported.
- Prototype-pollution key: `__proto__`, `constructor`, `prototype`.
- Query batch concurrency: max number of query items from one batch request executing simultaneously.

## Goals / Non-goals
### Goals
- Implement the remaining unresolved findings: SEC-006, SEC-008, REL-002 (consistency gap), REL-011/EXE-020 (push atomicity gap), PER-002, SRV-001, SRV-003, SRV-005, EXE-014, EXE-017, EXE-018, EXE-022, LOG-002.
- Keep canonical envelopes and error contracts stable.
- Add regression vectors that fail when old behavior reappears.

### Non-goals
- Re-auditing the whole codebase from scratch.
- Changing client protocol semantics outside scope of listed issues.

## Public API
### Server config additions/changes
`DatafnServerConfig.limits` MUST include:
- `maxBatchSize?: number` (default `500`)
- `maxBatchQueryConcurrency?: number` (default `20`)

### Route behavior contract
- `POST /datafn/mutation` and `POST /datafn/push` MUST enforce `maxBatchSize`.
- Batch query handling in `POST /datafn/query` MUST queue excess work beyond `maxBatchQueryConcurrency` and MUST NOT reject solely because batch length exceeds concurrency.

### Internal APIs
- Shared retry helper for change-tracking writes MUST be used by both execute and push paths.
- Change-tracking bulk write path MAY add an optional batched-insert capability (`internal.createMany`-style extension) with strict fallback behavior defined in this spec.

## Data Formats / Protocol
### Canonical success envelope
```json
{ "ok": true, "result": <payload> }
```

### Canonical error envelope
```json
{
  "ok": false,
  "error": {
    "code": "<ERROR_CODE>",
    "message": "<human-readable>",
    "details": { "path": "<json-path>" }
  }
}
```

### Error code requirements for this spec
- Validation/cap violations: `DFQL_INVALID`
- Unsupported query feature path retained as existing behavior where already defined: `DFQL_UNSUPPORTED`
- Internal execution failures: `INTERNAL`

## Semantics
### Batch limits
- `maxBatchSize` default is `500` and is applied uniformly to push and mutation endpoints.
- Rejection message MUST include both actual count and configured maximum.

### Prototype-pollution validation scope
Validation MUST reject disallowed keys recursively in:
- Entire mutation payload object
- Entire query payload object
- Query filters
- Query aggregations
- Query having clause

### Push atomicity
- When adapter transactions are supported, each push mutation MUST execute as a single atomic unit: operation + change tracking.
- If any write in the unit fails, mutation result MUST be failure and user data change MUST be rolled back.
- When transactions are not supported, behavior remains best-effort and non-atomic, but failures MUST be explicit.

### Change-tracking retry parity
- Both push and execute mutation flows MUST retry change tracking up to two retries with 50ms/100ms backoff before returning failure.

### Batch query concurrency
- Concurrency limit controls only simultaneous execution count.
- Batch length greater than concurrency is allowed and MUST be queued.

### Search candidate handling
- Candidate IDs beyond 1000 MUST be processed in deterministic pages/chunks, not silently dropped.
- Final result MUST be equivalent to evaluating all candidates under existing filter semantics.

### Query route modularity
- `routes/query.ts` MUST be split by concern (validation, batching/concurrency, execution orchestration) while preserving request/response behavior.

## Invariants
- Deterministic envelopes: same input and store state MUST produce same envelope code/path.
- No silent truncation: oversized search candidate sets MUST not be silently reduced.
- No hidden fallback to broad scans: unknown/unhandled relation shapes MUST not trigger `where: []` full-table loads.
- No mutation success without corresponding change-tracking success in transaction-capable push path.

## Security
- Prototype-pollution key rejection is mandatory before any read/write planning.
- Batch caps are mandatory DoS guards and must be configurable centrally.
- Logging path MUST avoid `console.*` fallback in request logging helpers and route through structured logger only.

## Limits / Caps
- `maxBatchSize`: default `500`
- `maxBatchQueryConcurrency`: default `20`
- Search candidate chunk size: default `1000` per chunk, process all chunks
- Existing payload cap behavior remains unchanged (`maxPayloadBytes` already in place)

## Observability
- `logRequest` MUST always emit via `DatafnLogger`.
- Batch query executor SHOULD emit queue-depth/in-flight metrics through existing timing/log hooks.
- Fallback paths (e.g., no transaction support) MUST log structured warnings with operation + namespace context.

## Compatibility / Versioning Strategy
- Existing envelope shapes remain unchanged.
- Existing route paths remain unchanged.
- New config fields are additive and optional.
- If `maxBatchQueryConcurrency` is omitted, default behavior is stable and bounded.

## Undefined / Explicitly User-Deferred Only
- Undefined and not required by this spec:
  - Reworking unrelated LOW-priority findings already marked pass/closed.
  - Altering client API contracts unrelated to listed issues.
- No user-deferred items in this spec.
