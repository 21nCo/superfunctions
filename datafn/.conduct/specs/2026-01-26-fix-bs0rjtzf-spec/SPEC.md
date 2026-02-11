# Metadata
- Timestamp (UTC): 2026-01-26T06:44:25.140805Z
- Agent name: unknown-agent
- Model: gpt-5.2 (xhigh reasoning)
- Launcher: Warp
- Workspace (absolute path): /Users/ar/dev/superfunctions
- OS: macOS
- Shell: zsh 5.9
- Repo:
  - Git branch: next
  - Git commit: 98c71853911e3aa96e9a72f892ee34e720ccc553
  - Dirty status: dirty (163 files reported by `git status --porcelain`)
- Spec:
  - spec_type: fix
  - spec_id: bs0rjtzf
  - spec_folder name: 2026-01-26-fix-bs0rjtzf-spec
  - spec_folder path (absolute): /Users/ar/dev/superfunctions/datafn/.conduct/specs/2026-01-26-fix-bs0rjtzf-spec
- Inputs read:
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/2026-01-26-fixes/client-intent-1.md (PRIMARY)
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/spec.md (background)
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/datafn.intent.md (background)
  - /Users/ar/dev/superfunctions/datafn/.conduct/intent/dfql.intent.md (background)
  - /Users/ar/dev/superfunctions/datafn/.conduct/audits/sync-remote-audit-2026-01-25.md (background)
  - https://www.fetch.at/spec.txt (format + spec bundle rules)

# datafn — Client Typing + Sync/Remote Fix Spec
## Overview
This spec defines a focused set of fixes for `datafn` centered on:
- TypeScript type inference for the ergonomic table registry (`client.<tableName>`)
- TypeScript compile-time adherence to DFQL shapes for `query()` and `signal()` inputs
- Restoring a batteries-included client sync + remote transport model (remote URL + built-in transport + client-managed push/pull)

This spec is intentionally scoped to the intent in:
- `datafn/.conduct/intent/2026-01-26-fixes/client-intent-1.md`

Anything not specified is Undefined and therefore not required.

## Expected configuration example
The client MUST support the following configuration shape (illustrative example):

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
    // other sync rules/config (retry config, etc.) are undefined unless specified
  },
});
```

## Glossary
- Datafn schema: A `DatafnSchema` (resources + relations) used to bound tables, fields, and relations.
- Resource / table: A schema-declared collection of records, addressed by `resource` name.
- Remote-only table: A resource with `isRemoteOnly: true` in schema; it is not cloned and is always served from the server.
- DFQL: Data Function Query Language (JSON) used as the canonical query/mutation/transact protocol.
- DFQL query fragment: A query object without `resource`/`version`; `DatafnTable.query()` injects them.
- Hydration state: Per-table state `{ notStarted | hydrating | ready }` used to route queries locally vs remotely.
- Offlinability: A client mode where the dataset is present locally (except remote-only tables) and writes are local-first with background sync.
- Changelog: A durable, ordered local queue of mutations pending push.
- Cursor: A monotonic token used by pull pagination to fetch changes since the last sync.

## Goals
- Provide correct type inference so `client.<tableName>` is a valid typed property when the schema is known at compile time.
- Make `client.table(name).query(fragment)` and `.signal(fragment)` reject unknown top-level keys at compile time (TypeScript excess property checks), aligning with DFQL’s allowed shape.
- Make the client responsible for sync and remote transport using `sync.remote` URL configuration, removing the requirement for end-users to provide a `DatafnRemoteAdapter` for the default HTTP case.
- Ensure local-first mutation semantics when `sync.offlinability === true`:
  - mutations are appended to the local changelog first
  - mutations are applied locally first (except remote-only tables and certain hydration edge cases)
  - background push/pull keeps local storage synchronized

## Non-goals
- This spec does not attempt to make DFQL fully schema-typed at the field/token level (e.g., TypeScript validating `select: ["unknownField"]`).
- This spec does not define the full query execution semantics for local evaluation beyond what is necessary for routing and sync correctness.

## Public API (normative)
### Package surfaces
- `@datafn/core` MUST export DFQL structural types used by `@datafn/client`.
- `@datafn/client` MUST export the typed client factory and client/table types.
- `@datafn/server` MUST expose `/datafn/push` and `/datafn/pull` endpoints with the protocol defined below.

### `@datafn/core`: DFQL structural types
`@datafn/core` MUST define (names are normative):

```ts
export type DfqlSort = string[];

