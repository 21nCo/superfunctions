# DataFn Architecture Explanation

## 1. Client: Cursors and Hydration State

### Cursors

**What are cursors?**
Cursors in DataFn are string values representing the server's sequence number (serverSeq) for tracking sync state. They are base-10 integer strings that monotonically increase and indicate how far the client has synced with the server.

**Key characteristics:**
- **Per-resource cursors**: Each table/resource can have its own cursor (e.g., `"task": "5"`)
- **Global cursor**: A special `__global_cursor__` key tracks the maximum cursor across all resources
- **Monotonic**: Cursors only move forward - they never decrease (enforced by `setCursorMonotonically`)
- **Format**: String representation of integers (e.g., `"10"`, `"25"`)

**How cursors work:**
1. **During clone**: Server returns cursors per resource in the clone response
   ```typescript
   { ok: true, data: {...}, cursors: { "task": "5", "goal": "3" } }
   ```
   The client stores these and calculates a global cursor (max of all resource cursors).

2. **During pull**: Client sends current cursor to server, server returns changes since that cursor and a `nextCursor`
   ```typescript
   // Request: { clientId: "...", cursor: "10" }
   // Response: { ok: true, changes: [...], nextCursor: "20" }
   ```
   The client updates the global cursor only if `nextCursor > currentCursor` (monotonic enforcement).

3. **During push**: Server may return a cursor indicating its current state, which can trigger a pull if the client is behind.

**Persistence:**
- Stored in the storage adapter's "meta" store
- In IndexedDB: stored as `{ type: "cursor", key: resourceName, value: cursorString }`
- In MemoryStorage: stored in a `Map<string, string>`
- Accessed via `storage.getCursor(resource)` and `storage.setCursor(resource, cursor)`

**Code locations:**
- Definition: `client/src/sync/apply.ts` (GLOBAL_CURSOR_KEY, setCursorMonotonically)
- Usage: `client/src/sync/engine.ts` (pull/push logic)
- Storage interface: `client/src/storage.ts` (DatafnStorageAdapter)

### Hydration State

**What is hydration state?**
Hydration state tracks whether a table has been fully loaded from the server into local storage. It's a state machine with three states:

1. **`notStarted`**: Table hasn't been cloned yet (default state)
2. **`hydrating`**: Clone operation is in progress for this table
3. **`ready`**: Table has been fully cloned and is available for local-first queries

**How hydration state is calculated:**
The state transitions happen automatically during sync operations:

```typescript
// During clone application (applyCloneResult):
await storage.setHydrationState(resource, "hydrating");  // Before applying records
// ... upsert all records ...
await storage.setHydrationState(resource, "ready");       // After applying records
```

**State transitions:**
- `notStarted` → `hydrating`: When clone starts applying records for a resource
- `hydrating` → `ready`: When all records from clone have been applied
- States are **per-resource** (each table has its own hydration state)

**How hydration state is persisted:**
- Stored in the storage adapter's "meta" store (same as cursors)
- In IndexedDB: stored as `{ type: "hydration", key: resourceName, value: state }`
- In MemoryStorage: stored in a `Map<string, DatafnHydrationState>`
- Default value: `"notStarted"` if not set
- Accessed via `storage.getHydrationState(resource)` and `storage.setHydrationState(resource, state)`

**Usage in query routing:**
The hydration state determines whether queries execute locally or remotely:

```typescript
const hydrationState = await storage.getHydrationState(resource);

if (hydrationState === "ready" && schema) {
  // Execute locally against storage
  return await executeLocalQuery(storage, schema, query);
} else {
  // Remote fallback for: notStarted, hydrating, or missing resource
  return await remote.query(query);
}
```

**Code locations:**
- Definition: `client/src/storage.ts` (DatafnHydrationState type)
- Application: `client/src/sync/apply.ts` (applyCloneResult)
- Query routing: `client/src/query.ts` (executeQuery)
- Storage implementations: `client/src/adapters/memoryStorage.ts`, `client/src/adapters/indexedDbStorage.ts`

---

## 2. Server: Joins/Relations and Table Schema

### How Joins (Relations) Work for Queries

DataFn supports three types of relations, each handled differently:

#### 1. **Many-One Relations** (`many-one`)
- **Storage**: Foreign key field on the "from" resource (e.g., `task.goalId`)
- **Query behavior**:
  - **Ids-only** (`select: ["goal"]`): Returns the FK value directly
  - **Expanded** (`select: ["goal.*"]`): Looks up the related record by FK and returns it
- **Example**: `task.goalId` → `goal` record

```typescript
// Schema: { from: "task", to: "goal", type: "many-one", relation: "goal" }
// Query: { resource: "task", select: ["goal.*"] }
// Result: { id: "task:1", goal: { id: "goal:1", label: "..." } }
```

#### 2. **One-Many Relations** (`one-many`)
- **Storage**: Foreign key field on the "to" resource pointing back (e.g., `task.goalId`)
- **Query behavior**:
  - **Ids-only** (`select: ["tasks"]`): Filters records where FK matches, returns array of IDs
  - **Expanded** (`select: ["tasks.*"]`): Returns array of related records
- **Example**: `goal` → `task[]` (via `task.goalId`)

