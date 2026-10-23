# TEST VECTORS: Schema Index Validation & Type-Safe Schema Declarations

---

## TV-VAL-001: Reject invalid index field in indices.base

- **Description:** `validateSchema()` rejects a schema where `indices.base` contains a field name that doesn't match any declared field.
- **Input:**
```json
{
  "resources": [
    {
      "name": "todos",
      "version": 1,
      "fields": [
        { "name": "id", "type": "string", "required": true },
        { "name": "createdAt", "type": "date", "required": true }
      ],
      "indices": { "base": ["created_at"] }
    }
  ]
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {
    "code": "SCHEMA_INVALID",
    "message": "Invalid schema: index field \"created_at\" in indices.base does not match any field in resource \"todos\". Available fields: id, createdAt",
    "context": { "path": "resources.todos.indices.base" }
  }
}
```

---

## TV-VAL-002: Reject index field with typo

- **Description:** A field name with a simple typo is rejected.
- **Input:**
```json
{
  "resources": [
    {
      "name": "users",
      "version": 1,
      "fields": [
        { "name": "id", "type": "string", "required": true },
        { "name": "email", "type": "string", "required": true },
        { "name": "firstName", "type": "string", "required": true }
      ],
      "indices": { "base": ["email", "firstname"] }
    }
  ]
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {
    "code": "SCHEMA_INVALID",
    "message": "Invalid schema: index field \"firstname\" in indices.base does not match any field in resource \"users\". Available fields: id, email, firstName",
    "context": { "path": "resources.users.indices.base" }
  }
}
```

---

## TV-VAL-003: Accept valid index fields

- **Description:** `validateSchema()` accepts a schema where all index fields match declared field names.
- **Input:**
```json
{
  "resources": [
    {
      "name": "event",
      "version": 1,
      "fields": [
        { "name": "id", "type": "string", "required": true },
        { "name": "type", "type": "string", "required": true },
        { "name": "createdAt", "type": "date", "required": true }
      ],
      "indices": { "base": ["type", "createdAt"] }
    }
  ]
}
```
- **Expected output:**
```json
{
  "ok": true,
  "value": {
    "resources": [
      {
        "name": "event",
        "version": 1,
        "fields": [
          { "name": "id", "type": "string", "required": true },
          { "name": "type", "type": "string", "required": true },
          { "name": "createdAt", "type": "date", "required": true }
        ],
        "indices": { "base": ["type", "createdAt"], "search": [], "vector": [] }
      }
    ],
    "relations": []
  }
}
```

---

## TV-VAL-004: Reject invalid field in indices.search

- **Description:** Validation applies to `indices.search` as well.
- **Input:**
```json
{
  "resources": [
    {
      "name": "posts",
      "version": 1,
      "fields": [
        { "name": "id", "type": "string", "required": true },
        { "name": "title", "type": "string", "required": true },
        { "name": "body", "type": "string", "required": true }
      ],
      "indices": { "base": ["title"], "search": ["content"] }
    }
  ]
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {
    "code": "SCHEMA_INVALID",
    "message": "Invalid schema: index field \"content\" in indices.search does not match any field in resource \"posts\". Available fields: id, title, body",
    "context": { "path": "resources.posts.indices.search" }
  }
}
```

---

## TV-VAL-005: Reject invalid field in indices.vector

- **Description:** Validation applies to `indices.vector` as well.
- **Input:**
```json
{
  "resources": [
    {
      "name": "docs",
      "version": 1,
      "fields": [
        { "name": "id", "type": "string", "required": true },
        { "name": "embedding", "type": "array", "required": true }
      ],
      "indices": { "vector": ["embeddings"] }
    }
  ]
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {
    "code": "SCHEMA_INVALID",
    "message": "Invalid schema: index field \"embeddings\" in indices.vector does not match any field in resource \"docs\". Available fields: id, embedding",
    "context": { "path": "resources.docs.indices.vector" }
  }
}
```

---

## TV-VAL-006: Reject invalid field in shorthand indices array

