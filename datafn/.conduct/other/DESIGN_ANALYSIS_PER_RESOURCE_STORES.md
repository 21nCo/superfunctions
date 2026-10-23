# Design Analysis: Per-Resource Stores + FK Indices + Separate Join Stores

## Proposed Design

1. **One store per resource** (instead of single "records" store)
2. **Index foreign keys** for many-one/one-many relations
3. **Separate join stores per many-to-many relation** (like SQL join tables)

## Schema Complexity Analysis

From `table-schema-sample.json`, we have:

### Resources (7 total):
- `node`, `goal`, `task`, `collection`, `event`, `view`, `property`

### Relations Breakdown:

#### Many-to-One / One-to-Many (FK-based):
- `node.parent` → `node` (many-one, FK: `parentId`)
- `goal.tasks` → `task` (one-many, FK: `goalId` on task)
- `task.subtasks` → `task` (one-many, FK: `parentId` on task)
- `collection.views` → `view` (one-many, FK: `collectionId` on view)
- `collection.derivations` → `collection` (one-many, FK: `baseId` on collection)

#### Many-to-Many (Require Join Tables):

**Simple (1:1 resource pair):**
- `collection.properties` → `property` (many-many)
  - **Store**: `join_collection_property`

**Polymorphic (Multiple sources/targets):**

1. **`properties` relation:**
   - from: `["node", "task", "goal", "event"]`
   - to: `"property"`
   - **Stores needed**: 4
     - `join_node_property`
     - `join_task_property`
     - `join_goal_property`
     - `join_event_property`

2. **`items` relation:**
   - from: `"collection"`
   - to: `["node", "goal", "event", "task"]`
   - **Stores needed**: 4
     - `join_collection_node`
     - `join_collection_goal`
     - `join_collection_event`
     - `join_collection_task`

3. **`links` relation (most complex):**
   - from: `["node", "goal", "task", "event"]`
   - to: `["node", "goal", "task", "event"]`
   - **Stores needed**: 16 (4×4 matrix)
     - `join_node_node`
     - `join_node_goal`
     - `join_node_task`
     - `join_node_event`
     - `join_goal_node`
     - `join_goal_goal`
     - `join_goal_task`
     - `join_goal_event`
     - `join_task_node`
     - `join_task_goal`
     - `join_task_task`
     - `join_task_event`
     - `join_event_node`
     - `join_event_goal`
     - `join_event_task`
     - `join_event_event`

**Total Join Stores**: 1 + 4 + 4 + 16 = **25 join stores**

**Total Stores (Resources + Joins)**: 7 + 25 = **32 stores**

---

## Proposed IndexedDB Structure

### Resource Stores (7 stores)

```javascript
// Store: "node"
// Key: "id"
// Indices:
//   - "by_parentId" (for node.parent relation - one-many inverse)
//   - "by_type" (from schema indices.base)
//   - "by_contentType"
//   - "by_metaType"

// Store: "goal"
// Key: "id"
// Indices:
//   - "by_status" (from schema indices.base)
//   - "by_type"

// Store: "task"
// Key: "id"
// Indices:
//   - "by_goalId" (for goal.tasks relation - one-many)
//   - "by_parentId" (for task.subtasks relation - one-many)
//   - "by_status" (from schema indices.base)
//   - "by_date"

// Store: "collection"
// Key: "id"
// Indices:
//   - "by_label" (from schema indices.base)

// Store: "event"
// Key: "id"
// Indices:
//   - "by_label" (from schema indices.base)

// Store: "view"
// Key: "id"
// Indices:
//   - "by_collectionId" (for collection.views relation - one-many)
//   - "by_label"

// Store: "property"
// Key: "id"
// Indices:
//   - "by_label"
```

### Join Stores (25 stores)

