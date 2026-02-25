# Test Vectors

## TV-ICRUD-001 — InternalCrud Interface Exists

- **Description**: Verify `InternalCrud` and `InternalColumnDef` types are exported from `@superfunctions/db`
- **Input**: `import type { InternalCrud, InternalColumnDef } from '@superfunctions/db'`
- **Expected Output**: TypeScript compilation succeeds
- **Negative**: Importing `InternalCrud` from a wrong path → compilation error

---

## TV-ENSURE-001 — ensureTable Creates Table on First Call

- **Description**: Calling `ensureTable` creates the internal table, subsequent calls are no-ops
- **Input**:

```typescript
await adapter.internal.ensureTable("__datafn_meta", [
  { name: "id", type: "text", primaryKey: true },
  { name: "namespace", type: "text" },
  { name: "nextServerSeq", type: "integer" },
]);
// Call again
await adapter.internal.ensureTable("__datafn_meta", [
  { name: "id", type: "text", primaryKey: true },
  { name: "namespace", type: "text" },
  { name: "nextServerSeq", type: "integer" },
]);
```

- **Expected Output**: No error on either call. DDL runs only once.

## TV-ENSURE-002 — ensureTable Rejects Invalid Names

- **Description**: Table names not matching `__datafn_*` pattern are rejected
- **Input**:

```typescript
await adapter.internal.ensureTable("users", [
  /* ... */
]);
```

- **Expected Output**: `Error: ensureTable: table name must start with "__datafn_": "users"`

---

## TV-DRZ-INTERNAL-001 — Drizzle Internal CRUD Roundtrip

- **Description**: Full CRUD cycle on an internal table through the Drizzle adapter
- **Input**:

```typescript
const adapter = drizzleAdapter({ db, dialect: "sqlite" });
await adapter.internal.ensureTable("__datafn_meta", [
  { name: "id", type: "text", primaryKey: true },
  { name: "namespace", type: "text" },
  { name: "nextServerSeq", type: "integer" },
]);

// Create
await adapter.internal.create("__datafn_meta", {
  id: "datafn:nextServerSeq",
  namespace: "datafn",
  nextServerSeq: 1,
});

// FindOne
const row = await adapter.internal.findOne("__datafn_meta", [
  { field: "id", op: "eq", value: "datafn:nextServerSeq" },
]);

// Update
await adapter.internal.update(
  "__datafn_meta",
  [{ field: "id", op: "eq", value: "datafn:nextServerSeq" }],
  { nextServerSeq: 2 },
);

// FindOne again
const updated = await adapter.internal.findOne("__datafn_meta", [
  { field: "id", op: "eq", value: "datafn:nextServerSeq" },
]);

// Delete
const deleted = await adapter.internal.delete("__datafn_meta", [
  { field: "id", op: "eq", value: "datafn:nextServerSeq" },
]);
```

- **Expected Output**:

```json
{ "row": { "id": "datafn:nextServerSeq", "namespace": "datafn", "nextServerSeq": 1 } }
{ "updated": { "id": "datafn:nextServerSeq", "namespace": "datafn", "nextServerSeq": 2 } }
{ "deleted": 1 }
```

## TV-DRZ-INTERNAL-002 — Drizzle Internal FindMany with Ordering

- **Description**: `findMany` returns filtered, ordered results from an internal table
- **Input**:

```typescript
// Insert 3 change records
await adapter.internal.create("__datafn_changes", {
  id: "c1",
  namespace: "datafn",
  serverSeq: 3,
  resource: "todos",
});
await adapter.internal.create("__datafn_changes", {
  id: "c2",
  namespace: "datafn",
  serverSeq: 1,
  resource: "todos",
});
await adapter.internal.create("__datafn_changes", {
  id: "c3",
  namespace: "datafn",
  serverSeq: 2,
  resource: "todos",
});

const rows = await adapter.internal.findMany(
  "__datafn_changes",
  [{ field: "namespace", op: "eq", value: "datafn" }],
  { orderBy: "serverSeq", limit: 2 },
);
```

- **Expected Output**:

```json
[
  { "id": "c2", "serverSeq": 1, "resource": "todos" },
  { "id": "c3", "serverSeq": 2, "resource": "todos" }
]
```

---

## TV-PRS-INTERNAL-001 — Prisma Internal CRUD Roundtrip

- **Description**: Same as TV-DRZ-INTERNAL-001 but using Prisma adapter
- **Input/Output**: Same shape, implemented via `prisma.$queryRaw` / `prisma.$executeRaw`

---