- **Description:** The shorthand `indices: ["invalidField"]` is normalized then validated.
- **Input:**
```json
{
  "resources": [
    {
      "name": "items",
      "version": 1,
      "fields": [
        { "name": "id", "type": "string", "required": true },
        { "name": "status", "type": "string", "required": true }
      ],
      "indices": ["invalid_field"]
    }
  ]
}
```
- **Expected output:**
```json
{
  "ok": false,
  "error": {
    "code": "SCHEMA_INVALID",
    "message": "Invalid schema: index field \"invalid_field\" in indices.base does not match any field in resource \"items\". Available fields: id, status",
    "context": { "path": "resources.items.indices.base" }
  }
}
```

---

## TV-VAL-007: Accept schema with no indices

- **Description:** A resource with no indices continues to pass validation.
- **Input:**
```json
{
  "resources": [
    {
      "name": "simple",
      "version": 1,
      "fields": [
        { "name": "id", "type": "string", "required": true }
      ]
    }
  ]
}
```
- **Expected output:**
```json
{
  "ok": true,
  "value": {
    "resources": [
      {
        "name": "simple",
        "version": 1,
        "fields": [{ "name": "id", "type": "string", "required": true }],
        "indices": { "base": [], "search": [], "vector": [] }
      }
    ],
    "relations": []
  }
}
```

---

## TV-CLI-001: Validate command succeeds on valid schema

- **Description:** `datafn validate` exits 0 and prints success message for a valid schema.
- **Input:** (valid schema file at discoverable path)
- **Expected output:**
```
✓ Schema is valid: <path>
```
- **Expected exit code:** 0

---

## TV-CLI-002: Validate command fails on invalid schema

- **Description:** `datafn validate` exits 1 and prints error for a schema with invalid index fields.
- **Input:** (schema file with `indices: { base: ["nonexistent"] }`)
- **Expected output:**
```
✗ Error: Invalid schema: index field "nonexistent" in indices.base does not match any field in resource "<name>". Available fields: ...
```
- **Expected exit code:** 1

---

## TV-TYP-001: defineSchema returns DatafnSchema at runtime

- **Description:** `defineSchema()` returns the input object typed as `DatafnSchema`.
- **Input:**
```ts
import { defineSchema } from "@datafn/core";

const schema = defineSchema({
  resources: [
    {
      name: "todos",
      version: 1,
      fields: [
        { name: "id", type: "string", required: true },
        { name: "text", type: "string", required: true },
      ],
    },
  ],
});
```
- **Expected output:** `schema` is a valid `DatafnSchema` object. `schema.resources[0].name === "todos"`.

---

## TV-TYP-002: defineSchema rejects invalid index field at compile time

- **Description:** TypeScript produces a compile error when an index field doesn't match any declared field name.
- **Input:**
```ts
import { defineSchema } from "@datafn/core";

defineSchema({
  resources: [
    {
      name: "todos",
      version: 1,
      fields: [
        { name: "id", type: "string", required: true },
        { name: "createdAt", type: "date", required: true },
      ],
      indices: { base: ["created_at"] },
      //                 ^^^^^^^^^^^^  TS error expected
    },
  ],
});
```
- **Expected output:** TypeScript compile error. `"created_at"` is not assignable to `"id" | "createdAt"`.

---

## TV-TYP-003: defineSchema accepts valid index fields at compile time

- **Description:** TypeScript compiles without error when all index fields match declared field names.
- **Input:**
```ts
import { defineSchema } from "@datafn/core";

defineSchema({
  resources: [
    {
      name: "todos",
      version: 1,
      fields: [
        { name: "id", type: "string", required: true },
        { name: "createdAt", type: "date", required: true },
        { name: "status", type: "string", required: true },
      ],
      indices: { base: ["createdAt", "status"] },
    },
  ],
});
```
- **Expected output:** No TypeScript errors.

---

## TV-TYP-004: Plain DatafnSchema type annotation still works

- **Description:** Users can still use `DatafnSchema` type directly without `defineSchema()`.
- **Input:**
```ts
import type { DatafnSchema } from "@datafn/core";

const schema: DatafnSchema = {
  resources: [
    {
      name: "todos",
      version: 1,
      fields: [
        { name: "id", type: "string", required: true },
      ],
    },
  ],
};
```
- **Expected output:** Compiles without errors. `validateSchema(schema)` works as before.