```javascript
// Example: join_node_property
// Key: ["from", "to"] (composite)
// Indices:
//   - "by_from" (for forward queries: node → properties)
//   - "by_to" (for inverse queries: property → nodes)
//   - "by_value" (from relation.indices if specified)

// Example: join_node_node (for links relation)
// Key: ["from", "to"]
// Indices:
//   - "by_from"
//   - "by_to"
//   - "by_linkTags" (if metadata needs indexing)
```

---

## Performance Analysis

### Current Implementation (Single Store)

| Query Type | Current Performance | With 100K Records |
|------------|-------------------|-------------------|
| **Many-to-One (forward)** | O(1) - Direct FK lookup | ✅ O(1) |
| **One-to-Many (inverse)** | O(n) - Full scan + filter | ❌ O(100K) - Slow |
| **Many-to-Many (forward)** | O(log n) - Key range | ✅ O(log n) |
| **Many-to-Many (inverse)** | O(n) - Full scan + filter | ❌ O(100K) - Slow |
| **Filter by indexed field** | O(n) - Full scan | ❌ O(100K) - Slow |

### Proposed Implementation (Per-Resource + Indices)

| Query Type | Proposed Performance | With 100K Records |
|------------|---------------------|-------------------|
| **Many-to-One (forward)** | O(1) - Direct FK lookup | ✅ O(1) |
| **One-to-Many (inverse)** | O(log n) - Index on FK | ✅ O(log 100K) ≈ 17 ops |
| **Many-to-Many (forward)** | O(log n) - Index on `from` | ✅ O(log n) |
| **Many-to-Many (inverse)** | O(log n) - Index on `to` | ✅ O(log n) |
| **Filter by indexed field** | O(log n) - Index lookup | ✅ O(log n) |

**Improvement**: All queries become O(log n) or better, even with 100K+ records.

---

## Implementation Considerations

### ✅ Advantages

1. **Performance**: All relation queries become O(log n) with proper indices
2. **Scalability**: Handles 100K+ records efficiently
3. **SQL-like**: Familiar pattern for developers coming from SQL
4. **Isolation**: Each resource has its own store, easier to manage
5. **Index Flexibility**: Can create resource-specific indices
6. **Inverse Query Optimization**: Both forward and inverse many-to-many queries are fast

### ⚠️ Challenges

1. **Schema Migration Complexity**:
   - Need to create stores when resources are added
   - Need to create join stores when relations are added
   - Need to handle store deletion (rare, but possible)
   - IndexedDB versioning becomes critical

2. **Polymorphic Relations**:
   - For `links` relation: Need to determine which of 16 stores to query
   - Query routing logic: `if (from === "node" && to === "goal") use join_node_goal`
   - More complex than current single `join_rows` store

3. **Store Count**:
   - 32 stores total (7 resources + 25 joins)
   - IndexedDB typically supports 100+ stores, so this is fine
   - But schema changes could add more stores over time

4. **Initialization Overhead**:
   - Need to create all stores in `onupgradeneeded`
   - More complex upgrade logic
   - Need to handle partial upgrades gracefully

5. **Query Routing for Polymorphic Relations**:
   ```javascript
   // Current (simple):
   const relationKey = `${relation.from}.${relation.relation}`;
   const rows = await storage.getJoinRows(relationKey, fromId);
   
   // Proposed (complex for polymorphic):
   function getJoinStoreName(from, to, relationName) {
     if (Array.isArray(from) && Array.isArray(to)) {
       // Polymorphic: need to determine actual types
       return `join_${actualFrom}_${actualTo}`;
     }
     const fromRes = Array.isArray(from) ? actualFrom : from;
     const toRes = Array.isArray(to) ? actualTo : to;
     return `join_${fromRes}_${toRes}`;
   }
   ```

6. **Backward Compatibility**:
   - Existing databases use single "records" store
   - Need migration path from old to new structure
   - Could be complex for users with existing data

---

## Query Examples with Proposed Design

### Example 1: One-to-Many (Inverse) - OPTIMIZED

**Query**: Get goal "g1" with all its tasks

