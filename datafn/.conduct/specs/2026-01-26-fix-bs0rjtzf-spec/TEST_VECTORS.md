# DataFn Client Typing + Sync/Remote Fix — Test Vectors
Each vector is a deterministic input/output example used to verify requirements.

## TV-TYPES-001
Description: `client.<tableName>` property access is type-safe when schema is compile-time known.
Input:
```ts
import { createDatafnClient, MemoryStorageAdapter } from "@datafn/client";

const schema = {
  resources: [
    { name: "task", version: 1, fields: [{ name: "title", type: "string", required: true }] },
    { name: "user", version: 1, fields: [{ name: "name", type: "string", required: true }] },
  ],
} as const;

const client = createDatafnClient({
  schema,
  storage: new MemoryStorageAdapter(),
  clientId: "client-abc",
  sync: { offlinability: true, remote: "http://localhost:3000/datafn" },
});

// MUST compile
client.task.query({ select: ["id"], limit: 10 });
client.user.signal({ select: ["id"] });
```
Expected output:
- TypeScript compile result: success (no error).
Negative variant:
- See TV-TYPES-002.

## TV-TYPES-002
Description: Unknown table property access is rejected by TypeScript.
Input:
```ts
// same setup as TV-TYPES-001
client.notATable.query({ select: ["id"] });
```
Expected output:
- TypeScript compile result: error.
- Expected error contains: `Property 'notATable' does not exist`.

## TV-TYPES-003
Description: `client.table(name)` only accepts schema-declared names.
Input:
```ts
// same setup as TV-TYPES-001
client.table("task");
client.table("notATable");
```
Expected output:
- `client.table("task")`: TypeScript compile success.
- `client.table("notATable")`: TypeScript compile error (argument not assignable).

## TV-DFQL-QUERY-001
Description: Query fragments reject unknown top-level keys.
Input:
```ts
// same setup as TV-TYPES-001
client.task.query({
  select: ["id"],
  filters: { id: "task:1" },
  limit: 1,
});
```
Expected output:
- TypeScript compile result: success.
Negative variant:
- See TV-DFQL-QUERY-002.

## TV-DFQL-QUERY-002
Description: Query fragments do not allow extra properties.
Input:
```ts
// same setup as TV-TYPES-001
client.task.query({
  select: ["id"],
  notARealKey: true,
});
```
Expected output:
- TypeScript compile result: error.
- Expected error contains: `Object literal may only specify known properties`.

## TV-DFQL-SIGNAL-001
Description: Signal fragments are typed as DFQL query fragments.
Input:
```ts
// same setup as TV-TYPES-001
client.task.signal({ select: ["id"], sort: ["id:asc"], limit: 10 });
```
Expected output:
- TypeScript compile result: success.
Negative variant:
- See TV-DFQL-SIGNAL-002.

## TV-DFQL-SIGNAL-002
Description: Signal fragments reject unknown keys.
Input:
```ts
// same setup as TV-TYPES-001
client.task.signal({ select: ["id"], extra: 123 });
```
Expected output:
- TypeScript compile result: error.

## TV-CFG-001
Description: The expected client config shape is accepted.
Input:
```ts
import { createDatafnClient, IndexedDbStorageAdapter } from "@datafn/client";

const client = createDatafnClient({
  schema,
  storage: new IndexedDbStorageAdapter("todo-app-db"),
  clientId: "client-" + Math.random().toString(36).slice(2),
  sync: {
    offlinability: true,
    remote: "http://localhost:3000/datafn",
    ws: true,
    pushInterval: 2000,
  },
});
```
Expected output:
- TypeScript compile result: success.
Negative variant:
- See TV-CFG-002.

## TV-CFG-002
Description: Offlinability requires storage.
Input:
```ts
createDatafnClient({
  schema,
  clientId: "client-abc",
  sync: { offlinability: true, remote: "http://localhost:3000/datafn" },
});
```
Expected output:
- Runtime: throws a deterministic client error.
- Error code: `DFQL_INVALID`
- Error message: `Invalid client config: storage is required when offlinability is true`

## TV-PUSH-001
Description: Local-first mutation appends to changelog first, applies locally, then pushes.
Input:
- Given:
  - `sync.offlinability=true`
  - `storage.getHydrationState("task") === "ready"`
  - initial local record set: empty
  - remote `/datafn/push` responds with `{ ok:true, result:{ ok:true, applied:["m-001"], errors:[], cursor:"10" } }`