export type DfqlCursor = {
  after?: Record<string, unknown>;
  before?: Record<string, unknown>;
};

export type DfqlQuery = {
  resource: string;
  version: number;
  select?: string[];
  omit?: string[];
  filters?: Record<string, unknown>;
  search?: Record<string, unknown>;
  sort?: DfqlSort;
  limit?: number;
  offset?: number;
  cursor?: DfqlCursor;
  count?: boolean;
  groupBy?: string[];
  aggregations?: Record<string, unknown>;
  having?: Record<string, unknown>;
};

export type DfqlQueryFragment = Omit<DfqlQuery, "resource" | "version">;

export type DfqlMutation = {
  resource: string;
  version: number;
  operation: string;
  id?: string | string[];
  record?: Record<string, unknown>;
  records?: Array<Record<string, unknown>>;
  clientId?: string;
  mutationId?: string;
  timestamp?: number | string;
  context?: unknown;
  // Relations and other advanced fields are allowed structurally.
  relations?: Record<string, unknown>;
  if?: Record<string, unknown>;
  cascade?: unknown;
};

export type DfqlMutationFragment = Omit<DfqlMutation, "resource" | "version">;

export type DfqlTransact = {
  transactionId?: string;
  atomic?: boolean;
  steps: Array<{ query?: DfqlQuery; mutation?: DfqlMutation }>;
};
```

Notes:
- These are *structural* (shape) types; they exist to reject unknown top-level properties.
- Schema-bounded validation remains a server responsibility.

### `@datafn/client`: typed client factory + table registry
#### `createDatafnClient`
`@datafn/client` MUST export:

```ts
import type {
  DatafnSchema,
  DatafnPlugin,
  DatafnEvent,
  DatafnSignal,
  DfqlQuery,
  DfqlQueryFragment,
  DfqlMutation,
  DfqlMutationFragment,
  DfqlTransact,
} from "@datafn/core";

export type DatafnHydrationState = "notStarted" | "hydrating" | "ready";

export interface DatafnStorageAdapter {
  // (existing interface; unchanged by this spec)
  getHydrationState(resource: string): Promise<DatafnHydrationState>;
  setHydrationState(resource: string, state: DatafnHydrationState): Promise<void>;

  getCursor(resource: string): Promise<string | null>;
  setCursor(resource: string, cursor: string | null): Promise<void>;

  changelogAppend(entry: {
    clientId: string;
    mutationId: string;
    mutation: Record<string, unknown>;
    timestampMs: number;
  }): Promise<{ seq: number; clientId: string; mutationId: string; mutation: Record<string, unknown>; timestampMs: number }>;

  changelogList(options?: { limit?: number }): Promise<Array<{ seq: number; clientId: string; mutationId: string; mutation: Record<string, unknown>; timestampMs: number }>>;
  changelogAck(options: { throughSeq: number }): Promise<void>;

  // plus existing record/join helpers
}

export type DatafnSyncConfig = {
  offlinability: boolean;
  remote: string; // base URL, e.g. "http://localhost:3000/datafn"
  ws?: boolean; // default: false
  pushInterval?: number; // ms; if omitted, push is immediate
  pushBatchSize?: number; // default: 100
  pushMaxRetries?: number; // default: 3
};

export type DatafnClientConfig<S extends DatafnSchema> = {
  schema: S;
  plugins?: DatafnPlugin[];
  clientId: string;
  storage?: DatafnStorageAdapter;
  sync: DatafnSyncConfig;
};

type ResourceNames<S extends DatafnSchema> = S["resources"][number]["name"];

type TableFor<S extends DatafnSchema, Name extends ResourceNames<S>> = DatafnTable<S, Name>;

export type DatafnClient<S extends DatafnSchema> = {
  table<Name extends ResourceNames<S>>(name: Name): TableFor<S, Name>;

  query(q: DfqlQuery | DfqlQuery[]): Promise<unknown>;
  mutate(m: DfqlMutation | DfqlMutation[]): Promise<unknown>;
  transact(t: DfqlTransact): Promise<unknown>;

  subscribe(handler: (e: DatafnEvent) => void, filter?: unknown): () => void;

  sync: {
    start(): void;
    stop(): void;
    pushNow(): Promise<void>;
    pullNow(): Promise<void>;
    cloneNow(): Promise<void>;
  };
} & {
  [Name in ResourceNames<S>]: TableFor<S, Name>;
};

