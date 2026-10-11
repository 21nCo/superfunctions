# @apifn/contracts

Versioned contracts shared by ApiFn SDK generators, agent tools, failure reporting and documentation:

- an **operation catalog** built from a reviewed OpenAPI document plus a companion manifest,
- a **release descriptor** for generated artifacts,
- a bounded, secret-free **client-failure event** envelope,
- JSON Schemas and shared JSON fixtures for all of the above.

OpenAPI stays the interoperable spec. The manifest adds the identity and policy that OpenAPI cannot carry reliably.

## Installation

```bash
npm install @apifn/contracts
```

## Entry points

| Import | Contents | Runtime |
| --- | --- | --- |
| `@apifn/contracts` | everything below; the catalog builder parses specs with `@apifn/core` | Node |
| `@apifn/contracts/failure-event` | `validateClientFailureEvent`, limits and types | any (no `@apifn/core`, no Node built-ins) |
| `@apifn/contracts/schemas/<name>.v1.schema.json` | JSON Schema 2020-12 for `manifest`, `operation-catalog`, `release-descriptor`, `client-failure-event` | data |
| `@apifn/contracts/fixtures/...` | shared fixtures (see below) | data |

## Building a catalog

```ts
import { buildOperationCatalog, canonicalJson } from "@apifn/contracts";

const { catalog, digest, diagnostics } = buildOperationCatalog(openapiJsonOrYaml, manifest);
if (!catalog) throw new Error(diagnostics.map((d) => `${d.code} ${d.pointer}: ${d.message}`).join("\n"));
writeFileSync("catalog.json", canonicalJson(catalog));
```

The spec may be a JSON/YAML string or an object, OpenAPI 3.0 or 3.1.0; it is parsed and upconverted by `@apifn/core`'s `parseOpenAPI`. Identical inputs produce byte-identical `canonicalJson(catalog)` and the same `digest` (`sha256:<hex>` over those bytes). Reordering object keys in the spec or manifest changes nothing. Any error diagnostic returns a `null` catalog.

### Companion manifest

```json
{
  "manifestVersion": 1,
  "api": { "id": "example.projects", "version": "2026-10-01" },
  "serialization": { "mediaTypes": ["application/json", "application/problem+json"] },
  "provenance": { "source": "openapi.json", "revision": "af261f9", "exporter": "@apifn/core#generateOpenAPI" },
  "operations": [
    { "id": "projects.get", "method": "get", "path": "/projects/{projectId}", "name": "getProject" },
    { "id": "projects.list", "operationId": "listProjects", "agent": { "expose": true }, "executionPolicy": "policy.read-only" },
    { "id": "projects.delete", "operationId": "deleteProject", "deprecation": { "replacement": "projects.archive", "since": "2026-09-01" } },
    { "id": "projects.archive", "operationId": "archiveProject", "sdk": { "excludeTargets": ["python"] } }
  ]
}
```

- `id` is the stable operation identity. Bind it with `operationId`, or with `method` + `path` to survive operationId renames. `name` overrides the generated method/tool name; changing it never changes `id`.
- `sdk.include` (default `true`) and `agent.expose` (default `false`) are separate switches. Exposing an operation to agents requires an `executionPolicy` reference.
- HTTP method, schema presence and inclusion never grant authorization or idempotency. The catalog has no such fields. `security.alternatives` lists the credential combinations the API accepts (OR of ANDs, `[[]]` = anonymous); it grants nothing.
- `serialization.mediaTypes` (default `["application/json"]`) lists what clients must support: JSON (`application/json`, `application/*+json`), `text/plain`, `application/octet-stream`, `application/x-www-form-urlencoded` and `multipart/form-data`.

### Catalog shape

`catalogVersion`, `api {id, version, title}`, `source {specDigest, manifestDigest, provenance}`, `serialization`, `servers`, `securitySchemes`, `operations[]` sorted by `id`, and `schemas` (component schemas reachable from operations). Schema `$ref`s keep the form `#/components/schemas/<name>`; resolve them against `catalog.schemas[<name>]`. Operations merge path-level and operation-level parameters (operation wins). Path parameters follow path-template order. Responses are classified as `success`, `error` (4xx/5xx) or `default`.

### Credentials

Catalogs never carry `example`/`examples`, `x-*` extensions, URL user info, query strings or fragments, or literal `default`/`const`/`enum` values of credential-named fields. Recognizable credentials in text (bearer/basic tokens, JWTs, provider keys, `token=` pairs) are replaced with `[REDACTED]` and reported as `CREDENTIAL_REDACTED` warnings. Authorization header parameters are ignored, as OpenAPI specifies.