- When calling:
```ts
await client.task.mutate({
  operation: "merge",
  id: "task:1",
  record: { title: "hello" },
  clientId: "client-abc",
  mutationId: "m-001",
});
```
Expected output:
- `storage.changelogAppend` is called before the local upsert.
- Local storage contains `{ id:"task:1", title:"hello" }` after the call.
- A push request is eventually sent to `${remote}/push` with body:
```json
{ "clientId":"client-abc", "mutations": [ { "resource":"task", "version":1, "operation":"merge", "id":"task:1", "record": {"title":"hello"}, "clientId":"client-abc", "mutationId":"m-001" } ] }
```
- After push success, `storage.changelogAck({ throughSeq: <seq of m-001> })` is called.
Negative variant:
- See TV-PUSH-002.

## TV-PUSH-002
Description: Push retries are capped; exceeding max retries emits `sync_failed`.
Input:
- Given:
  - `pushMaxRetries=3`
  - remote `/datafn/push` fails with transport error 3 times in a row
  - there is at least 1 pending changelog entry
Expected output:
- The client attempts push 3 times.
- After the 3rd failure, the client emits a `sync_failed` event with context including:
  - `{ phase:"push", attempts:3 }`.

## TV-PUSH-003
Description: `pushBatchSize` default is 100.
Input:
- Given 250 pending changelog entries.
- `pushInterval=2000` and `pushBatchSize` omitted.
Expected output:
- Each push call sends at most 100 mutations.

## TV-PULL-001
Description: Initialization calls clone for a fresh install.
Input:
- Given:
  - `sync.offlinability=true`
  - storage indicates not hydrated (e.g., hydration state is `notStarted` for at least one non-remote-only table)
  - remote `/datafn/clone` returns `{ ok:true, result:{ ok:true, data:{ task:[...], user:[...] }, cursor:"10" } }`
Expected output:
- The client calls clone during `client.sync.start()`.
- The client applies clone data into storage and marks hydration state `ready`.

## TV-PULL-002
Description: Pull paginates using cursor until `nextCursor` is null.
Input:
- Given stored cursor is `"10"`.
- remote `/datafn/pull` responses:
  - page 1: `{ ok:true, result:{ ok:true, changes:[...], nextCursor:"20" } }`
  - page 2: `{ ok:true, result:{ ok:true, changes:[...], nextCursor:null } }`
Expected output:
- The client issues 2 pull calls.
- The client applies all changes in order.
- The client stores cursor `"20"` at the end.
Negative variant:
- See TV-PULL-003.

## TV-PULL-003
Description: Pull rejects invalid cursor responses.
Input:
- remote `/datafn/pull` returns `nextCursor:"not-a-number"`.
Expected output:
- The client treats this as a protocol error and emits `sync_failed` with `phase:"pull"`.

## TV-WS-001
Description: When `ws:true`, a server cursor notification triggers a pull.
Input:
- Client config: `sync.ws=true`.
- Server sends WebSocket message: `{ "type":"cursor", "cursor":"42" }`.
Expected output:
- The client starts a pull loop using cursor `42` (or pulls until reaching 42).

## TV-WS-002
Description: Unknown WebSocket messages do not corrupt cursor state.
Input:
- Server sends: `{ "type":"unknown", "foo":123 }`.
Expected output:
- The client ignores the message.
- The stored cursor is unchanged.

## TV-PROTO-PUSH-001
Description: Server push response includes cursor.
Input (HTTP):
```json
{ "clientId":"client-abc", "mutations": [] }
```
Expected output (HTTP 200 JSON):
```json
{ "ok": true, "result": { "ok": true, "applied": [], "errors": [], "cursor": "0" } }
```
Negative variant:
- If `clientId` is missing, server returns `{ ok:false, error:{ code:"DFQL_INVALID", message:"Invalid DFQL: clientId must be string", details:{ path:"clientId" } } }`.

## TV-PROTO-CLONE-001
Description: Server clone response includes cursor and rejects remote-only tables.
Input (HTTP):
```json
{ "clientId":"client-abc", "tables": ["task"] }
```
Expected output (HTTP 200 JSON):
```json
{ "ok": true, "result": { "ok": true, "data": { "task": [] }, "cursor": "0" } }
```
Negative variant:
- If `tables` includes a remote-only table, server returns `{ ok:false, error:{ code:"DFQL_INVALID", message:"Invalid DFQL: remote-only table cannot be cloned: <table>", details:{ path:"tables" } } }`.