export type DatafnTable<S extends DatafnSchema, Name extends ResourceNames<S>> = {
  name: Name;

  query(fragment: DfqlQueryFragment): Promise<unknown>;
  signal(fragment: DfqlQueryFragment): DatafnSignal<unknown>;

  mutate(fragment: DfqlMutationFragment | DfqlMutationFragment[]): Promise<unknown>;
  transact(payload: DfqlTransact): Promise<unknown>;

  subscribe(handler: (e: DatafnEvent) => void, filter?: unknown): () => void;
};

export function createDatafnClient<S extends DatafnSchema>(
  config: DatafnClientConfig<S>
): DatafnClient<S>;
```

Normative table registry behavior:
- The returned client MUST support `client.<tableName>` property access at runtime (via Proxy), and MUST have corresponding TypeScript types when schema is typed (see requirements).

## Data formats / protocol (normative)
### HTTP envelope
All `@datafn/server` HTTP endpoints MUST return a Datafn envelope:
- success: `{ "ok": true, "result": <payload> }`
- error: `{ "ok": false, "error": { "code": "...", "message": "...", "details": { "path": "..." } } }`

### Error codes (normative subset for this spec)
Server error codes used by this spec:
- `DFQL_INVALID`: syntactically/structurally invalid request payload.
- `DFQL_UNSUPPORTED`: request uses a feature the server does not support.
- `INTERNAL`: server misconfiguration or unexpected error.

Client-side error codes used by this spec:
- `DFQL_INVALID`: invalid client configuration or invalid client-side inputs.
- `DFQL_UNSUPPORTED`: client-side unsupported operation in the current mode.
- `TRANSPORT_ERROR`: response shape/protocol mismatch or network transport failures.

Failure behavior rules:
- Client config validation failures MUST throw a deterministic client error with `code:"DFQL_INVALID"`.
- Server request validation failures MUST be returned as top-level `ok:false` envelopes.
- Protocol mismatches (e.g., pull response with non-integer `nextCursor`) MUST be treated as client `TRANSPORT_ERROR`.

### Sync v1 endpoints
This spec defines sync protocol “v1” for client-managed push/pull.

#### POST `${remote}/push`
Request body:
```json
{ "clientId": "client-abc", "mutations": [ { "resource": "task", "version": 1, "operation": "merge", "id": "task:1", "record": { "title": "x" }, "clientId": "client-abc", "mutationId": "m-001" } ] }
```

Response `result`:
```json
{ "ok": true, "applied": ["m-001"], "errors": [], "cursor": "42" }
```

Rules:
- `cursor` MUST be a base-10 integer string representing the latest server-side cursor after applying this push batch.

#### POST `${remote}/clone`
Request body:
```json
{ "clientId": "client-abc", "tables": ["task", "user"] }
```

Response `result`:
```json
{ "ok": true, "data": { "task": [], "user": [] }, "cursor": "42" }
```

Rules:
- The server MUST reject cloning any table marked `isRemoteOnly:true`.
- `cursor` MUST be a base-10 integer string representing the latest server-side cursor after producing this snapshot.

#### POST `${remote}/pull`
Request body:
```json
{ "clientId": "client-abc", "cursor": "40", "limit": 500 }
```

Response `result`:
```json
{ "ok": true, "changes": [ { "serverSeq": "41", "resource": "task", "id": "task:1", "op": "upsert", "record": { "id": "task:1", "title": "x" } } ], "nextCursor": null }
```

Rules:
- `cursor` and `nextCursor` are base-10 integer strings.
- The server MUST return `changes` ordered by `serverSeq` ascending.
- Pagination: if more changes exist beyond `limit`, `nextCursor` MUST be a non-null cursor the client can pass to continue.

### WebSocket pull notifications
If `sync.ws === true`, the client MUST connect to:
- `wsUrl = ${remote}/ws` (e.g. `ws://localhost:3000/datafn/ws`)

Message protocol:
- Client → server:
  - `{ "type": "hello", "clientId": "...", "cursor": "<lastKnown>" }`
- Server → client:
  - `{ "type": "cursor", "cursor": "<latestServerCursor>" }`

Semantics:
- On receiving a server `cursor` message where `cursor` is greater than the client’s last stored cursor, the client MUST start a pull loop until up-to-date.

## Semantics (normative)
### Client config validation (deterministic)
The client MUST validate config at `createDatafnClient(...)` time.

Deterministic failures:
- If `sync.offlinability === true` and `storage` is missing:
  - code: `DFQL_INVALID`
  - message: `Invalid client config: storage is required when offlinability is true`
  - details.path: `storage`