### Diagnostics

| Code | Meaning |
| --- | --- |
| `INVALID_SPEC` | the document cannot be parsed, lacks `info`/`paths`, or a path-template parameter is undeclared |
| `INVALID_MANIFEST` | manifest shape error, including unknown (misspelled) fields |
| `MISSING_OPERATION_ID` | a spec operation has no manifest binding |
| `DUPLICATE_OPERATION_ID` | a stable ID is repeated, an operation is bound twice, or an OpenAPI operationId repeats |
| `UNMATCHED_OPERATION_BINDING` | a binding matches no spec operation |
| `NAME_COLLISION` | two names collide case- and underscore-insensitively (e.g. `getUser` / `get_user`) |
| `UNRESOLVED_REF` | a `$ref` is missing, external (bundle first), cyclic, or a schema ref outside `#/components/schemas` |
| `UNKNOWN_SECURITY_SCHEME` | a security requirement names an undeclared scheme |
| `UNSUPPORTED_SERIALIZATION` | no supported media type remains (error; dropped alternatives are warnings), a parameter uses `content` or an unsupported style, or the manifest lists an unsupported media type |
| `UNKNOWN_REPLACEMENT` | a deprecation replacement is not another catalog operation |
| `AGENT_POLICY_REQUIRED` | `agent.expose` without `executionPolicy` |
| `CREDENTIAL_REDACTED` | warning: a credential-like value was removed |
| `INVALID_RELEASE` | `createReleaseDescriptor` input error |

## Release descriptors

```ts
const { descriptor } = createReleaseDescriptor({
  catalog,
  generator: { name: "@apifn/sdk-typescript", version: "0.1.0" },
  artifacts: [{ kind: "sdk", target: "typescript", package: { name: "@example/projects-sdk", version: "2026.10.1" } }],
});
```

These version axes stay separate: `descriptorVersion`, `api.version`, `specDigest`, `manifestDigest`, `catalogDigest`, `generator.version`, each artifact's package version, and `releaseId`. Each artifact lists the stable operation IDs it exposes: SDK targets honor `sdk.include` and `excludeTargets`; `agent-tools` artifacts honor `agent.expose`. Without an explicit `releaseId`, the descriptor derives `rel_<24 hex>` from its content.

## Client-failure events

`validateClientFailureEvent(input)` returns `{ ok: true, event }` (canonical, round-trippable) or `{ ok: false, issues }`. Events (`apifn.client-failure/v1`) carry `eventId`, `occurredAt`, `api`, `operation {id, name?, method?, pathTemplate?}`, `release {releaseId, catalogDigest?, sdk?}`, `failure {kind, httpStatus?, errorCode?, message?, retryable?, attempt?}`, and optional `runtime`, `correlation` and `attributes`. The validator rejects, rather than trims, any of these:

- unknown fields,
- credential-bearing keys (`authorization`, `cookie`, `*token*`, `*secret*`, `*password*`, `*api_key*`, …),
- credential-like values,
- path templates with query strings,
- fields over their UTF-8 byte limits (message 1024, attribute value 256, at most 32 attributes),
- events over 8192 bytes serialized.

## Fixtures

- `fixtures/catalog/`: an OpenAPI document with inherited path parameters, component refs, auth alternatives, error responses and deprecation, plus its manifest, expected `catalog.json` and `release-descriptor.json`.
- `fixtures/parity/`: the same routes exported by `generateOpenAPI` (`@apifn/core`, via `fromRouter`) and `generateOpenApiDocument` (`@superfunctions/http-openapi`), with a shared manifest. Their catalogs are equal except for these documented differences:
  - `generateOpenApiDocument` cannot express query parameters or deprecation; the manifest's deprecation fills the gap.
  - It names responses `HTTP <status> response`.
  - It emits `200 Success` for routes without response schemas.
- `fixtures/client-failure/valid|invalid/`: envelope fixtures. Invalid files hold `{ description, expectedIssues, event }`.

## Verification

```bash
npx turbo run build typecheck test lint --filter=@apifn/contracts...
npm run build --workspace @apifn/contracts && npm run verify:packed --workspace @apifn/contracts
```

`verify:packed` packs the workspace, installs the tarball into a clean temp project outside the monorepo, and imports the ESM and CJS exports there. It also checks that the `failure-event` graph has no `@apifn/core` or Node built-ins. Set `UPDATE_FIXTURES=1` when running tests to regenerate committed fixtures after an intentional contract change.
