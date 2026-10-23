# ApiFn — Test Vectors

## Conventions

- All test vectors use deterministic inputs and expected outputs.
- JSON is used for all structured data.
- `→` denotes "produces" / "returns".
- Negative variants are prefixed with `NEG-`.

---

## TV-CORE-001: Project Scaffolding

**Description**: Verify all packages build successfully.

**Input**: Run `npm run build` in each package directory.

**Expected**: Exit code 0 for all packages. Each `dist/` contains `.js` and `.d.ts` files.

---

## TV-CORE-002: Core Types Exported

**Description**: Verify all types are importable.

**Input**:
```typescript
import type {
  IntrospectOptions,
  IntrospectedRoute,
  SchemaDescriptor,
  OpenAPIGenerateOptions,
  OpenAPIDocument,
  DiffResult,
  DiffEntry,
  ValidationError
} from "@apifn/core";
```

**Expected**: Compiles without errors.

---

## TV-CORE-003: Config File Loading

**Input**:
```typescript
// apifn.config.ts
import { defineConfig } from "@apifn/cli";
export default defineConfig({
  openapi: { info: { title: "Test", version: "1.0.0" } },
  router: "./src/router.ts",
});
```

**Expected**: Config loaded and validated. `config.openapi.info.title === "Test"`.

**NEG-TV-CORE-003**: Config with unknown field `{ openapi: { info: { title: 123 } } }` → validation error: "info.title must be a string".

---

## TV-INTRO-001: Basic Route Introspection

**Input**:
```typescript
const router = createRouter({
  routes: [
    { method: "GET", path: "/users", handler: async () => Response.json([]) },
    { method: "POST", path: "/users", handler: async () => Response.json({}, { status: 201 }) },
  ],
});
const result = introspectRouter(router);
```

**Expected**:
```json
[
  { "method": "GET", "path": "/users", "parameters": [], "responses": { "200": { "description": "Success" } }, "meta": {} },
  { "method": "POST", "path": "/users", "parameters": [], "responses": { "200": { "description": "Success" } }, "meta": {} }
]
```

---

## TV-INTRO-002: Route Count Matches

**Input**: Router with 5 routes.

**Expected**: `introspectRouter(router).length === 5`.

---

## TV-INTRO-003: Schema Descriptor Parsing — Zod

**Input**:
```typescript
import { z } from "zod";
import { apiSchema } from "@apifn/core";

const router = createRouter({
  routes: [{
    method: "POST",
    path: "/users",
    handler: async () => Response.json({}),
    meta: apiSchema({
      summary: "Create user",
      operationId: "createUser",
      tags: ["users"],
      body: z.object({ name: z.string(), email: z.string().email() }),
      responses: {
        201: { description: "Created", schema: z.object({ id: z.string(), name: z.string() }) },
        400: { description: "Validation error" },
      },
    }),
  }],
});
```

**Expected**:
```json
[{
  "method": "POST",
  "path": "/users",
  "operationId": "createUser",
  "summary": "Create user",
  "tags": ["users"],
  "parameters": [],
  "requestBody": {
    "required": true,
    "content": {
      "application/json": {
        "schema": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "email": { "type": "string", "format": "email" }
          },
          "required": ["name", "email"]
        }
      }
    }
  },
  "responses": {
    "201": {
      "description": "Created",
      "content": {
        "application/json": {
          "schema": {
            "type": "object",
            "properties": {
              "id": { "type": "string" },
              "name": { "type": "string" }
            },
            "required": ["id", "name"]
          }
        }
      }
    },
    "400": { "description": "Validation error" }
  }
}]
```

---

## TV-INTRO-004: Schema Descriptor Parsing — TypeBox

**Input**:
```typescript
import { Type } from "@sinclair/typebox";

const router = createRouter({
  routes: [{
    method: "GET",
    path: "/items",
    handler: async () => Response.json([]),
    meta: apiSchema({
      summary: "List items",
      query: { limit: Type.Number({ minimum: 1, maximum: 100 }) },
      responses: {
        200: {
          description: "Item list",
          schema: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
        },
      },
    }),
  }],
});
```

**Expected**: Query parameter `limit` extracted as `in: "query"` with schema `{ type: "number", minimum: 1, maximum: 100 }`. Response schema for 200 is array of objects.

---

## TV-INTRO-005: Path Parameter Conversion

**Input**: Route with path `/orders/:orderId/items/:itemId`

**Expected**:
- `introspectedRoute.path === "/orders/{orderId}/items/{itemId}"`
- `introspectedRoute.parameters` includes:
  - `{ name: "orderId", in: "path", required: true, schema: { type: "string" } }`
  - `{ name: "itemId", in: "path", required: true, schema: { type: "string" } }`