```typescript
// Schema: { from: "goal", to: "task", type: "one-many", relation: "tasks", inverse: "goal" }
// Query: { resource: "goal", select: ["tasks.*"] }
// Result: { id: "goal:1", tasks: [{ id: "task:1", ... }, { id: "task:2", ... }] }
```

#### 3. **Many-Many Relations** (`many-many`)
- **Storage**: Join table with `from` and `to` columns, plus optional metadata
- **Join table naming**: `__datafn_join_{from}_{relation}` (e.g., `__datafn_join_node_properties`)
- **Query behavior**:
  - **Ids-only** (`select: ["properties"]`): Returns array of IDs from join rows
  - **Expanded** (`select: ["properties.*"]`): Returns array of related records
  - **Join rows** (`select: ["properties.#"]`): Returns join rows with metadata
  - **Expanded with metadata** (`select: ["properties.*#"]`): Returns records with `$relation_metadata`
- **Example**: `node` ↔ `property` (many-to-many with metadata like `value`)

```typescript
// Schema: { from: "node", to: "property", type: "many-many", relation: "properties", metadata: [{ name: "value", type: "any" }] }
// Query: { resource: "node", select: ["properties.*#"] }
// Result: { 
//   id: "node:1", 
//   properties: [
//     { id: "property:1", label: "...", $relation_metadata: { value: "..." } }
//   ]
// }
```

**Join table structure:**
```typescript
{
  from: string,  // ID of source record
  to: string,    // ID of target record
  ...metadata    // Additional fields from relation.metadata
}
```

**Relation discovery in queries:**
The server analyzes query `select`, `filters`, `groupBy`, and `having` to discover which relations need to be loaded:

1. **From select tokens**: Parses tokens like `"goal.*"`, `"tasks.#"` to find relations
2. **From filter paths**: Traverses dot-paths like `"goal.label"` to discover relations
3. **From relation quantifiers**: Handles `filters: { tags: { $any: {...} } }` syntax
4. **Pre-loads data**: Creates a `DbDataStore` that pre-loads all necessary resources and join tables

**Code locations:**
- Relation expansion: `server/src/execution/query/select.ts` (materializeSelect, expandRelation, getRelationIds)
- Join row handling: `server/src/execution/query/select.ts` (getJoinRows, sortJoinRows)
- Data store: `server/src/execution/db-store.ts` (DbDataStore.forQuery - discovers and pre-loads relations)
- Relation mutations: `server/src/execution/mutation/relations.ts` (executeRelate, executeUnrelate)

### How Table Schema Works

**Schema Definition:**
The table schema is defined in the DFQL schema format (JSON), as seen in `table-schema-sample.json`. It includes:
- **Resources**: Table definitions with fields, indices, permissions
- **Relations**: Relationship definitions between resources

**Schema Auto-Generation vs Manual:**
The schema is **manually defined by consumers** (not auto-generated). Here's how it works:

1. **Consumer provides schema**: When creating a DataFn server, you pass a schema object:
   ```typescript
   const server = await createDatafnServer({
     schema: {
       resources: [...],
       relations: [...]
     },
     db: adapter
   });
   ```

2. **Schema validation**: The server validates the schema at startup using `validateSchema()` from `@datafn/core`

3. **Database adapter initialization**: The database adapter (if it has an `initialize()` method) is called, but **DataFn does not auto-generate database tables from the schema**. The adapter is responsible for:
   - Creating tables if they don't exist
   - Managing migrations
   - Setting up indexes

4. **Schema usage**: The validated schema is used throughout query/mutation execution to:
   - Validate field types and constraints
   - Resolve relations
   - Apply permissions
   - Generate TypeScript types (via CLI codegen)

**Important distinction:**
- **DFQL Schema** (DataFn schema): Defines the logical structure, fields, relations - manually provided
- **Database Schema** (SQL tables): Physical database structure - managed by the database adapter (e.g., Drizzle, Sequelize)

The database adapter must ensure the physical database schema matches the logical DFQL schema. This is typically done:
- **Manually**: Developer creates migrations/DDL scripts
- **Via CLI tools**: Some adapters may provide schema generation utilities (like `generateDrizzleSchemaFile` in `@superfunctions/cli`)

**Relation types in schema:**
From `table-schema-sample.json`, you can see various relation types:

1. **Self-referential** (`node` → `node`): `many-one` with `parent`/`children`
2. **Many-many with metadata** (`node` → `property`): Includes metadata fields like `value`
3. **One-many** (`goal` → `task`): Standard parent-child
4. **Hierarchical tree** (`goal` → `goal`): `htree` type (special case)
5. **Multi-source many-many** (`collection` → `[node, goal, event, task]`): `from` can be an array

**Code locations:**
- Schema validation: `@datafn/core` (validateSchema)
- Server initialization: `server/src/server.ts` (createDatafnServer)
- Type generation: `datafn/cli/src/codegen.ts` (generateTypes)
- Database adapter: `packages/db/src/adapters/drizzle/index.ts` (DrizzleAdapter)

---

## Summary

**Client:**
- **Cursors**: Monotonic sequence numbers tracking sync progress, persisted per-resource and globally
- **Hydration State**: Three-state machine (`notStarted` → `hydrating` → `ready`) tracking local data availability, persisted in meta store

**Server:**
- **Relations**: Three types (many-one, one-many, many-many) with different storage and query behaviors
- **Schema**: Manually defined by consumers, validated at startup, used for validation and relation resolution (not auto-generated into database tables)
