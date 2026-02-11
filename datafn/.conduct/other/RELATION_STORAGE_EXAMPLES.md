# IndexedDB Relation Storage - Concrete Examples

## Schema Setup

Let's use this example schema:

```typescript
{
  resources: [
    { name: "tasks", fields: [{ name: "id" }, { name: "title" }, { name: "projectId" }] },
    { name: "projects", fields: [{ name: "id" }, { name: "name" }, { name: "ownerId" }] },
    { name: "users", fields: [{ name: "id" }, { name: "name" }] },
    { name: "tags", fields: [{ name: "id" }, { name: "name" }] },
  ],
  relations: [
    {
      from: "tasks",
      relation: "project",
      to: "projects",
      type: "many-one",
      fkField: "projectId",  // FK stored on tasks table
    },
    {
      from: "projects",
      relation: "owner",
      to: "users",
      type: "many-one",
      fkField: "ownerId",  // FK stored on projects table
    },
    {
      from: "tasks",
      relation: "tags",
      to: "tags",
      type: "many-many",  // Requires join table
    },
  ],
}
```

## Example Data

Let's say we have:
- **Task 1** (id: "t1", title: "Build feature", projectId: "p1")
- **Task 2** (id: "t2", title: "Fix bug", projectId: "p1")
- **Project 1** (id: "p1", name: "Web App", ownerId: "u1")
- **User 1** (id: "u1", name: "Alice")
- **Tag 1** (id: "tag1", name: "frontend")
- **Tag 2** (id: "tag2", name: "urgent")

And relationships:
- Task 1 has tags: tag1, tag2
- Task 2 has tags: tag1

---

## How Data is Stored in IndexedDB

### 1. Records Store (Single Store for All Resources)

**Object Store**: `records`
**Key Path**: `["resource", "id"]`

#### Actual Stored Records:

```javascript
// Task records
{ 
  resource: "tasks", 
  id: "t1", 
  title: "Build feature", 
  projectId: "p1"  // ← Foreign key stored here
}
{ 
  resource: "tasks", 
  id: "t2", 
  title: "Fix bug", 
  projectId: "p1" 
}

// Project records
{ 
  resource: "projects", 
  id: "p1", 
  name: "Web App", 
  ownerId: "u1"  // ← Foreign key stored here
}

// User records
{ 
  resource: "users", 
  id: "u1", 
  name: "Alice" 
}

// Tag records
{ 
  resource: "tags", 
  id: "tag1", 
  name: "frontend" 
}
{ 
  resource: "tags", 
  id: "tag2", 
  name: "urgent" 
}
```

**Key Points:**
- All resources share ONE store called `records`
- Each record has `resource` and `id` as part of its composite key
- Foreign keys (like `projectId`, `ownerId`) are stored as regular fields in the record
- To query by resource, IndexedDB uses key range: `[resource, ""]` to `[resource, "\uffff"]`

---

### 2. Join Rows Store (For Many-to-Many Relations Only)

**Object Store**: `join_rows`
**Key Path**: `["relationKey", "from", "to"]`

#### Actual Stored Join Rows:

```javascript
// Task 1 → Tag 1 relationship
{ 
  relationKey: "tasks.tags",  // Format: "fromResource.relationName"
  from: "t1",                  // Source: task ID
  to: "tag1",                  // Target: tag ID
  order: 1                     // Optional metadata
}

// Task 1 → Tag 2 relationship
{ 
  relationKey: "tasks.tags",
  from: "t1",
  to: "tag2",
  order: 2
}

// Task 2 → Tag 1 relationship
{ 
  relationKey: "tasks.tags",
  from: "t2",
  to: "tag1",
  order: 1
}
```

**Key Points:**
- Only many-to-many relations use this store
- `relationKey` format: `"fromResource.relationName"` (e.g., `"tasks.tags"`)
- `from` = source record ID
- `to` = target record ID
- Can store additional metadata (like `order`, `createdAt`, etc.)

---

## Query Examples - Step by Step

### Example 1: Query Task with Project (Many-to-One)

**Query**: Get task "t1" with its project expanded

```javascript
{
  resource: "tasks",
  filters: { id: "t1" },
  select: ["title", "project.*"]  // Expand project relation
}
```

#### Step-by-Step Execution:

1. **Fetch Task Record**:
   ```javascript
   // Storage call: getRecord("tasks", "t1")
   // IndexedDB query: store.get(["tasks", "t1"])
   // Result:
   {
     resource: "tasks",
     id: "t1",
     title: "Build feature",
     projectId: "p1"  // ← Found the FK
   }
   ```

