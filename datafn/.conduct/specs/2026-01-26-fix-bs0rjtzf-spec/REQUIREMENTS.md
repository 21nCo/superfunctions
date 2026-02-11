# DataFn Client Typing + Sync/Remote Fix — Requirements
Hard rule (from spec.txt): every MUST below includes acceptance criteria and at least one positive and one negative test vector reference.

## Table of contents (requirement IDs)
- TYPES-001
- TYPES-002
- DFQL-001
- CFG-001
- SYNC-QUERY-001
- SYNC-MUT-001
- SYNC-TX-001
- SYNC-PUSH-001
- SYNC-PUSH-002
- SYNC-PULL-001
- SYNC-PULL-002
- SYNC-PULL-003
- WS-001
- PROTO-PUSH-001
- PROTO-CLONE-001
- PROTO-PULL-001

## Requirements

## TYPES-001
- ID: TYPES-001
- Priority: P0
- Statement: `@datafn/client` MUST provide a `DatafnClient<S>` type such that `client.<tableName>` is a typed property for every schema-declared resource name when `S` is known at compile time.
- Rationale: The primary ergonomic authoring surface is `client.<table>`; TypeScript must not report missing property errors for schema tables.
- Acceptance criteria:
  - When schema is declared with literal resource names (e.g., `as const`) and passed to `createDatafnClient`, `client.task` is typed as a `DatafnTable<...>`.
  - Accessing an unknown property (not in the schema and not a known client method) produces a TypeScript compile error.
- Test vectors: TV-TYPES-001 (positive), TV-TYPES-002 (negative)
- Notes:
  - Runtime behavior is implemented via Proxy; this requirement is about TypeScript typing correctness.

## TYPES-002
- ID: TYPES-002
- Priority: P0
- Statement: `DatafnClient<S>.table(name)` MUST accept only schema-declared table names at compile time.
- Rationale: Prevents accidental typos and aligns `client.table("...")` with schema-boundedness.
- Acceptance criteria:
  - `client.table("task")` compiles when `task` exists in schema.
  - `client.table("notATable")` fails TypeScript compilation when it does not exist in schema.
- Test vectors: TV-TYPES-003 (positive), TV-TYPES-003 (negative)
- Notes:
  - This is a type-level restriction; runtime still validates and throws deterministically for unknown tables.

## DFQL-001
- ID: DFQL-001
- Priority: P0
- Statement: `DatafnTable.query(fragment)` and `DatafnTable.signal(fragment)` MUST accept `DfqlQueryFragment` and MUST reject unknown top-level keys at compile time.
- Rationale: The current API accepts arbitrary objects, masking DFQL mistakes until runtime.
- Acceptance criteria:
  - A fragment containing only allowed DFQL keys (e.g., `select`, `filters`, `limit`) compiles.
  - A fragment containing an extra top-level key (e.g., `notARealKey`) fails TypeScript compilation via excess property checks.
- Test vectors: TV-DFQL-QUERY-001 (positive), TV-DFQL-QUERY-002 (negative), TV-DFQL-SIGNAL-001 (positive), TV-DFQL-SIGNAL-002 (negative)
- Notes:
  - This requirement is structural; it does not require schema-level typing of field tokens.

## CFG-001
- ID: CFG-001
- Priority: P0
- Statement: `createDatafnClient` MUST accept a `sync` configuration including `offlinability`, `remote`, `ws`, and `pushInterval`, and MUST NOT require end-users to supply a `DatafnRemoteAdapter` for the default HTTP case.
- Rationale: Requiring a custom remote adapter is an architectural drift from the batteries-included intent and increases integration burden.
- Acceptance criteria:
  - The config shape in `client-intent-1.md` compiles and is supported.
  - When `sync.offlinability === true`, `storage` is required; missing storage causes a deterministic runtime error.
- Test vectors: TV-CFG-001 (positive), TV-CFG-002 (negative)
- Notes:
  - Advanced/custom transports are Undefined unless explicitly implemented.