---

## TV-INTRO-006: Include/Exclude Filtering

**Input**: Router with routes `/api/v1/users`, `/api/v1/orders`, `/internal/health`, `/internal/metrics`.

- `introspectRouter(router, { include: ["/api"] })` → 2 routes
- `introspectRouter(router, { exclude: ["/internal"] })` → 2 routes
- `introspectRouter(router, { include: ["/api"], exclude: ["/api/v1/orders"] })` → 1 route

---

## TV-INTRO-007: Routes Without Descriptors

**Input**: Route with `meta: undefined`

**Expected**:
```json
{
  "method": "GET",
  "path": "/health",
  "parameters": [],
  "responses": { "200": { "description": "Success" } },
  "meta": {}
}
```

---

## TV-SCHEMA-001: Zod Object Conversion

**Input**: `z.object({ name: z.string(), age: z.number().optional() })`

**Expected**:
```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "age": { "type": "number" }
  },
  "required": ["name"]
}
```

---

## TV-SCHEMA-002: Zod Enum Conversion

**Input**: `z.enum(["active", "inactive", "pending"])`

**Expected**: `{ "type": "string", "enum": ["active", "inactive", "pending"] }`

---

## TV-SCHEMA-003: TypeBox Pass-Through

**Input**: `Type.Object({ id: Type.String(), count: Type.Integer({ minimum: 0 }) })`

**Expected**: JSON Schema output identical to TypeBox's native output (minus TypeBox metadata symbols).

---

## TV-SCHEMA-004: Plain JSON Schema Pass-Through

**Input**:
```json
{ "type": "object", "properties": { "id": { "type": "string", "format": "uuid" } }, "required": ["id"] }
```

**Expected**: Identical output.

---

## TV-SCHEMA-005: Schema Type Detection

**Input/Expected**:
- `z.string()` (has `_def`) → detected as "zod"
- `Type.String()` (has `Symbol.for('TypeBox.Kind')`) → detected as "typebox"
- `{ type: "string" }` → detected as "jsonschema"
- `42` → error: "Unsupported schema type"

---

## TV-SCHEMA-006: Schema Deduplication

**Input**: Same `z.object({ id: z.string(), name: z.string() })` used in two routes' response schemas.

**Expected**: Schema appears once in `components/schemas/User` (or auto-generated name). Both operations reference `$ref: "#/components/schemas/User"`.

---

## TV-OPENAPI-001: Valid OpenAPI 3.1 Generation

**Input**: Router with 3 routes, `info: { title: "Test API", version: "1.0.0" }`

**Expected**:
```json
{
  "openapi": "3.1.0",
  "info": { "title": "Test API", "version": "1.0.0" },
  "paths": { "/users": { "get": { ... } }, ... }
}
```
Document validates against OpenAPI 3.1.0 JSON Schema with 0 errors.

---

## TV-OPENAPI-002: Operation Objects

**Input**: GET /users, POST /users, GET /users/{id}

**Expected**:
```json
{
  "paths": {
    "/users": {
      "get": { "operationId": "getUsers", ... },
      "post": { "operationId": "createUser", ... }
    },
    "/users/{id}": {
      "get": { "operationId": "getUserById", ... }
    }
  }
}
```

---

## TV-OPENAPI-003: Parameter Extraction

**Input**: GET /users/{id} with query param `fields: z.string().optional()`

**Expected**:
```json
{
  "parameters": [
    { "name": "id", "in": "path", "required": true, "schema": { "type": "string" } },
    { "name": "fields", "in": "query", "required": false, "schema": { "type": "string" } }
  ]
}
```

---

## TV-OPENAPI-009: Deterministic Output

**Input**: Same router and options.

**Expected**: `JSON.stringify(generateOpenAPI(routes, opts)) === JSON.stringify(generateOpenAPI(routes, opts))` — byte-identical.

---

## TV-OPENAPI-011: Parse Existing OpenAPI

**Input (YAML)**:
```yaml
openapi: "3.1.0"
info:
  title: External API
  version: "2.0.0"
paths:
  /items:
    get:
      summary: List items
      responses:
        "200":
          description: OK
```

**Expected**: Parsed to `OpenAPIDocument` object with `openapi: "3.1.0"`, `info.title: "External API"`.

**NEG**: Invalid YAML → throws with descriptive error.

---

## TV-OPENAPI-013: 3.0 to 3.1 Upconversion

**Input**:
```json
{
  "openapi": "3.0.3",
  "info": { "title": "Old API", "version": "1.0.0" },
  "paths": {
    "/items": {
      "get": {
        "responses": {
          "200": {
            "description": "OK",
            "content": {
              "application/json": {
                "schema": { "type": "string", "nullable": true }
              }
            }
          }
        }
      }
    }
  }
}
```