## TV-KYS-INTERNAL-001 — Kysely Internal CRUD Roundtrip

- **Description**: Same as TV-DRZ-INTERNAL-001 but using Kysely adapter
- **Input/Output**: Same shape, implemented via Kysely `sql` raw builder

---

## TV-MEM-INTERNAL-001 — Memory Internal CRUD Roundtrip

- **Description**: Same as TV-DRZ-INTERNAL-001 but using Memory adapter
- **Input/Output**: Same shape, implemented via in-memory store

---

## TV-SERVERSEQ-001 — serverSeq Increments via Internal CRUD

- **Description**: After fix, push operations succeed end-to-end with Drizzle adapter
- **Input**: Standard push mutation through DataFn server using Drizzle adapter
- **Expected Output**: `{ "ok": true, "serverSeq": <N> }` — no `"INTERNAL"` error

---

## TV-CHANGELOG-001 — Change Tracking via Internal CRUD

- **Description**: Changes are recorded in `__datafn_changes` and retrievable by `serverSeq` range
- **Input**: Push a mutation, then pull changes since serverSeq 0
- **Expected Output**: Pull response includes the change record

---

## TV-IDEMP-001 — Idempotency via Internal CRUD

- **Description**: Duplicate mutations return cached result from `__datafn_idempotency`
- **Input**: Push same mutation twice with same `clientId` + `mutationId`
- **Expected Output**: Second push returns same result as first, no duplicate data

---

## TV-SEED-001 — Seed Execution via Internal CRUD

- **Description**: Seed function runs only once, state persisted in `__datafn_seed`
- **Input**: Call seed endpoint twice
- **Expected Output**: Seed data created once, second call is no-op

---

## TV-JT-SCHEMA-001 — `joinTable`/`joinColumns` Schema Validation

- **Description**: Schema with `joinTable` passes validation
- **Input**:

```json
{
  "resources": [
    {
      "name": "todos",
      "fields": [{ "name": "id", "type": "string", "required": true }]
    },
    {
      "name": "categories",
      "fields": [{ "name": "id", "type": "string", "required": true }]
    }
  ],
  "relations": [
    {
      "from": "todos",
      "to": "categories",
      "type": "many-many",
      "relation": "categories",
      "inverse": "todos",
      "joinTable": "todoCategories",
      "joinColumns": { "from": "todoId", "to": "categoryId" }
    }
  ]
}
```

- **Expected Output**: `validateSchema` returns `{ ok: true, ... }`
- **Negative**: `joinTable: 42` → validation error

---

## TV-JT-RESOLVE-001 — Server Uses `joinTable` for Relation CRUD

- **Description**: When `joinTable` is set, relate mutation uses that table name via normal adapter CRUD
- **Input**: `relate` mutation on a relation with `joinTable: "todoCategories"`
- **Expected Output**: `adapter.create({ model: "todoCategories", data: { todoId: "...", categoryId: "..." } })` is called

---

## TV-JT-COLS-001 — Server Uses `joinColumns` for Column Names

- **Description**: Column names in join CRUD match `joinColumns` config
- **Input**: Relate with `joinColumns: { from: "todoId", to: "categoryId" }`
- **Expected Output**: Where clauses use `todoId` and `categoryId`, not `from` and `to`

---

## TV-JT-FALLBACK-001 — Fallback to `__datafn_join_*` via Internal CRUD

- **Description**: Relations without `joinTable` continue to use `__datafn_join_*` through `adapter.internal`
- **Input**: Relate mutation on a relation WITHOUT `joinTable` set
- **Expected Output**: `adapter.internal.create("__datafn_join_todos_categories", ...)` is called

---

## TV-CLI-JT-001 — CLI Generates Named Join Table Migration

- **Description**: Migration output includes DDL for the named join table
- **Input**: Schema with `joinTable: "todoCategories"` and `joinColumns: { from: "todoId", to: "categoryId" }`
- **Expected Output** (Drizzle adapter):

```typescript
export const todoCategories = sqliteTable("todoCategories", {
  todoId: text("todoId").notNull(),
  categoryId: text("categoryId").notNull(),
});
```

---

## TV-CLI-CODEGEN-001 — CLI Generates Join Table Interface

- **Description**: `generateTypes` emits interface for join tables with metadata
- **Input**: Schema with `joinTable: "todoCategories"` and `metadata: [{ name: "order", type: "number" }]`
- **Expected Output** (contains):

```typescript
export interface TodoCategories {
  todoId: string;
  categoryId: string;
  order: number;
}
```