## SYNC-QUERY-001
- ID: SYNC-QUERY-001
- Priority: P0
- Statement: When `sync.offlinability` is true, the client MUST route queries to local storage for hydrated tables and to remote for remote-only or non-hydrated tables.
- Rationale: Offlinability means the dataset exists locally and reads should be local-first once hydrated, while still supporting remote fallback during hydration.
- Acceptance criteria:
  - For non-remote-only tables with hydration state `ready`, no remote request is made.
  - For hydration state `notStarted` or `hydrating`, a remote request is made.
  - For remote-only tables, a remote request is always made.
- Test vectors: TV-ROUTE-QUERY-001 (positive), TV-ROUTE-QUERY-002 (negative)
- Notes:
  - The exact local query execution semantics are out of scope here; this requirement is about routing decisions.

## SYNC-MUT-001
- ID: SYNC-MUT-001
- Priority: P0
- Statement: When `sync.offlinability` is true and a table is hydrated, the client MUST append mutations to the local changelog first, apply them locally first (unless remote-only), and then push them to `${remote}/push`.
- Rationale: Local-first mutation semantics are required for responsive UX and offline correctness.
- Acceptance criteria:
  - Changelog append occurs before local apply.
  - Local storage reflects the mutation after the call returns.
  - The mutation is eventually included in a push request to the server.
- Test vectors: TV-PUSH-001 (positive), TV-MUT-001 (negative)
- Notes:
  - “Eventually” is bounded by `pushInterval` and retry policy.

## SYNC-TX-001
- ID: SYNC-TX-001
- Priority: P1
- Statement: When `sync.offlinability` is true, `client.transact(...)` MUST execute steps sequentially using the client’s query/mutation routing rules and MUST NOT call a remote transact endpoint for hydrated, non-remote-only tables.
- Rationale: The intent requires direct remote transact only when offlinability is false or during initial hydration; a local-first transact must not bypass local-first semantics.
- Acceptance criteria:
  - In offlinability mode with hydrated tables, `transact` does not call `${remote}/transact`.
  - Steps are executed in order and results preserve order.
  - If `atomic:true`, the client throws a deterministic `DFQL_UNSUPPORTED` error.
- Test vectors: TV-TX-001 (positive), TV-TX-002 (negative)
- Notes:
  - This requirement does not require true atomicity across steps.

## SYNC-PUSH-001
- ID: SYNC-PUSH-001
- Priority: P0
- Statement: The client MUST implement push batching with `pushInterval`, MUST default `pushBatchSize` to 100, and MUST default `pushMaxRetries` to 3.
- Rationale: Batching improves efficiency; defaults reduce configuration burden while keeping behavior predictable.
- Acceptance criteria:
  - If `pushInterval` is omitted, a push is initiated as soon as possible after each local-first mutation.
  - If `pushBatchSize` is omitted, each push sends at most 100 mutations.
  - If `pushMaxRetries` is omitted, the client retries a failed push at most 3 times per push attempt.
- Test vectors: TV-PUSH-003 (positive), TV-PUSH-004 (negative)
- Notes:
  - Retry backoff details are Undefined unless explicitly specified.

## SYNC-PUSH-002
- ID: SYNC-PUSH-002
- Priority: P0
- Statement: After exceeding `pushMaxRetries` for a push attempt, the client MUST emit a `sync_failed` event describing the failure.
- Rationale: Applications need observability and a hook to notify users when syncing is stuck.
- Acceptance criteria:
  - `sync_failed` is emitted after the final failed retry.
  - The event includes `context.phase === "push"` and the attempt count.
- Test vectors: TV-PUSH-002 (positive), TV-PUSH-005 (negative)
- Notes:
  - This is an event emission requirement; the mutation itself may still be considered locally successful.

## SYNC-PULL-001
- ID: SYNC-PULL-001
- Priority: P0
- Statement: On startup in offlinability mode, the client MUST perform `clone` for fresh installs and `pull` for already-hydrated installs.
- Rationale: Fresh installs need full hydration; existing installs need incremental catch-up.
- Acceptance criteria:
  - If any required local tables are not hydrated, `client.sync.start()` triggers clone.
  - Otherwise, `client.sync.start()` triggers pull.
- Test vectors: TV-PULL-001 (positive), TV-PULL-004 (negative)
- Notes:
  - The definition of “fresh install” is based on hydration state and/or stored cursor presence.