**Expected**: `openapi: "3.1.0"`, `nullable: true` converted to `type: ["string", "null"]`.

---

## TV-COLL-001: Read OpenCollection

**Input**: Directory structure:
```
test-collection/
├── opencollection.yml     # { name: "Test Collection" }
├── environments/
│   └── development.yml    # { variables: { baseUrl: "http://localhost:3000" } }
├── users/
│   ├── folder.yml         # { name: "Users" }
│   ├── list-users.yml     # GET {{baseUrl}}/users
│   └── create-user.yml    # POST {{baseUrl}}/users
```

**Expected**:
```json
{
  "info": { "name": "Test Collection" },
  "environments": {
    "development": { "name": "development", "variables": { "baseUrl": "http://localhost:3000" } }
  },
  "items": [
    {
      "kind": "folder",
      "name": "Users",
      "children": [
        { "kind": "request", "name": "List Users", "request": { "http": { "method": "GET", "url": "{{baseUrl}}/users" } } },
        { "kind": "request", "name": "Create User", "request": { "http": { "method": "POST", "url": "{{baseUrl}}/users" } } }
      ]
    }
  ]
}
```

**NEG**: Directory without `opencollection.yml` → error "No opencollection.yml found in /path".

---

## TV-COLL-004: Generate Collection from OpenAPI

**Input**: OpenAPI document with GET /users, POST /users, GET /users/{id}, tags: ["users"]

**Expected**: OpenCollection with:
- `opencollection.yml` with collection name
- `environments/development.yml` with `baseUrl` from spec servers
- `users/list-users.yml` — GET `{{baseUrl}}/users`
- `users/create-user.yml` — POST `{{baseUrl}}/users` with body from schema
- `users/get-user.yml` — GET `{{baseUrl}}/users/{{id}}`

---

## TV-COLL-006: Bruno Interoperability

**Input**: Collection generated by apifn.

**Expected**: All `.yml` files conform to OpenCollection spec. The `opencollection.yml` root file is present. File structure matches Bruno 3.0.0 expectations.

---

## TV-ENV-002: Variable Interpolation

**Input**:
- URL: `{{baseUrl}}/{{apiVersion}}/users`
- Environment: `{ baseUrl: "http://localhost:3000", apiVersion: "v1" }`

**Expected**: `http://localhost:3000/v1/users`

**NEG**: `{{undefined_var}}` → remains as `{{undefined_var}}` with warning.

---

## TV-ENV-003: Secret Variable References

**Input**:
- Header value: `{{process.env.API_KEY}}`
- `process.env.API_KEY = "sk-test-123"`

**Expected**: Resolved to `"sk-test-123"`.

**NEG**: `process.env.MISSING_VAR` not set → error "Environment variable MISSING_VAR is not set".

---

## TV-ENV-004: Environment Precedence

**Input**:
- Override: `{ baseUrl: "http://override:3000" }`
- Environment: `{ baseUrl: "http://env:3000", apiKey: "env-key" }`
- Collection: `{ apiKey: "coll-key", timeout: "5000" }`

**Expected**:
- `baseUrl` → `"http://override:3000"` (override wins)
- `apiKey` → `"env-key"` (env wins over collection)
- `timeout` → `"5000"` (collection fallback)

---

## TV-DIFF-001: Endpoint Removal

**Before**: Paths: GET /users, POST /users, DELETE /users/{id}
**After**: Paths: GET /users, POST /users

**Expected**:
```json
{
  "hasBreakingChanges": true,
  "breaking": [
    { "type": "removed", "breaking": true, "path": "paths./users/{id}.delete", "description": "Endpoint DELETE /users/{id} was removed" }
  ],
  "summary": { "removed": 1, "breaking": 1 }
}
```

---

## TV-DIFF-002: Required Parameter Addition

**Before**: POST /users with body `{ name: string }`
**After**: POST /users with body `{ name: string, email: string }` (email required)

**Expected**:
```json
{
  "hasBreakingChanges": true,
  "breaking": [
    { "type": "modified", "breaking": true, "path": "paths./users.post.requestBody.content.application/json.schema.required", "description": "New required field 'email' added to request body" }
  ]
}
```

---

## TV-DIFF-006: Non-Breaking Addition

**Before**: Paths: GET /users
**After**: Paths: GET /users, GET /orders

**Expected**:
```json
{
  "hasBreakingChanges": false,
  "nonBreaking": [
    { "type": "added", "breaking": false, "path": "paths./orders.get", "description": "New endpoint GET /orders added" }
  ]
}
```

