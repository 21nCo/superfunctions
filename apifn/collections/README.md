# @apifn/collections

OpenCollection YAML read/write/run for ApiFn. Read and write portable API request collections, generate them from OpenAPI specs or routers, and run them as a test suite with assertions, scripting, and pluggable reporters.

## Installation

```bash
npm install @apifn/collections
```

## Features

- **Read / Write** — Load and persist an OpenCollection directory (`opencollection.yml` + per-request YAML + environments)
- **Generate** — Produce a collection from an OpenAPI document or a `@superfunctions/http` router
- **Run** — Execute a collection with sequential or parallel scheduling, retries, timeouts, and bail-on-failure
- **Assertions** — Chai-like `expect`/`test` runtime with JSON Schema and JSONPath support
- **Scripting** — Sandboxed pre-request and test scripts (Node `vm`, no `process`/`require`/`fetch`)
- **Reporters** — Console, JSON, JUnit XML, and silent reporters
- **Safety** — Secret redaction in captured request/response data, path-traversal-safe writes

---

## Reading & Writing

### readCollection

Reads an OpenCollection directory. Expects `opencollection.yml` at the root; files under `environments/` become environments; any YAML with both `info` and `http` keys is a request. Items are assembled into a nested folder tree.

```typescript
import { readCollection } from "@apifn/collections";

const collection = await readCollection("./.apifn/collection");
// { info, environments, items, rootDir }
```

### writeCollection

Persists a `Collection` back to its `rootDir` (writes `opencollection.yml`, `environments/*.yml`, and each request/folder). Paths are validated against traversal.

```typescript
import { writeCollection } from "@apifn/collections";

await writeCollection(collection);
```

### validateCollection

Returns `ValidationError[]` describing structural problems (missing `info.name`, malformed environments, requests missing `http.method`, etc.).

```typescript
import { validateCollection } from "@apifn/collections";

const errors = validateCollection(collection);
```

---

## Generating Collections

### openAPIToCollection

Build a collection from an OpenAPI document. Operations are grouped by tag (default) or first path segment.

```typescript
import { openAPIToCollection } from "@apifn/collections";

const collection = openAPIToCollection(openApiDoc, {
  baseUrl: "https://api.example.com",
  environmentName: "development",
  groupBy: "tag", // or "path"
  includeExamples: true,
});
```

### routerToCollection

Introspect a `@superfunctions/http` router and produce a collection in one step.

```typescript
import { routerToCollection } from "@apifn/collections";

const collection = routerToCollection(router, {
  baseUrl: "https://api.example.com",
  info: { title: "My API", version: "1.0.0" },
});
```

Path params `{id}` become `{{id}}` template variables and URLs are prefixed with `{{baseUrl}}`.

---

## Running Collections

### runCollection

Execute a collection against an environment. Returns a `RunReport`.

```typescript
import { readCollection, runCollection, createConsoleReporter } from "@apifn/collections";

const collection = await readCollection("./.apifn/collection");
const report = await runCollection(collection, {
  environment: "development",
  reporter: createConsoleReporter(),
  parallel: false,
  bail: false,
  retries: 1,
  timeout: 30_000,
});

console.log(report.summary);
// { total, passed, failed, skipped, errors, duration }
```

#### RunOptions

| Option | Type | Description |
|--------|------|-------------|
| `environment` | `string \| Environment` | Environment name or object (required) |
| `include` / `exclude` | `string[]` | Glob-ish patterns matched against path/name/`"METHOD url"` |
| `includePaths` | `string[]` | Exact collection-relative request paths to run |
| `parallel` | `boolean` | Run requests concurrently (default: sequential) |
| `concurrency` | `number` | Max concurrent requests in parallel mode (default: 4) |
| `timeout` | `number` | Per-request timeout in ms (default: 30000) |
| `bail` | `boolean` | Stop on first failure |
| `retries` | `number` | Retry network errors and HTTP 5xx responses (default: 0) |
| `delay` | `number` | Delay between sequential requests in ms |
| `httpClient` | `HttpClient` | Custom client (default: built-in fetch-based) |
| `cookieJar` | `CookieJar` | Shared cookie jar |
| `reporter` | `RunReporter` | Progress/result reporter |
| `overrides` | `Record<string, string>` | Variable overrides (highest precedence) |
| `processEnv` | `NodeJS.ProcessEnv` | Explicit values for `{{process.env.NAME}}` (default: empty) |
| `allowScripts` | `boolean` | Execute scripts from a trusted collection (default: false) |
| `redactHeaders` | `string[]` | Extra headers to redact in captured data |

A request passes when its status matches the expected status (default `< 400`, or `settings.expectedStatus`) and no assertion fails.

**Redaction:** results leave the runner (the returned report and every reporter call) only after `sanitizeRequestResult` from `@apifn/core`; the JSON, JUnit and console reporters and the LogFn reporter apply it again, so a result passed to them directly is redacted too. Only the send is retried: redaction, test scripts and reporters never resend a request, and a failure while capturing or redacting withholds that field instead of rejecting the run.

