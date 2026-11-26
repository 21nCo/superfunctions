# @apifn/core

Core JavaScript/TypeScript library for ApiFn — route introspection, schema conversion, OpenAPI generation, and diff. The other ApiFn npm packages build on `@apifn/core`.

## Installation

```bash
npm install @apifn/core @superfunctions/http
```

`@superfunctions/http` (`>=0.2.0 <0.4.0`) is a required peer. `@sinclair/typebox` and `@testfn/core` are optional peers: install them only to convert TypeBox schemas or to use the testFn adapter from `@apifn/core/testfn`, which also needs `@apifn/collections`.

## Features

- **Route Introspection** — Walk a `@superfunctions/http` router and describe every route (parameters, request bodies, responses, security)
- **Schema Conversion** — Convert Zod and TypeBox schemas to JSON Schema, with auto-detection and deduplication
- **OpenAPI Generation** — Produce an OpenAPI 3.1 document directly from a router
- **OpenAPI Parsing & Validation** — Parse YAML/JSON specs and validate them against the OpenAPI schema
- **Diff** — Compare two OpenAPI documents and classify changes as breaking / non-breaking
- **Request Idempotency** — Claim, settle and replay keyed requests through a host-supplied atomic store, with receipt-based commit recovery
- **Integrations** — First-class hooks for authfn, secfn, watchfn, logfn, and testfn

---

## OpenAPI Generation

### fromRouter

Generate an OpenAPI document from a `@superfunctions/http` router in one step. `FromRouterOptions` combines `OpenAPIGenerateOptions` (info, servers, security schemes) and `IntrospectOptions` (include/exclude/basePath).

```typescript
import { fromRouter } from "@apifn/core";

const doc = fromRouter(router, {
  info: {
    title: "My API",
    version: "1.0.0",
    description: "Public API surface",
  },
  servers: [{ url: "https://api.example.com" }],
  // IntrospectOptions
  include: ["/v1"],
  exclude: ["/internal"],
  basePath: "/api",
});
```

### introspectRouter

Describe a router's routes without generating a full document. Returns `IntrospectedRoute[]`.

```typescript
import { introspectRouter } from "@apifn/core";

const routes = introspectRouter(router, { include: ["/v1"] });
// [{ method, path, parameters, requestBody, responses, security }, ...]
```

### generateOpenAPI

Build the document from already-introspected routes. `fromRouter` is `introspectRouter` + `generateOpenAPI`.

```typescript
import { introspectRouter, generateOpenAPI } from "@apifn/core";

const doc = generateOpenAPI(introspectRouter(router), {
  info: { title: "My API", version: "1.0.0" },
});
```

---

## Parsing & Validation

### parseOpenAPI

Parse a YAML or JSON OpenAPI string into an `OpenAPIDocument`.

```typescript
import { parseOpenAPI } from "@apifn/core";
import { readFile } from "node:fs/promises";

const doc = parseOpenAPI(await readFile("./openapi.yml", "utf8"));
```

### validateOpenAPI

Validate a document without changing it. Returns validation errors (`ValidationError[]`) for a report or gate.
Validation accepts local JSON pointers by default and refuses external references. If you validate a split document, pass trusted, preloaded JSON or YAML in `externalReferences`, keyed by resolved document URI or absolute path without a fragment. Use slash-delimited `#/` pointers within preloaded documents. Validation does not read files or make network requests.
Escape literal `%`, `?`, and `\\` within path segments as `%25`, `%3F`, and `%5C`.
Drive-qualified Windows paths and native network-share paths accept either slash style in allowlist keys. Use a URI key for an explicit `file:` reference.
Preloaded YAML supports anchors and aliases within an expansion limit. Expand YAML merge keys before preloading.
For recursion in a preloaded document, reference a distinct schema definition. A preloaded `$ref` cannot point directly to itself.
Relative references use the preloaded document's retrieval URI or path as their base, matching Swagger Parser.
Literal `$ref` strings in examples and defaults are kept as data, including in preloaded schemas.
Use `validateAndDereferenceOpenAPI` when you also need the validated copy with references resolved. Recursive schemas can produce circular objects in that copy.

```typescript
import { validateOpenAPI } from "@apifn/core";

const errors = await validateOpenAPI(doc);
if (errors.length > 0) {
  // handle invalid spec
}
```