## TV-PROTO-PULL-001
Description: Server pull supports cursor + limit pagination.
Input (HTTP):
```json
{ "clientId":"client-abc", "cursor": "0", "limit": 2 }
```
Expected output (HTTP 200 JSON):
```json
{ "ok": true, "result": { "ok": true, "changes": [], "nextCursor": null } }
```
Negative variant:
- If `cursor` is not a base-10 integer string, server returns `{ ok:false, error:{ code:"DFQL_INVALID", message:"Invalid DFQL: cursor must be an integer string", details:{ path:"cursor" } } }`.

## TV-ROUTE-QUERY-001
Description: In offlinability mode, hydrated table queries are local-first.
Input:
- Given:
  - `sync.offlinability=true`
  - table `task` is not remote-only
  - `storage.getHydrationState("task") === "ready"`
- When calling:
```ts
await client.task.query({ select: ["id"], limit: 10 });
```
Expected output:
- No HTTP request is made to `${remote}/query`.
- The query is executed against local storage.
Negative variant:
- See TV-ROUTE-QUERY-002.

## TV-ROUTE-QUERY-002
Description: In offlinability mode, non-hydrated or remote-only table queries are remote.
Input:
- Given either:
  - `storage.getHydrationState("task") === "hydrating"`, or
  - the table is marked `isRemoteOnly:true` in schema
- When calling:
```ts
await client.task.query({ select: ["id"], limit: 10 });
```
Expected output:
- An HTTP request is made to `${remote}/query`.

## TV-MUT-001
Description: If changelog append fails, local-first mutation fails before local apply.
Input:
- Given:
  - `sync.offlinability=true`
  - `storage.getHydrationState("task") === "ready"`
  - `storage.changelogAppend(...)` throws an error
- When calling:
```ts
await client.task.mutate({ operation: "merge", id: "task:1", record: { title: "x" }, clientId: "client-abc", mutationId: "m-001" });
```
Expected output:
- The mutation call rejects.
- No local upsert is applied.

## TV-PUSH-004
Description: Invalid push batching configuration is rejected deterministically.
Input:
```ts
createDatafnClient({
  schema,
  storage: new MemoryStorageAdapter(),
  clientId: "client-abc",
  sync: { offlinability: true, remote: "http://localhost:3000/datafn", pushBatchSize: 0 },
});
```
Expected output:
- Runtime: throws a deterministic client error.
- Error code: `DFQL_INVALID`
- Error message: `Invalid client config: pushBatchSize must be a positive integer`

## TV-PUSH-005
Description: `sync_failed` is not emitted before exhausting retries.
Input:
- Given:
  - `pushMaxRetries=3`
  - remote push fails exactly once and then succeeds
Expected output:
- No `sync_failed` event is emitted after the first failure.

## TV-PULL-004
Description: Clone failure does not mark tables hydrated.
Input:
- Given:
  - fresh install (not hydrated)
  - remote clone fails (transport error or `ok:false` envelope)
Expected output:
- The client emits `sync_failed` with `context.phase === "clone"`.
- Hydration state remains `notStarted`/`hydrating` (not forced to `ready`).

## TV-PULL-005
Description: After a successful push returns a newer cursor, the client triggers pull (when `ws:false`).
Input:
- Given:
  - stored cursor is `"10"`
  - push response contains `cursor:"42"`
  - `sync.ws=false`
Expected output:
- The client starts a pull loop beginning at cursor `"10"`.

## TV-PULL-006
Description: If push returns a non-newer cursor, the client does not pull.
Input:
- Given:
  - stored cursor is `"42"`
  - push response contains `cursor:"42"`
  - `sync.ws=false`
Expected output:
- The client does not start a pull loop.

## TV-TX-001
Description: In offlinability mode, transact runs locally and does not call remote transact.
Input:
- Given:
  - `sync.offlinability=true`
  - hydration state is `ready` for all referenced non-remote-only tables
- When calling:
```ts
await client.transact({
  atomic: false,
  steps: [
    { query: { resource: "task", version: 1, select: ["id"], limit: 1 } },
    { mutation: { resource: "task", version: 1, operation: "merge", id: "task:1", record: { title: "x" }, clientId: "client-abc", mutationId: "m-001" } },
  ],
});
```
Expected output:
- No HTTP request is made to `${remote}/transact`.
- Steps execute in order and results preserve order.

## TV-TX-002
Description: Atomic transact is rejected in offlinability mode.
Input:
```ts
await client.transact({ atomic: true, steps: [] });
```
Expected output:
- Runtime: throws a deterministic client error.
- Error code: `DFQL_UNSUPPORTED`
- Error message: `Unsupported DFQL feature: transact.atomic`