## SYNC-PULL-002
- ID: SYNC-PULL-002
- Priority: P0
- Statement: When `sync.ws` is false, the client MUST trigger pull on visibility/appear events when available and MUST trigger pull after a successful push that returns a newer cursor.
- Rationale: Without WebSockets, the client needs deterministic pull triggers to remain reasonably up-to-date.
- Acceptance criteria:
  - A push response containing a newer cursor triggers a pull loop.
  - In browser environments, a visibility change to visible triggers a pull.
- Test vectors: TV-PULL-005 (positive), TV-PULL-006 (negative)
- Notes:
  - In non-browser environments, visibility triggers are Undefined.

## SYNC-PULL-003
- ID: SYNC-PULL-003
- Priority: P0
- Statement: The client MUST implement pull pagination using `cursor`/`nextCursor` until `nextCursor` is null and MUST update stored cursor monotonically.
- Rationale: Pagination is required for large change streams; monotonic cursor prevents sync regressions.
- Acceptance criteria:
  - The client continues pulling while `nextCursor !== null`.
  - The stored cursor is updated only forward.
  - Invalid cursor responses are treated as protocol errors and do not decrease stored cursor.
- Test vectors: TV-PULL-002 (positive), TV-PULL-003 (negative)
- Notes:
  - Cursor storage location is implementation-defined but MUST be stable across sessions.

## WS-001
- ID: WS-001
- Priority: P1
- Statement: When `sync.ws` is true, the client MUST establish a WebSocket connection to `${remote}/ws` and MUST trigger pull when notified of a newer cursor.
- Rationale: WebSockets provide near-real-time sync without polling.
- Acceptance criteria:
  - The client sends a `hello` message containing `clientId` and current cursor.
  - A server `cursor` message with a higher cursor triggers pull.
  - Unknown WS messages are ignored.
- Test vectors: TV-WS-001 (positive), TV-WS-002 (negative)
- Notes:
  - Authentication on the WebSocket is Undefined.

## PROTO-PUSH-001
- ID: PROTO-PUSH-001
- Priority: P0
- Statement: `@datafn/server` MUST return a `cursor` field in the `POST /datafn/push` result payload as a base-10 integer string.
- Rationale: The client needs a server cursor to decide whether to pull after push.
- Acceptance criteria:
  - A successful push returns `{ ok:true, result:{ ok:true, applied, errors, cursor } }`.
  - Invalid `clientId` yields a deterministic top-level `DFQL_INVALID` error.
- Test vectors: TV-PROTO-PUSH-001 (positive), TV-PROTO-PUSH-001 (negative)
- Notes:
  - The exact semantics of `cursor` are defined in `SPEC.md`.

## PROTO-CLONE-001
- ID: PROTO-CLONE-001
- Priority: P1
- Statement: `@datafn/server` MUST return a base-10 integer string `cursor` in the `POST /datafn/clone` result payload and MUST reject cloning tables marked `isRemoteOnly:true`.
- Rationale: The client needs a cursor baseline after clone to avoid re-pulling the entire history and to preserve monotonic sync.
- Acceptance criteria:
  - Successful clone returns `{ ok:true, result:{ ok:true, data:{...}, cursor:"<int>" } }`.
  - If any requested table is remote-only, clone returns a deterministic top-level `DFQL_INVALID` error.
- Test vectors: TV-PROTO-CLONE-001 (positive), TV-PROTO-CLONE-001 (negative)
- Notes:
  - The snapshot content in `data` is implementation-defined beyond being schema-bounded.

## PROTO-PULL-001
- ID: PROTO-PULL-001
- Priority: P0
- Statement: `@datafn/server` MUST accept a `cursor` and `limit` in `POST /datafn/pull` and MUST return `{ changes, nextCursor }` pagination in the result payload.
- Rationale: The client requires deterministic pagination and cursor semantics for incremental sync.
- Acceptance criteria:
  - Successful pull returns `{ ok:true, result:{ ok:true, changes:[...], nextCursor:null|string } }`.
  - `changes` are ordered by `serverSeq` ascending.
  - Invalid cursor format yields a deterministic top-level `DFQL_INVALID` error.
- Test vectors: TV-PROTO-PULL-001 (positive), TV-PROTO-PULL-001 (negative)
- Notes:
  - `serverSeq` is a base-10 integer string.