### upconvertFrom3_0

Up-convert an OpenAPI 3.0 document to 3.1.

```typescript
import { upconvertFrom3_0 } from "@apifn/core";

const doc31 = upconvertFrom3_0(doc30);
```

---

## Schema Conversion

ApiFn converts framework-native schemas to JSON Schema for OpenAPI output.

| Function | Description |
|----------|-------------|
| `detectSchemaType(schema)` | Detect whether a value is a Zod, TypeBox, or plain JSON schema (`SchemaType`) |
| `convertSchema(schema)` | Convert any supported schema to JSON Schema, auto-detecting the type |
| `convertZodSchema(schema)` | Convert a Zod schema to JSON Schema |
| `convertTypeBoxSchema(schema)` | Convert a TypeBox schema to JSON Schema |
| `deduplicateSchemas(input)` | Extract shared/duplicated schemas into reusable `components` (`DeduplicateSchemasResult`) |

```typescript
import { convertSchema, detectSchemaType } from "@apifn/core";
import { z } from "zod";

detectSchemaType(z.object({ id: z.string() })); // "zod"
const jsonSchema = convertSchema(z.object({ id: z.string() }));
```

### apiSchema

Attach a schema descriptor to a route so introspection can pick up request/response shapes.

```typescript
import { apiSchema } from "@apifn/core";
```

---

## Diff

### diffOpenAPI

Compare two OpenAPI documents. Returns a `DiffResult` with a list of `DiffEntry` changes, each classified by severity.

```typescript
import { diffOpenAPI, formatDiffAsText, formatDiffAsJson } from "@apifn/core";

const result = diffOpenAPI(beforeDoc, afterDoc);

console.log(formatDiffAsText(result)); // human-readable
const report = formatDiffAsJson(result); // DiffReportJson (machine-readable)
```

- `formatDiffAsText(result)` — colored/plain text summary
- `formatDiffAsJson(result)` — structured `DiffReportJson` for CI artifacts

---

## Request Idempotency

`createRequestIdempotency` lets a host retry a keyed request after a lost response and get the original result back. It needs no database of its own: the host supplies an atomic conditional store and, for handlers with a durable commit receipt, a receipt source.

```typescript
import { createRequestIdempotency } from "@apifn/core";

const idempotency = createRequestIdempotency({
  store,             // { get(storeKey), compareAndSet(storeKey, expectedVersion, next) }
  receipts,          // optional: { find(storeKey) } over receipts committed with the effect
  leaseMs: 30_000,   // how long a holder owns the key: above store latency plus the handler's longest transaction
  retentionMs: 86_400_000,
  maxResponseBytes: 65_536,
  credentialHeaders: ["x-session-token"], // optional: extra headers never stored or replayed
});

const claim = await idempotency.claim({
  scope: { principal: user.id, tenant: org.id, operation: "createOrder", target: storeId },
  key: request.headers.get("idempotency-key")!,
  body: validatedBody,
  recovery: "receipt",
});

switch (claim.outcome) {
  case "acquired": {
    // Write the effect and a receipt with claim.token's storeKey, fingerprint, generation and claimId
    // in one transaction; the receipt store accepts one receipt per storeKey.
    const response = await createOrder(claim.token, validatedBody);
    const settled = await idempotency.settle(claim.token, response);
    // "settled" or "committed": send settled.response, the full response (a committed receipt wins over the
    // handler's own result); "conflict": a receipt for a different body holds the key; "stale": no receipt
    // exists and a newer claim owns the key.
    return settled;
  }
  case "replay":        // claim.response: the stored response; check claim.response.omitted (below)
  case "conflict":      // same key, different body or recovery mode
  case "in_progress":   // another holder owns the key; claim.retryAfterMs
  case "indeterminate": // an expired holder without a receipt contract may have committed
  case "invalid_key":   // the key is empty, too long or not visible ASCII
}
```

