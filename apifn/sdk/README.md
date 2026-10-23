# @apifn/sdk

Generates installable SDK packages from an ApiFn operation catalog ([`@apifn/contracts`](../contracts)) through target adapters. Each target implements one contract; this package ships the TypeScript `fetch` target. The same catalog, config, generator version and target version always produce the same bytes.

```ts
import { generateSdk, writeSdk, SDK_TARGETS } from "@apifn/sdk";

const result = generateSdk({ catalog, config, targets: SDK_TARGETS });
if (!result.ok) throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
const written = await writeSdk("packages/projects-sdk", result);
```

From the command line: `apifn sdk generate --sdk-config sdk.config.json --catalog catalog.json --out packages/projects-sdk` (see [`@apifn/cli`](../cli)).

## SDK config

```json
{
  "target": "typescript",
  "unsupported": "fail",
  "options": {
    "package": { "name": "@example/projects-sdk", "version": "1.0.0", "description": "…", "license": "MIT" },
    "clientName": "ProjectsClient",
    "baseUrl": "https://api.example.com/v1",
    "timeoutMs": 30000,
    "retry": { "maxAttempts": 3, "baseDelayMs": 200, "maxDelayMs": 5000 },
    "typeNames": { "Error": "ApiProblem" }
  }
}
```

- `unsupported`: `fail` (default) fails generation when the target cannot express an included operation; `exclude` leaves it out, lists it in the manifest with reason `unsupported` and marks the artifact `complete: false`. Operations are never omitted silently: `sdk.include: false` and `sdk.excludeTargets` exclusions are listed too.
- Unknown fields anywhere are errors (`SDK_INVALID_CONFIG`).

## Artifact manifest

Every package gets `apifn.sdk-manifest.json` (`apifn.sdk-artifact/v1`): generator and target name/version, package identity, API identity, catalog digest with its spec and manifest digests, a digest of the resolved config, the release ID, included and excluded operations, the custom-code area, the sha256 of every owned file and the generation warnings. The release ID is the one `createReleaseDescriptor` derives for this catalog, generator and package; it is what generated clients report in failure observations. A release descriptor for an artifact with `complete: false` lists operations the package does not contain, so such an artifact should not be released.

## Regeneration

`writeSdk(outDir, result, { dryRun })` plans every change before writing:

- Owned files (those listed in the previous manifest) are rewritten only when their contents change, so an unchanged file keeps its timestamp. Owned files a new generation no longer produces are deleted.
- Seeds are written once, when missing, in the custom-code area (`src/custom/` for TypeScript). Nothing in that area is ever rewritten or deleted.
- An existing file the generator does not own, a symlinked or non-directory ancestor, or an unreadable manifest is an `SDK_OUTPUT_CONFLICT`; nothing is written. An owned file edited by hand is replaced with an `SDK_OWNED_FILE_MODIFIED` warning.
- Before any owned file changes, an interim manifest records the paths this run may create and, in `pendingFiles`, the digests it writes, while keeping the previous generation's provenance and digests. After an interruption the rerun treats either version of a file as generated (no spurious `SDK_OWNED_FILE_MODIFIED`), and the final manifest always replaces the interim one, even when it equals the previous manifest (repairing an edited or deleted owned file); a failed write removes its temporary file.
- One run at a time writes an output directory, across calls and processes: `writeSdk` creates `.apifn-sdk.lock` in it exclusively before reading the previous manifest and removes it after the final manifest, including when it fails or throws. A dry run (`apifn sdk generate --check`) only reads: it creates, changes and removes nothing, so it works on a read-only directory, and it never takes the lock but reports one held before or during its planning as `SDK_OUTPUT_CONFLICT`. After planning it re-checks every file it read (contents, and each file's inode and change time); if another run wrote any of them meanwhile, even restoring the same contents or creating the directory, it plans again, and after three such changes returns `SDK_OUTPUT_CONFLICT` rather than a plan for a mix of generations. A run that finds the lock returns `SDK_OUTPUT_CONFLICT` naming the holder's process, host and start time, and changes nothing. A lock is never taken over: one left by a crashed run must be removed by hand, after which the rerun recovers through the interim manifest. The lock file is never generated, owned or packed.

## TypeScript target

The generated package has no runtime dependencies and builds with its pinned TypeScript (`npm run build`, run by `prepack`). It contains `src/runtime.ts`, `src/models.ts` (one type per component schema), `src/client.ts` (the client class, per-operation `Params`, `Result` and `Error` types, `OperationErrors` and `isOperationError`), `src/index.ts`, and the `src/custom/index.ts` seed, whose exports are re-exported from the package entry.

| Concern | Behavior |
| --- | --- |
| Destination | Requests go only to `baseUrl`: the consumer's, else the config's; one of them is required. Catalog and operation `servers` are never used (an operation with its own servers gets an `SDK_SERVERS_IGNORED` warning). Redirects are not followed, path parameters cannot be empty or `.`/`..`, and the built URL must keep the base origin and path. |
| Parameters | One params object with camelCase keys plus `body`. Path and header `simple`, query `form` (explode or not) and `deepObject`, `allowReserved` (reserved characters kept except `#`); absent optional values are omitted. Values are strings, finite numbers and booleans, arrays of them, and objects whose members are them (null members are skipped); a `deepObject` value is such an object. A parameter whose schema has an array item or object member admitting only nested objects or arrays, or a `deepObject` parameter admitting no object, is unsupported; a schema that also admits nested values is narrowed in `Params` to what is sent (`ParamValue<T>`, `DeepObjectValue<T>`). The analysis follows component references to any depth, whatever other operations refer to them; a schema nesting `allOf`/`anyOf`/`oneOf` more than 64 levels deep is unsupported rather than guessed. Cookie parameters are unsupported. |
| Bodies | JSON (`application/json`, `application/*+json`), `text/plain` and `application/octet-stream` requests; form and multipart are unsupported. Operations fetch cannot send (`TRACE`, or a request body on `GET` or `HEAD`) are unsupported, and a request fetch would refuse to build fails as `validation` before anything is sent. Responses decode by media type. An empty body is no content for HEAD, 204, 205, 304, no media type or JSON (an empty JSON success is a `decode` error); with a text or binary media type it is no content when the status documents no content (any 2xx kind for a success, the matched entry for an error), else `""` or an empty `Uint8Array`. A HEAD response never has a body, so every status a HEAD operation documents, success or error, is typed and declared as no content. A 2xx body of a kind the operation does not document is a `decode` error. |
| Credentials | `credentials` by scheme name: bearer (`http bearer`, `oauth2`, `openIdConnect` access tokens), `http basic` (`{ username, password }`), `apiKey` in a header or query. Values may be functions resolved per call. The first credentialed alternative, in catalog order, whose credentials are all set is used; an anonymous alternative (optional authentication) is used only when none is, so configured credentials are still sent. With none satisfied, no credentials are sent. A credential is the only value sent under its name: an API key replaces a header parameter with its name (ignoring case) and drops every query pair whose decoded name is its name or a `deepObject` member of it (`name[...]`), including pairs a reserved-expansion (`allowReserved`) value forms with `&` and `=`. A required query or header parameter with an API key's name is optional in `Params` and is rejected as `validation` only when the applied credentials do not supply it. Cookie API keys, other HTTP schemes and `mutualTLS` are unsupported; operations with no usable alternative are unsupported. |
| Errors | `ApiError` with `kind` (`network`, `timeout`, `http`, `decode`, `validation`, `aborted`, `unknown`). Only 2xx responses are results; every other status throws `ApiHttpError`, which carries `status`, decoded `body`, `headers` and `declared`, true when the operation documents the status (exact, range or `default`, including 1xx and 3xx) and the body kind. `isOperationError(error, id)` narrows to the operation's typed errors, so a documented redirect body is typed as an error, never as the result. |
| Timeouts and cancellation | `timeoutMs` per attempt, including reading the body (`ApiTimeoutError`); it also bounds resolving credentials. A caller `AbortSignal` cancels the call, credential resolution and any backoff (`ApiAbortError`, never retried). Both take effect even when a credential provider, a custom `fetch` or a body stream ignores the signal; the response body of an abandoned attempt, including one that arrives late, is cancelled so it stops being read. |
| Retries | `maxAttempts` from 1 to 10 in total. Reads (GET, HEAD, OPTIONS) retry on network errors, timeouts and 408, 429, 500, 502, 503, 504 with exponential backoff capped at `maxDelayMs`, honoring `Retry-After`. Writes retry only when the catalog declares that the server makes them idempotent; method, schema, an `Idempotency-Key` parameter or the SDK config grant nothing (`retry.idempotentOperations` is rejected). Catalog v1 has no idempotency field yet, so no write is retried; the runtime's declared-idempotent path waits for that field (SFNS-30). A stream body is never retried. |
| Observation | `onFailure` receives an `apifn.client-failure/v1`-shaped event per failed call (operation, release, failure kind, status, attempt; no URLs, values, bodies or credentials). Nothing is observed unless it is set, and a throwing or rejecting hook never changes the call's result. |
| Transport | `fetch` is injectable; it defaults to the global `fetch`. Node 18+ is verified here; browser and edge runtimes are not yet (SFNS-26). |

Names that would collide (a schema and a runtime export or an operation's types, two schemas with one type name, two parameters with one key, an operation named after a member JavaScript calls implicitly (`constructor`, `then`, which would make the client awaitable, `toJSON`, or any other `Object.prototype` member such as `toString`, `valueOf` or `hasOwnProperty`), a client or operation type named after a `client.ts` binding or global such as `ApiRuntime`, `Models`, `OPERATIONS`, `Promise` or `Record`, or two files differing only in case) are `SDK_NAME_COLLISION` errors; rename schemas with `typeNames` and operations with the catalog manifest's `name`.

Component schemas that refer to each other in a cycle outside any object or plain array type (`A = B`, `B = A | number`) cannot be TypeScript type aliases: the reference that closes each cycle, found by a depth-first search in name order, is typed `unknown` with an `SDK_SCHEMA_CYCLE` warning. TypeScript resolves some references inside tuple types eagerly (`[A[]?, ...number[]] | B`), so a reference anywhere inside a tuple, outside an object type, counts as part of such a cycle and recursive tuples lose that precision. Recursion through an object property or a plain array keeps its precise type.

## Adding a target

A target implements `SdkTarget` (`src/types.ts`): `id` and pinned `version`, `customCodeRoot`, `resolveOptions` (validates its `options`, unknown fields are errors), `packageOf`, `unsupportedReasons` (per operation; empty means supported) and `emit` (files and diagnostics from the context alone). `emit` reports `SDK_NAME_COLLISION` for operation names its language reserves or calls implicitly on a client object (for TypeScript, the set above). `generateSdk` validates the catalog against `operation-catalog.v1`, selects operations (`sdk.include`, `excludeTargets`, then support), derives the release ID, checks every emitted path, and writes the manifest; `writeSdk` applies the ownership and lock rules above to every target (`.apifn-sdk.lock` and `apifn.sdk-manifest.json` are reserved paths).

## Shared fixtures

`fixtures/` is shared with every target (`@apifn/sdk/fixtures/*`):

- `catalog/`: an OpenAPI document and manifest covering every case below, and the `catalog.json` built from them.
- `typescript/sdk.config.json`: the TypeScript config used by the tests.
- `vectors/serialization.json`, `auth.json`, `errors.json`, `retry.json`: language-neutral request, credential, response and retry cases keyed by wire names. Each target runs them against a local HTTP server.
- `vectors/parameters.json`: parameter schemas a target must support, narrow or report as unsupported (with the reason); checked at generation time.

## Verification

```bash
npx turbo run build typecheck test lint --filter=@apifn/sdk... --filter=@apifn/cli...
```

The tests generate the fixture SDK, type-check and compile it with TypeScript, and run the vectors, timeouts, cancellation, host binding and observation against a local server. `test` then runs `verify:packed` (also runnable alone after `npm run build`), so turbo builds the package first and CI runs the clean install. `verify:packed` generates the package outside the monorepo, installs its pinned TypeScript, type-checks and packs it, installs the tarball into a clean consumer, compiles a typed consumer and runs it against a local server (needs registry access). Set `UPDATE_FIXTURES=1` to rebuild `fixtures/catalog/catalog.json` after changing the fixture spec.