- Structured data is redacted exactly. URLs (the request URL, redirect records, `Location`, `Content-Location` and `Referer`) are resolved by the WHATWG URL parser; userinfo is removed and credential query and fragment parameters (by key, such as `code`, `state` or `access_token`) become `[REDACTED]`, and a URL with nothing to redact is kept as written. Headers are redacted by name (`authorization`, `cookie`, `x-api-key` and similar, names with credential words, plus `redactHeaders`; cookies pair by pair). JSON bodies are redacted by member, including the value of a `{name, value}` object or `[name, value]` pair whose name is a credential name, in any member order; form bodies by key.
- Other text (non-JSON bodies, header values, errors, assertion names and values, warnings) gets three linear passes: credential values the run already knows, a line-oriented keyword rule that redacts from a credential key and separator to the end of its line (and further while brackets stay open), the enclosing container of a quoted credential name such as `"X-Api-Key"`, private keys and `Bearer` credentials, and URL tokens through the URL rule above. This pass may over-redact.
- The run keeps one registry of credential values, seeded before the first send from credential-named variables, environment entries and jar cookies and updated with what each send puts on the wire (including the jar cookie the client adds), each response, redirect and retried 5xx response, and script-rotated variables. Only values under credential keys or names are recorded, never literals or token counts.

The report shows the request as sent and the response as received. The response body is redacted in full before it is cut to the 10 MiB capture limit.

---

## Reporters

| Reporter | Factory | Output |
|----------|---------|--------|
| Console | `createConsoleReporter({ color?, write? })` | Colored per-request badges + summary |
| JSON | `createJsonReporter({ write?, indent? })` | Full `RunReport` as JSON |
| JUnit | `createJUnitReporter({ write? })` | JUnit XML (`reportToJUnitXml(report)` for a string) |
| Silent | `createSilentReporter()` | No output |

```typescript
import { runCollection, createJsonReporter } from "@apifn/collections";

await runCollection(collection, {
  environment: "development",
  reporter: createJsonReporter({ indent: 2 }),
});
```

---

## Assertions

`createAssertionRuntime()` returns a Chai-like `expect`/`test` API used inside test scripts.

```typescript
import { createAssertionRuntime } from "@apifn/collections";

const { expect, test, getResults } = createAssertionRuntime();
const response = {
  status: 200,
  body: { id: "usr_123", roles: ["admin"], profile: { email: "dev@example.com" } },
  responseTime: 120,
};

test("returns the user", () => {
  expect(response.status).to.equal(200);
  expect(response.body).to.have.property("id");
  expect(response.body.roles).to.include("admin");
  expect(response.body).to.have.jsonPath("$.profile.email");
  expect(response.responseTime).to.be.below(500);
});

const results = getResults(); // AssertionResult[]
```

Supported matchers: `.equal`, `.include`, `.matchSchema`, `.have.property`, `.have.length` / `.have.length.above`, `.have.jsonPath`, `.be.below`.

---

## Scripting

The runner rejects selected requests that contain scripts before sending any HTTP requests. Set `allowScripts: true` only when you trust the scripts as fully as local code. The Node `vm` context exposes host objects, and its 10-second synchronous execution limit cannot bound asynchronous work.

```typescript
import { executePreRequestScript, executeTestScript } from "@apifn/collections";
```

Use these helpers directly only with trusted script code.

- `executePreRequestScript({ code, env, req, cookies?, timeoutMs? })` — mutate `req`, set `env` variables before sending
- `executeTestScript({ code, env, req, res, cookies?, assertionResults, timeoutMs? })` — assert against `res` with `expect`/`test`

---

## Environments & Variables

```typescript
import {
  readEnvironments,
  selectEnvironment,
  interpolateVariables,
  resolveVariableContext,
  loadDotEnvFile,
} from "@apifn/collections";

const envs = await readEnvironments("./.apifn/collection/environments");
const env = selectEnvironment(envs, "development");

const context = resolveVariableContext({
  collection: {},
  environment: env.variables, // collection < environment < overrides
  overrides: loadDotEnvFile(".env"),
});

const { value, warnings } = interpolateVariables(
  "{{baseUrl}}/users?token={{process.env.API_TOKEN}}",
  context,
  { processEnv: { API_TOKEN: process.env.API_TOKEN } },
);
```

`{{var}}` tokens are replaced from the context. Unknown context tokens are left intact and reported in `warnings`. `{{process.env.X}}` requires an explicit value for `X` in the `processEnv` option and throws if the value is missing.

---

## HTTP Client & Cookies

```typescript
import { createFetchHttpClient, createCookieJar } from "@apifn/collections";

const jar = createCookieJar();
const client = createFetchHttpClient({ cookieJar: jar, followRedirects: true, maxRedirects: 10 });
```

The built-in fetch client handles redirects manually, strips sensitive headers on cross-origin redirects, downgrades 303 to GET, and injects/stores cookies via the jar.

## License

MIT