- **Scope** — The record and receipt key is a digest of the tenant, principal, operation, target and idempotency key, so a different caller or tenant never sees another scope's result. Pass identifiers, never credentials. Pass the validated, parsed JSON body: the body fingerprint uses `canonicalJson`, which encodes plain JSON data only (sorted keys, undefined properties omitted) and throws a `TypeError` for anything a JSON serializer would convert, such as sparse arrays, undefined array items, `Date`, `Buffer`, class instances and any object with a `toJSON` method, so a `Date` never shares a fingerprint with its ISO string. An omitted body never matches a `null` body. The recovery mode is fixed per operation: to change it, use a new operation name or let the old one's records and receipts drain for a full retention period. A `recovery: "none"` request over a released or expired `"receipt"` record that the store still holds is a `conflict`, with or without a `receipts` source. `canonicalJson` also rejects array subclasses, arrays with extra properties and getter properties, and its errors name the depth and array index only, never a body member name. A `toJSON` getter is rejected without being called. `canonicalJson` also rejects symbol-keyed and non-enumerable object members. Response header names must be HTTP tokens, header values may contain only horizontal tab, visible ASCII, space and bytes 0x80-0xFF (no other control characters and no code points above U+00FF), and `headers` must be a plain object (a `Headers` instance throws a `TypeError`); a `__proto__` header is kept as an ordinary field. Every instance that shares a store must use the same recovery mode per operation and the same `receipts` source.
- **Store contract** — `compareAndSet` writes (or deletes, for `null`) only when the stored `version` equals the expected one, or when no record exists and the expected version is `null`. Every write gets a fresh version, so a stale holder cannot settle, release or overwrite a newer claim. `release` writes a `released` tombstone that frees the key but keeps its generation until retention ends. A claim no handler ran under is freed the same way: when `claim` fails after its write (the `receipts` source rejects the post-write lookup, or the store applies the claim write and then rejects, for example on a lost acknowledgement), it releases exactly the version it wrote by a conditional write that never clears a newer writer's record, then rethrows the original error. A store that evicts a record before then restarts the key's generation at 1, so ownership never rests on the generation: each claim has a unique `claimId`, the handler writes it into its receipt, and `settle` and `release` treat a receipt as the holder's own commit only when its `claimId` matches the token's.
- **Commit recovery** — With `recovery: "receipt"`, a pending claim whose receipt exists is completed from the receipt and replayed, even before its lease expires, and an expired claim is taken over only when no receipt exists. A committed receipt always wins: `settle` and `release` record it instead of the holder's result (also when a concurrent `claim` or `recover` recorded it first, so the holder whose commit landed gets `settled`, never `stale`), and `claim` and `recover` replace a response settled without it. A receipt for a different body is a `conflict`, never a replay. A request whose `recovery` differs from the live record's is a `conflict`, so it never takes over or downgrades a claim. When a `receipts` source is configured and the record has expired or been evicted, the receipt is checked for every request: a `recovery: "none"` request over a retained receipt is a `conflict` that neither acquires the key nor exposes the receipt's response. `settle` and `release` read the receipt before validating or writing the holder's own result, and read it again after a successful write, so a commit that landed meanwhile is reported (`committed` or `conflict`) and recorded instead of the holder's fallback. One window remains outside the library's fence: a holder whose lease expired can still commit after that final read. The receipt store's one-receipt-per-key rule still prevents a second effect, and the next `claim` or `recover` replays the receipt, but the caller that settled may already have sent its fallback. Keep `leaseMs` above the handler's longest transaction to make that rare. Once a receipt is read, it decides the outcome whether or not the write that records it in the store wins: `settle` gives `settled` (own `claimId`), `committed` (same body) or `conflict`, `release` gives `committed` or `conflict`, and `claim` and `recover` replay the receipt (`source: "receipt"`) or report `conflict`, never `stale` or `in_progress`; a lost write leaves the newer record untouched and a later step records the receipt. A claim is handed out only while its lease still runs after the claim write and the `acquired` diagnostic (`onDiagnostic` runs inside the lease window): a claim that outlasted `leaseMs` is released and retried (reported `in_progress` if every attempt is too slow), so set `leaseMs` above the store's write latency plus the handler's longest transaction. With a `receipts` source, every claim rechecks the receipt after its write and before a handler can run: a `recovery: "receipt"` claim records a receipt that landed meanwhile and replays it (`source: "receipt"`) or reports `conflict` for another body, and a `recovery: "none"` claim releases the claim and reports `conflict`. A store read or write that fails after a receipt is read never hides it: the receipt still decides the outcome and a later step records it. `settle` and `release` read the record first, then the receipt, and write only over the version they saw, and a completed record names the receipt `claimId` it was recorded from (`receiptClaimId`), so a stale holder whose receipt was read before the key's retention ended never replaces a newer claim, and a newer commit for the same body is recorded over an older one. `claim` and `recover` with `recovery: "receipt"` read the receipt on every call, also over a record recorded from a receipt, so a cached copy never masks a newer commit. A receipt recorded where no record existed cannot tell that absence from a later one (a newer claim committed and its record was evicted), so the receipt is read again after that write, whether it won, lost or lost its acknowledgement: a newer commit replaces the copy and decides the outcome, no receipt retires the copy and the request decides again, and a failed lookup retires the copy and throws, so an unverified receipt never decides. `recovery: "receipt"` without a `receipts` source throws, and so do `settle` and `release` of a `"receipt"` token on an instance without one, before any store write. Without receipts, an expired claim is `indeterminate` until its retention ends.
- **`recover(request)`** — Reports a key's state without claiming it: `replay`, `conflict`, `in_progress`, `not_committed`, `indeterminate` or `absent`.
- **Bounded data** — Stored responses keep the status, headers and string body within `maxResponseBytes`; a larger body (then headers) is dropped and listed in `omitted`, and a dropped body takes its representation headers (`content-length`, `content-encoding`, `etag`, digests) with it. Responses need a final status (200-599), no body for `204`, `205` and `304`, and header names that do not repeat in a different case (`Location` and `location`); `settle` throws a `TypeError` otherwise, and stored records and receipts that break these rules fail closed. Credential headers such as `authorization` and `set-cookie`, plus any names passed in `credentialHeaders`, hop-by-hop headers such as `transfer-encoding`, and fields a `connection` header nominates are never stored or replayed. Receipt responses are validated like settled ones, and a malformed receipt fails closed. Only the stored copy is bounded: `settle` and `release` return the full response to the first caller. Without a receipt, `settle` returns a fresh copy of the holder's own full response as validated when `settle` was called (same status, body, header names and values), never the caller's object. `settle` reads the response, and the library reads stored records, receipts and tokens, exactly once through own data properties into a validated copy; a getter or setter on any of their fields (status, body, a header) is rejected with a `TypeError` (a malformed record or receipt fails closed) without being called, and every check, stored copy and returned response derives from that one copy. For the holder's own receipt-backed commit, `settle` returns the receipt's response with the replay header rules applied plus only the holder's own credential headers (`set-cookie` and the `credentialHeaders` names, never a field its `connection` header nominates), so the first delivery equals every replay apart from credentials; for another holder's commit or a `release`, it returns the receipt's response with the replay header rules applied, and a replay of a receipt-backed record reads the full response from the receipt (`source: "receipt"`). A replay from the store whose `omitted` lists `body` has the original status and remaining headers but no body: do not send it as if it were the original response (a client expecting a JSON body would reject it). Send a response the client can act on instead, such as a `409` problem saying the original result is too large to replay, and set `maxResponseBytes` above the largest response clients need replayed. Replays copy only the status, headers, body and `omitted` of a stored response. `normalizeIdempotentResponse(response, { maxBytes, credentialHeaders })` applies the same rules; `maxBytes` must be a positive integer up to 16 MiB. `onDiagnostic` events carry the action, outcome, operation, store key digest and generation only.
- **Defaults** — Store keys and body fingerprints use a portable SHA-256 (`sha256Fingerprint`) that needs no Web Crypto, so they work on Node 18, which has no global `crypto`. Versions use `crypto.randomUUID()`; pass `nonce` on runtimes without it. `fingerprint` replaces the body digest only and must be collision-resistant; store keys always use SHA-256.