- If `sync.pushBatchSize` is provided and is not a positive integer:
  - code: `DFQL_INVALID`
  - message: `Invalid client config: pushBatchSize must be a positive integer`
  - details.path: `sync.pushBatchSize`
- If `sync.pushInterval` is provided and is not a positive integer:
  - code: `DFQL_INVALID`
  - message: `Invalid client config: pushInterval must be a positive integer`
  - details.path: `sync.pushInterval`
- If `sync.pushMaxRetries` is provided and is not a non-negative integer:
  - code: `DFQL_INVALID`
  - message: `Invalid client config: pushMaxRetries must be a non-negative integer`
  - details.path: `sync.pushMaxRetries`

### Type inference
- When schema is known at compile time, `client.<tableName>` MUST be a typed property.
- `client.table(name)` MUST only accept schema table names at compile time.
- `DatafnTable.query` / `signal` MUST use `DfqlQueryFragment` so TypeScript rejects unknown top-level keys.

### Query routing
- If `sync.offlinability === false`, queries MUST be executed remotely.
- If `sync.offlinability === true`:
  - For remote-only tables, queries MUST be executed remotely.
  - For non-remote-only tables:
    - if hydration state is `ready`, queries MUST be executed locally.
    - if hydration state is `notStarted` or `hydrating`, queries MUST be executed remotely (temporary fallback).

### Mutation routing
- If `sync.offlinability === false`, mutations MUST be executed remotely.
- If `sync.offlinability === true`:
  - For remote-only tables, mutations MUST be executed remotely.
  - For non-remote-only tables:
    - if hydration state is `ready`, mutations MUST be local-first:
      1) append to changelog
      2) apply locally
      3) schedule push
    - if hydration state is `notStarted` or `hydrating`, mutations MAY be executed remotely to avoid conflicts with in-flight clone.

### Transact routing
- If `sync.offlinability === false`, `transact` MUST be executed remotely (via the server transact endpoint).
- If `sync.offlinability === true`:
  - `transact` MUST NOT call a remote transact endpoint for hydrated, non-remote-only tables.
  - The client MUST execute `steps` sequentially using the existing `query` and `mutate` routing rules.
  - If `atomic:true`, the client MUST throw a deterministic error:
    - code: `DFQL_UNSUPPORTED`
    - message: `Unsupported DFQL feature: transact.atomic`
    - details.path: `atomic`

### Push loop
When `sync.offlinability === true`, the client MUST manage push:
- The changelog is the source of truth for pending pushes.
- `pushInterval` defines batching:
  - If provided, the client pushes at most once per interval, sending up to `pushBatchSize` pending mutations.
  - If omitted, the client pushes as soon as possible after each mutation.
- Retry:
  - `pushMaxRetries` caps retries for a given push attempt.
  - After exceeding retries, the client MUST emit a `sync_failed` event with details.

### Pull loop
When `sync.offlinability === true`, the client MUST manage pull:
- On initialization:
  - If local tables are not hydrated, client MUST perform clone.
  - Otherwise client MUST perform a pull.
- When `sync.ws === false`, the client MUST also pull:
  - on visibility/appear events when available
  - after a successful push that returns a newer `cursor`
- Pull MUST paginate until `nextCursor === null`.
- Cursor updates MUST be monotonic (never decrease).

## Invariants
- Offlinability does not imply “always offline”: it implies local presence + local-first mutation semantics.
- Remote-only tables are never cloned and are always remote-executed.
- Push and pull cursors are monotonic.

## Security
- This spec does not define authentication; it assumes the host app protects `/datafn/*` endpoints via its middleware.
- The client MUST NOT log sensitive fields by default (Undefined which fields are sensitive; schema-marked `encrypt:true` MAY be used by logging layers).

## Limits / caps
- `pushBatchSize` MUST be a positive integer when provided.
- `pushMaxRetries` MUST be a non-negative integer when provided.
- `pushInterval` MUST be a positive integer when provided.
- Pull `limit` defaults and maximums are Undefined unless specified.

## Observability
- The client MUST emit `sync_failed` when push fails after retries.
- The client SHOULD emit `sync_applied` when pull results are applied.

## Compatibility / versioning
- This spec introduces a new default transport configuration based on `sync.remote` URL and MAY be a breaking change for callers that currently pass `remote: DatafnRemoteAdapter`.
- Backward compatibility behavior is Undefined unless explicitly implemented.

## Undefined / Explicitly user-deferred only
None.