2. **Expand "project" Relation**:
   ```javascript
   // Code detects: relation type = "many-one", forward direction
   // Reads FK from record: projectId = "p1"
   // Storage call: getRecord("projects", "p1")
   // IndexedDB query: store.get(["projects", "p1"])
   // Result:
   {
     resource: "projects",
     id: "p1",
     name: "Web App",
     ownerId: "u1"
   }
   ```

3. **Final Result**:
   ```javascript
   {
     id: "t1",
     title: "Build feature",
     project: {
       id: "p1",
       name: "Web App",
       ownerId: "u1"
     }
   }
   ```

**Storage Operations:**
- ✅ 2 direct key lookups (O(1) each)
- ✅ No scanning needed

---

### Example 2: Query Project with Tasks (One-to-Many Inverse)

**Query**: Get project "p1" with all its tasks

```javascript
{
  resource: "projects",
  filters: { id: "p1" },
  select: ["name", "tasks.*"]  // Expand tasks (inverse relation)
}
```

#### Step-by-Step Execution:

1. **Fetch Project Record**:
   ```javascript
   // Storage call: getRecord("projects", "p1")
   // Result:
   {
     resource: "projects",
     id: "p1",
     name: "Web App",
     ownerId: "u1"
   }
   ```

2. **Expand "tasks" Relation (Inverse)**:
   ```javascript
   // Code detects: relation type = "one-many" (inverse of many-one)
   // Need to find all tasks where projectId = "p1"
   // Storage call: findRecords("tasks", "projectId", "p1")
   
   // IndexedDB operation:
   // 1. Get all tasks: store.getAll(IDBKeyRange.bound(["tasks", ""], ["tasks", "\uffff"]))
   // 2. Filter in memory: records.filter(r => r.projectId === "p1")
   
   // Result:
   [
     { resource: "tasks", id: "t1", title: "Build feature", projectId: "p1" },
     { resource: "tasks", id: "t2", title: "Fix bug", projectId: "p1" }
   ]
   ```

3. **Final Result**:
   ```javascript
   {
     id: "p1",
     name: "Web App",
     tasks: [
       { id: "t1", title: "Build feature", projectId: "p1" },
       { id: "t2", title: "Fix bug", projectId: "p1" }
     ]
   }
   ```

**Storage Operations:**
- ⚠️ 1 direct key lookup (O(1))
- ⚠️ 1 full table scan + filter (O(n)) - **NOT OPTIMIZED**

**Why Not Optimized?**
- No index on `projectId` field
- Must scan all tasks and filter in memory
- Works for small datasets, but slow for large ones

---

### Example 3: Query Task with Tags (Many-to-Many Forward)

**Query**: Get task "t1" with its tags

```javascript
{
  resource: "tasks",
  filters: { id: "t1" },
  select: ["title", "tags.*"]  // Expand tags (many-many)
}
```

#### Step-by-Step Execution:

1. **Fetch Task Record**:
   ```javascript
   // Storage call: getRecord("tasks", "t1")
   // Result:
   {
     resource: "tasks",
     id: "t1",
     title: "Build feature",
     projectId: "p1"
   }
   ```

2. **Get Join Rows for Task**:
   ```javascript
   // Code detects: relation type = "many-many", forward direction
   // Storage call: getJoinRows("tasks.tags", "t1")
   
   // IndexedDB query:
   // store.getAll(IDBKeyRange.bound(
   //   ["tasks.tags", "t1", ""],
   //   ["tasks.tags", "t1", "\uffff"]
   // ))
   
   // Result (efficient key range query):
   [
     { relationKey: "tasks.tags", from: "t1", to: "tag1", order: 1 },
     { relationKey: "tasks.tags", from: "t1", to: "tag2", order: 2 }
   ]
   ```

3. **Extract Tag IDs and Fetch Tags**:
   ```javascript
   // Extract: ["tag1", "tag2"]
   // Storage calls:
   //   getRecord("tags", "tag1")
   //   getRecord("tags", "tag2")
   
   // Results:
   [
     { resource: "tags", id: "tag1", name: "frontend" },
     { resource: "tags", id: "tag2", name: "urgent" }
   ]
   ```

4. **Final Result**:
   ```javascript
   {
     id: "t1",
     title: "Build feature",
     tags: [
       { id: "tag1", name: "frontend" },
       { id: "tag2", name: "urgent" }
     ]
   }
   ```

**Storage Operations:**
- ✅ 1 direct key lookup for task (O(1))
- ✅ 1 efficient key range query for join rows (O(log n))
- ✅ 2 direct key lookups for tags (O(1) each)
- ✅ **OPTIMIZED** - uses IndexedDB key ranges efficiently

---

### Example 4: Query Tag with Tasks (Many-to-Many Inverse)

**Query**: Get tag "tag1" with all tasks that have this tag

```javascript
{
  resource: "tags",
  filters: { id: "tag1" },
  select: ["name", "tasks.*"]  // Expand tasks (inverse many-many)
}
```

