# OpenAPI fixtures for `fromOpenAPI()`

- `form-*.json`: one document per supported form (D12), used by
  `tests/openapi-forms.test.ts`.
- `skip-*.json`: one document per skip reason. `skip-swagger-2.0.json` is
  rejected as a whole; the others list their operations in `skipped`.
- `apifn-from-router.json`: output of `fromRouter()` from `@apifn/core`,
  committed so the tests have no apifn dependency. It was produced with this
  router (`z` is zod 4, `createRouter` from `@superfunctions/http`):

```ts
const ok = async () => Response.json({});
const user = z.object({ id: z.string(), name: z.string(), email: z.string().email().optional() });
const router = createRouter({
  routes: [
    { method: "GET", path: "/api/users", handler: ok, meta: apiSchema({
      operationId: "listUsers", summary: "List users", tags: ["users"],
      query: { limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() },
      responses: { 200: { description: "OK", schema: z.object({ items: z.array(user), next: z.string().nullable() }) } },
    }) },
    { method: "GET", path: "/api/users/:id", handler: ok, meta: apiSchema({
      operationId: "getUser", summary: "Get user", description: "Fetch one user by id.", tags: ["users"],
      params: { id: z.string() }, headers: { "x-request-id": z.string().optional() },
      responses: { 200: { description: "OK", schema: user }, 404: { description: "Not found" } },
    }) },
    { method: "POST", path: "/api/users", handler: ok, meta: apiSchema({
      operationId: "createUser", summary: "Create user", tags: ["users"],
      body: z.object({ name: z.string().min(1), email: z.string().email().optional() }),
      responses: { 201: { description: "Created", schema: user } },
    }) },
    { method: "DELETE", path: "/api/users/:id", handler: ok, meta: apiSchema({
      operationId: "deleteUser", summary: "Delete user", tags: ["users"], params: { id: z.string() },
      responses: { 204: { description: "Deleted" } },
    }) },
    { method: "GET", path: "/api/health", handler: ok, meta: apiSchema({
      summary: "Health check", responses: { 200: { description: "OK" } },
    }) },
  ],
});
fromRouter(router, {
  info: { title: "apifn fromRouter fixture", version: "1.0.0" },
  servers: [{ url: "https://api.example.com" }],
});
```
