# OpenAPI fixtures for `fromOpenAPI()`

- `form-*.json`: one document per supported form (D12), used by
  `tests/openapi-forms.test.ts`.
- `skip-*.json`: one document per skip reason. `skip-swagger-2.0.json` is
  rejected as a whole; the others list their operations in `skipped`.
  `skip-composed-parameter-schemas.json` also keeps the composed parameters
  that stay supported, to show the classification both ways.
  `skip-nonproductive-recursion.json` also keeps a schema that recurses
  through a property, which stays supported.
  `skip-prototype-parameter-name.json` also keeps a parameter with an
  ordinary name, which stays supported.
  `skip-prototype-property-name.json` declares a `__proto__` property in a
  body, a nested component and a response, and keeps a body with an
  ordinary name, which stays supported.
- `skip-access-flag-*.json` cover the readOnly (input) and writeOnly (output)
  projection rule. A flagged property is left out only along a plain chain
  (`properties`, one `items` schema, a schema `additionalProperties`,
  `allOf`, `$ref`, or an `anyOf`/`oneOf` member no other member overlaps by
  kind of value) and only when nothing else needs the name. Otherwise an
  input skips with `unsupported-access-flag` and an output schema is left
  out. `conflicts` covers alternatives, conditions, dependencies and foreign
  `required` lists, and keeps the nullable-reference idiom and a `oneOf` that
  never uses the flagged name. `instance-constraints` covers `const`, `enum`
  and `minProperties` and keeps `maxProperties`. `oneof-overlap` and
  `oneof-nested` cover object alternatives that can both match, and keep a
  nullable reference. `name-constraints` covers conditions that can tell
  the name apart (`patternProperties` under `if`, `maxProperties` under
  `not`) and keeps siblings whose `additionalProperties` cannot need it.
  `oneof-projection` and `child-constraints` cover child values with more
  than one schema, and keep a map of objects and an object-or-array `oneOf`.
- `skip-unsupported-dialect.json` sets a `jsonSchemaDialect` other than the
  OAS 3.1 base or 2020-12 dialect: an operation with a schema is skipped
  (`unsupported-dialect`) and one without a schema is kept.
- `schema-too-large` has no fixture: it needs one object shared by many
  schema positions, which JSON cannot express, so
  `tests/openapi-forms.test.ts` builds that document in the test.
- `skip-malformed-request-body.json` skips declared request bodies with no
  usable JSON media entry, and keeps a `*+json` entry beside a null
  `application/json` one and a media entry without a schema.
- `form-read-only-composed.json` covers readOnly and writeOnly reached through
  `allOf`, and skips a flagged field that a sibling `allOf` member requires.
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