---

## Integrations

### watchfn

Fetch endpoint performance metrics and stream request telemetry to a watchfn instance.

```typescript
import {
  fetchEndpointMetrics,
  createWatchFnClient,
  apifnWatchMiddleware,
} from "@apifn/core";

// Fetch p50/p95/p99 + error-rate metrics; degrades gracefully to [] on failure
const metrics = await fetchEndpointMetrics({
  baseUrl: "https://watch.example.com",
  timeRange: "PT1H", // ISO 8601 duration
});

const client = createWatchFnClient({ baseUrl: "https://watch.example.com" });

// Middleware records per-endpoint timing and status to watchfn
const router = createRouter({ routes }); // from @superfunctions/http
router.use(apifnWatchMiddleware({ baseUrl: "https://watch.example.com" }));
```

`apifnWatchMiddleware` is a `@superfunctions/http` `Middleware`, so it also works in `createRouter({ middleware: [...] })` and in a route's `middleware` list. It returns the downstream `Response` unchanged (status, headers and body, which it never reads) and records that response's status. When the router's error handler turns a thrown error into a response, it records that response's status. Telemetry failures never change the response: they are logged with `console.warn` unless `silent: true`. By default (`fireAndForget: true`) it returns the response without waiting for the event POST to finish.

### authfn