---

## TV-RUN-001: Sequential Execution

**Input**: Collection with 3 requests (seq 1, 2, 3). Each returns 200.

**Expected**: Requests executed in order. Run report shows all 3 passed. `summary.total === 3`, `summary.passed === 3`.

---

## TV-RUN-005: Test Script Execution

**Input**: Request with test script:
```yaml
runtime:
  scripts:
    - type: tests
      code: |-
        test("should return 200", function() {
          expect(res.status).to.equal(200);
        });
        test("should have items", function() {
          expect(res.body.items).to.have.length.above(0);
        });
```

Server returns `{ status: 200, body: { items: [{ id: "1" }] } }`.

**Expected**: Both assertions pass. `result.assertions.length === 2`, both `passed: true`.

**NEG**: Server returns 404 → first assertion fails: `{ name: "should return 200", passed: false, expected: 200, actual: 404 }`.

---

## TV-RUN-007: Timeout Enforcement

**Input**: Request with `timeout: 100`. Server delays response by 500ms.

**Expected**: `result.status === "error"`, `result.error === "Request timed out after 100ms"`.

---

## TV-SNIP-001: curl Snippet

**Input**: POST /users with JSON body, Bearer auth.

**Expected**:
```bash
curl -X POST 'http://localhost:3000/users' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -d '{
  "name": "string",
  "email": "string"
}'
```

---

## TV-SNIP-002: JavaScript fetch Snippet

**Input**: GET /users with query param `limit`.

**Expected**:
```javascript
const response = await fetch('http://localhost:3000/users?limit=10', {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
  },
});

const data = await response.json();
```

---

## TV-MOCK-002: Schema-Based Response Generation

**Input**: Schema `{ type: "object", properties: { id: { type: "string" }, name: { type: "string" }, active: { type: "boolean" } }, required: ["id", "name", "active"] }`

**Expected**: `{ "id": "string", "name": "string", "active": true }`

---

## TV-AUTH-001: Mint Test Token

**Input**: `mintTestToken(authfn, { scopes: ["read:users"], ttl: 300 })`

**Expected**: `{ token: "<valid-api-key>", expiresAt: <~5min-from-now>, keyId: "<uuid>" }`

**NEG-TV-AUTH-001**: `mintTestToken(authfn, { ttl: 7200 })` → error "TTL exceeds maximum of 3600 seconds".

---

## TV-ASSERT-001: Status Code Assertions

**Input**: Response with status 200, assertion `expect(res.status).to.equal(200)`
**Expected**: `{ name: "status is 200", passed: true }`

**NEG**: Response status 404 → `{ name: "status is 200", passed: false, expected: 200, actual: 404 }`

---

## TV-DOCS-001: DocsContentProvider

**Input**:
```typescript
const provider = createApifnProvider({
  source: openApiDoc,
  splitByTag: true,
});
const entries = await provider.list();
```

OpenAPI doc has tags: "users", "orders" with 3 and 2 endpoints respectively.

**Expected**: 2 `RawContentEntry` objects with `kind: "api"`, slugs `"users"` and `"orders"`, body containing the relevant OpenAPI subset.

---

## TV-CLI-011: Exit Codes

**Input/Expected**:
- `apifn test` with all passing → exit 0
- `apifn test` with 1 failure → exit 1
- `apifn test` with invalid collection → exit 2
- `apifn diff` with no breaking → exit 0
- `apifn diff` with breaking → exit 1
- `apifn validate` with valid spec → exit 0
- `apifn validate` with invalid spec → exit 1

---

## TV-WATCH-001: Fetch Endpoint Metrics

**Input**: `fetchEndpointMetrics("http://localhost:4000", { timeRange: "1h" })`

**Expected** (when watchfn is running):
```json
[
  {
    "method": "GET",
    "path": "/users",
    "latency": { "p50": 12, "p95": 45, "p99": 120, "avg": 25 },
    "throughput": { "rpm": 150, "total": 9000 },
    "errors": { "rate": 0.02, "count": 180 },
    "availability": 0.98,
    "lastUpdated": "2026-03-05T22:00:00Z"
  }
]
```

**NEG**: watchfn unreachable → returns empty array with warning (graceful degradation).

---

## TV-PY-001: FastAPI Introspection

**Input**:
```python
from fastapi import FastAPI
app = FastAPI()

@app.get("/users")
async def list_users():
    return []

spec = introspect_fastapi(app, ApifnConfig(title="Test", version="1.0.0"))
```

**Expected**: Standard OpenAPI dict with paths `/users` including GET operation. `spec["openapi"] == "3.1.0"`.