```javascript
// Current: O(n) - scans all tasks
findRecords("task", "goalId", "g1")  // Full scan + filter

// Proposed: O(log n) - uses index
// Store: "task"
// Index: "by_goalId"
// Query: index.getAll("g1")  // Direct index lookup
```

**Performance**: 100K tasks → 17 index lookups instead of 100K scans

---

### Example 2: Many-to-Many Inverse - OPTIMIZED

**Query**: Get property "p1" with all nodes that have it

```javascript
// Current: O(n) - scans all join rows
listJoinRows("node.properties")  // Gets all
  .filter(r => r.to === "p1")     // Filters in memory

// Proposed: O(log n) - uses index
// Store: "join_node_property"
// Index: "by_to"
// Query: index.getAll("p1")  // Direct index lookup
```

**Performance**: 100K join rows → 17 index lookups instead of 100K scans

---

### Example 3: Polymorphic Links - COMPLEX

**Query**: Get node "n1" with all links (could be to node/goal/task/event)

```javascript
// Need to query 4 different stores:
const nodeLinks = await getJoinRows("join_node_node", "n1");
const goalLinks = await getJoinRows("join_node_goal", "n1");
const taskLinks = await getJoinRows("join_node_task", "n1");
const eventLinks = await getJoinRows("join_node_event", "n1");

// Then merge results
const allLinks = [...nodeLinks, ...goalLinks, ...taskLinks, ...eventLinks];
```

**Complexity**: More queries, but each is O(log n), so total is still O(log n) per store type.

---

## Recommendation

### ✅ **YES, this design will work and is highly recommended for performance**

**Reasons:**

1. **Performance Gains**: All queries become O(log n) or O(1), critical for 100K+ records
2. **Scalability**: Handles large datasets efficiently
3. **Industry Standard**: Matches SQL database patterns developers expect
4. **Index Flexibility**: Can optimize for specific query patterns per resource

### Implementation Strategy:

1. **Phase 1: Per-Resource Stores**
   - Create one store per resource
   - Migrate from single "records" store
   - Add indices for schema-defined fields

2. **Phase 2: FK Indices**
   - Add indices on all foreign key fields
   - Optimize one-many inverse queries

3. **Phase 3: Separate Join Stores**
   - Create join stores for each many-to-many relation
   - Handle polymorphic relations (create stores for all combinations)
   - Add indices on both `from` and `to` for bidirectional queries

4. **Phase 4: Query Routing**
   - Implement logic to route polymorphic queries to correct stores
   - Handle cases where `from`/`to` are arrays

### Migration Path:

```javascript
// Migration from old to new structure
async function migrateToPerResourceStores(oldDb, newDb) {
  // 1. Read all records from old "records" store
  const allRecords = await oldDb.getAll("records");
  
  // 2. Group by resource
  const byResource = {};
  for (const record of allRecords) {
    const resource = record.resource;
    if (!byResource[resource]) byResource[resource] = [];
    byResource[resource].push(record);
  }
  
  // 3. Write to new per-resource stores
  for (const [resource, records] of Object.entries(byResource)) {
    const store = newDb.transaction(resource, "readwrite").objectStore(resource);
    for (const record of records) {
      await store.put(record);  // Remove "resource" field, use store name
    }
  }
}
```

### Edge Cases to Handle:

1. **Polymorphic Relation Queries**: Need runtime type detection
2. **Schema Changes**: Handle store creation/deletion on schema updates
3. **Partial Data**: Handle cases where some stores exist but others don't
4. **Index Creation**: Create indices based on schema definitions
5. **Backward Compatibility**: Support both old and new formats during transition

---

## Conclusion

**This design is excellent for performance and will scale to 100K+ records efficiently.**

The main trade-off is increased complexity in:
- Schema migration logic
- Query routing for polymorphic relations
- Store initialization

But the performance gains (O(n) → O(log n) for most queries) make it worth it for production-scale applications.