#### Step-by-Step Execution:

1. **Fetch Tag Record**:
   ```javascript
   // Storage call: getRecord("tags", "tag1")
   // Result:
   {
     resource: "tags",
     id: "tag1",
     name: "frontend"
   }
   ```

2. **Get Join Rows (Inverse - NOT OPTIMIZED)**:
   ```javascript
   // Code detects: relation type = "many-many", INVERSE direction
   // Storage call: listJoinRows("tasks.tags")
   
   // IndexedDB query:
   // store.getAll(IDBKeyRange.bound(
   //   ["tasks.tags", "", ""],
   //   ["tasks.tags", "\uffff", "\uffff"]
   // ))
   
   // Result: ALL join rows for this relation
   [
     { relationKey: "tasks.tags", from: "t1", to: "tag1", order: 1 },
     { relationKey: "tasks.tags", from: "t1", to: "tag2", order: 2 },
     { relationKey: "tasks.tags", from: "t2", to: "tag1", order: 1 }
   ]
   
   // Then filter in memory:
   // rows.filter(r => r.to === "tag1")
   // Result:
   [
     { relationKey: "tasks.tags", from: "t1", to: "tag1", order: 1 },
     { relationKey: "tasks.tags", from: "t2", to: "tag1", order: 1 }
   ]
   ```

3. **Extract Task IDs and Fetch Tasks**:
   ```javascript
   // Extract: ["t1", "t2"]
   // Storage calls:
   //   getRecord("tasks", "t1")
   //   getRecord("tasks", "t2")
   ```

4. **Final Result**:
   ```javascript
   {
     id: "tag1",
     name: "frontend",
     tasks: [
       { id: "t1", title: "Build feature", projectId: "p1" },
       { id: "t2", title: "Fix bug", projectId: "p1" }
     ]
   }
   ```

**Storage Operations:**
- ✅ 1 direct key lookup for tag (O(1))
- ⚠️ 1 full relation scan + filter (O(n)) - **NOT OPTIMIZED**
- ✅ 2 direct key lookups for tasks (O(1) each)

**Why Not Optimized?**
- IndexedDB key is `[relationKey, from, to]`
- Query optimized for `from` lookups (forward direction)
- Inverse queries need `to` lookups, which requires full scan
- Could be optimized with an additional index on `to`, but not implemented

---

### Example 5: Query with Metadata (Many-to-Many with `#`)

**Query**: Get task "t1" with tags and their join metadata

```javascript
{
  resource: "tasks",
  filters: { id: "t1" },
  select: ["title", "tags.*#"]  // Expand tags with metadata
}
```

#### Step-by-Step Execution:

1. **Fetch Task and Join Rows** (same as Example 3)

2. **Fetch Tag Records** (same as Example 3)

3. **Merge Metadata from Join Rows**:
   ```javascript
   // For each tag, find matching join row and merge metadata
   [
     {
       id: "tag1",
       name: "frontend",
       order: 1  // ← Metadata from join row
     },
     {
       id: "tag2",
       name: "urgent",
       order: 2  // ← Metadata from join row
     }
   ]
   ```

4. **Final Result**:
   ```javascript
   {
     id: "t1",
     title: "Build feature",
     tags: [
       { id: "tag1", name: "frontend", order: 1 },
       { id: "tag2", name: "urgent", order: 2 }
     ]
   }
   ```

---

## Summary Table

| Relation Type | Direction | Storage Location | Query Method | Performance |
|--------------|-----------|------------------|--------------|-------------|
| **Many-to-One** | Forward | FK in `records` | Direct key lookup | ✅ O(1) |
| **One-to-Many** | Inverse | FK in `records` | Full scan + filter | ⚠️ O(n) |
| **Many-to-Many** | Forward | `join_rows` store | Key range query | ✅ O(log n) |
| **Many-to-Many** | Inverse | `join_rows` store | Full scan + filter | ⚠️ O(n) |

## Key Takeaways

1. **Single Records Store**: All resources share one `records` store with composite key `[resource, id]`

2. **Foreign Keys**: Many-one and one-many relations store FKs as regular fields in records

3. **Join Table**: Many-many relations use separate `join_rows` store with key `[relationKey, from, to]`

4. **Forward Queries Optimized**: 
   - Many-one: Direct FK lookup ✅
   - Many-many forward: Key range on `[relationKey, fromId, ...]` ✅

5. **Inverse Queries Not Optimized**:
   - One-many: Full table scan + filter ⚠️
   - Many-many inverse: Full relation scan + filter ⚠️

6. **No FK Indices**: Foreign key fields don't have IndexedDB indices, causing O(n) scans

7. **Metadata Support**: Join rows can store additional fields that get merged into results