Mint short-lived test tokens (TTL ≤ 3600s) and inject bearer auth into collection runs.

```typescript
import { mintTestToken, createAuthfnCollectionMiddleware } from "@apifn/core";

const { token, expiresAt } = await mintTestToken(
  { baseUrl: "https://auth.example.com", adminKey: process.env.AUTHFN_ADMIN_KEY },
  { ttl: 900, scopes: ["read"] },
);

const client = createAuthfnCollectionMiddleware(baseHttpClient, token);
```

### secfn

Fetch (non-consuming) rate-limit information for endpoints.

```typescript
import { fetchRateLimits } from "@apifn/core";

const limits = await fetchRateLimits(rateLimiter, ["GET /users"]); // RateLimitInfo[]
```

### logfn

Structured reporter and CLI logger.

```typescript
import { logfnReporter, createCliLogger } from "@apifn/core";

const logger = createCliLogger({ /* CliLoggerOptions */ });
```

### testfn

Adapter that plugs ApiFn collection runs into testfn. It lives in the `@apifn/core/testfn` subpath so that the root entry never loads testFn; install `@testfn/core` (`>=0.0.2 <0.1.0`) and `@apifn/collections` at the release that matches your `@apifn/core` yourself to use it. Importing the subpath without `@testfn/core` fails with a module-not-found error naming `@testfn/core`; the adapter loads `@apifn/collections` when `discover()` or `run()` is called, and those calls fail with an error naming `@apifn/collections` if it is missing. Installing `@apifn/core` alone installs neither package. `@testfn/core` is ESM-only: the CommonJS build of `@apifn/core/testfn` `require()`s it, so CommonJS use needs a Node.js version with `require(esm)` (20.19+ or 22.12+), and its CommonJS type declarations import `@testfn/core` with `resolution-mode` `import`, which needs TypeScript 5.3+.

```bash
npm install @testfn/core @apifn/collections
```

```typescript
import { ApifnTestAdapter } from "@apifn/core/testfn";
```

The adapter requires `@apifn/collections` 0.0.5 or later. Pass `allowScripts: true` to the adapter constructor only for trusted collections. Pass a `processEnv` object with the specific values needed by collection templates.
Discovered test IDs use the collection-relative request path. Rediscover saved test selections if multiple requests in a suite share a display name.

---

## Exports

```typescript
// OpenAPI
export { fromRouter, introspectRouter, generateOpenAPI, parseOpenAPI, validateOpenAPI, upconvertFrom3_0 }

// Schema
export { detectSchemaType, convertSchema, convertZodSchema, convertTypeBoxSchema, deduplicateSchemas, apiSchema }

// Diff
export { diffOpenAPI, formatDiffAsText, formatDiffAsJson }

// Request idempotency
export { createRequestIdempotency, canonicalJson, normalizeIdempotentResponse, sha256Fingerprint }

// Integrations
export { fetchEndpointMetrics, createWatchFnClient, apifnWatchMiddleware }
export { mintTestToken, createAuthfnCollectionMiddleware }
export { fetchRateLimits }
export { logfnReporter, createCliLogger }

// Types — HTTP, OpenAPI document objects, introspection descriptors,
// diff, validation, snippets, mock, and integration types
```

The `@apifn/core/testfn` subpath exports `ApifnTestAdapter` and needs the optional `@testfn/core` peer and `@apifn/collections`.

The `@apifn/core/types` subpath exports the shared model types declared by the core package, including HTTP/OpenAPI, schema, diff, validation, snippet, mock, and integration data shapes. Types declared alongside runtime modules, such as `FromRouterOptions`, `SchemaType`, and `DiffReportJson`, are exported from the package root.

## License

MIT
