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

The spec may be a JSON/YAML string or an object, OpenAPI 3.0 or 3.1.0; it is parsed and upconverted by `@apifn/core`'s `parseOpenAPI`. Identical inputs produce byte-identical `canonicalJson(catalog)` and the same `digest` (`sha256:<hex>` over those bytes). Canonical JSON sorts every object key, including integer-like keys, by UTF-16 code unit and has no whitespace (RFC 8785 ordering), so non-JavaScript consumers can reproduce digests. Reordering object keys in the spec or manifest changes nothing. Any error diagnostic returns a `null` catalog.

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

`catalogVersion`, `api {id, version, title}`, `source {specDigest, manifestDigest, provenance}`, `serialization`, `servers`, `securitySchemes`, `operations[]` sorted by `id`, and `schemas` (component schemas reachable from operations). Schema `$ref`s are emitted in one form, `#/components/schemas/<name>` with the name escaped only by JSON Pointer rules (`~0`, `~1`; a source `a%7E1b` becomes `a~1b`); unescape `~1` and `~0` and resolve against `catalog.schemas[<name>]`. `$dynamicRef` and `$recursiveRef` are references too: they must target `#/components/schemas/<name>` and their schemas are included. Discriminator mapping targets (a schema name or reference) are emitted in the same form, and the schemas they name are included. Literal `default`/`const`/`enum` data is copied with its keys verbatim, including keys that start with `x-`; credential-like strings in it are redacted like free text (reported as `CREDENTIAL_REDACTED`), so `enum: ["token=abc123"]` becomes `["token=[REDACTED]"]`. Property names in `required` and `dependentRequired` are checked like property names and copied verbatim, never redacted, so they always match `properties`. Operations merge path-level and operation-level parameters (operation wins). Path parameters follow path-template order. Parameters keep `style`, `explode` and `allowReserved`. Form and multipart contents keep their per-property `encoding` (`contentType`, `style`, `explode`, `allowReserved`); other contents have an empty `encoding`. Responses are classified as `success`, `error` (4xx/5xx) or `default`; `x-*` response, path and OAuth flow keys are extensions and are skipped. Servers keep their `variables`. `operation.servers` holds a path- or operation-level override, or `null` to use the catalog servers; an empty override array is kept as `[]`. A document without root `servers` yields `servers: []`, not the OpenAPI default `[{url: "/"}]`; consumers apply that default.

### Credentials

Catalogs never carry `example`/`examples` or `x-*` extensions. URLs lose all user info (with or without a scheme, with or without `//` after a special scheme, however many `@` they hold), credential-like query parameters and fragments. Server URLs also lose their whole query. Server variables are judged against the original template, before stripping: a variable that fills any user info, query or fragment of the template (`https://{user}:{pass}@host`, `?api_key={k}`, `#{k}`), or that the emitted URL no longer uses, keeps no values; its default becomes `[REDACTED]` and its `enum` is dropped, each reported as `CREDENTIAL_REDACTED`. Variable values are also judged together, in the template expanded with every default and then with each `enum` value in turn: user info lying wholly inside one value is cut out of it (`svc:pw@api.test` as `{authority}` becomes `api.test`, `https://svc:pw@api.test` as `{base}` becomes `https://api.test`); any other value that reaches the user info, query or fragment of the expansion (`{prefix}{suffix}` with `svc:pw` and `@host`, or a host value ending in `?api_key=`) hides every variable that reaches it in the same way. Benign query parameters on OAuth and OpenID Connect URLs are kept.

Inside credential fields, literal `default`/`const`/`enum` values and unrecognized schema members are dropped. A credential field is one of these:

- a parameter with a credential-like name,
- a parameter at the `in` and `name` of a declared `apiKey` security scheme (header names match case-insensitively),
- a credential-named property,
- a `format: password` schema.

The rule also covers every subschema, applicator (`anyOf`, `items`, …) and component schema reached from such a field. Schema members whose names, or nested keys, name or hold a credential are dropped everywhere, as are schema `pattern`s whose literal text holds one. A credential field carries no `pattern` at all, because a pattern can spell the credential in any regex syntax (`^hunter2$`, `^(hunter2)$`, `^hunter2{1}$`). Credential-named server variables are replaced with `[REDACTED]`.

Free text copied into the catalog is redacted: descriptions, summaries, titles, tags, server and scheme descriptions, and `bearerFormat`. Identifiers and map keys are copied verbatim into generated clients, so a credential in one (an `operationId`, path template, parameter, property, discriminator mapping, component, security scheme, flow or scope name, or a manifest identifier) is an `INVALID_SPEC` or `INVALID_MANIFEST` error, never redacted. In identifiers `:` is a namespace separator, so scopes such as `secrets:read` and error codes such as `password:too_short` are names; a segment after a credential-key namespace is still a credential when one of its words (split at `_`, `.`, `-`) is token-shaped (see below) or 16+ characters long, so `password:hunter2SEED99` and `api_key:AbCdEf123456Ghij` are rejected. These count as credentials:

- the whole value after a credential-named key followed by `:`, `=`, `=>` or `:=`, in any syntax: HTTP headers (`X-Api-Key: …`), JSON (`"Cookie":"…"`, also escaped as `\"password\":\"…\"`), JS literals (`authorization: '…'`), query and connection strings (`client_secret=…`, `api%5Fkey=…`, `Pwd=…`) and prose (`Invalid API key: …`). The key is the last one or two words before the separator, tested with the same `isCredentialKey` used for field names (percent-decoded, separators ignored). The value is a quoted string (up to its closing, possibly escaped, quote; inside an escaped-quoted value the text is decoded one level, so an escaped quote such as `\\\"` does not close it, and an unescaped quote that ends the outer string first redacts to the end of the line), a balanced `{…}` or `[…]`, an `Authorization`/`Cookie` header line with every scheme parameter, a YAML block (after `password:`, `password: |`, `password: >-` and the other block indicators, every following line indented deeper than the key's line; mixed tab and space indentation is redacted to the end of the text), or a run to the next delimiter that also takes the token after a scheme word (`token=Bearer …`). A value that cannot be delimited, such as an unterminated quote, is redacted to the end of the text. The value counts at any length and even when it reads as prose (`Authorization: missing`), unless all of it is placeholders such as `<token>`, `{{token}}`, `$TOKEN` or `[REDACTED]`: `<token>abc123` is a credential. Scheme words (`Bearer`, `Basic`, …) count as placeholders only in `Authorization` and `Cookie` headers, so `client_secret=Bearer` is a credential. XML elements named like a credential count too: the value runs from the end of the opening tag, attributes included, to the matching closing tag, CDATA included (`<password type="string"><![CDATA[…]]></password>`); without a closing tag it runs to the end of the text, unless the tag is a bare placeholder (`<password>` followed by a space, punctuation or the end). Every attribute value of such an element is a credential too (`<password id="…" value="…"/>`),
- the value field (`value`, `values`, `val`, `content`, `data`, `default`, `example`, `examples`, and `headerValue`, `fieldValue`, `paramValue`, `parameterValue` with `_` or `-` allowed) of a container whose name field (`name`, `key`, `header`, `field`, `param`, `parameter`, and `headerName`, `fieldName`, `paramName`, `parameterName`) holds a credential key, in either order: `{"name":"X-Api-Key","value":"…"}`, `{key: 'client_secret', value: '…'}`, `<add key="password" value="…"/>`. A container is the innermost `{…}`, `[…]` or XML tag (or the whole text). Strings are skipped: a delimiter inside `"…"`, `'…'`, `` `…` `` or an escaped-quoted `\"…\"` neither opens nor closes a container (`{"name":"password","note":"}","value":"…"}`). When the structure cannot be trusted (an unterminated or ambiguous quote, or a closer that does not match the innermost open container) the whole text is one container,
- PEM private keys (`-----BEGIN … PRIVATE KEY-----`) through their `END` line, or to the end of the text when cut off,
- a standalone `Bearer`/`Basic` followed by a token-shaped word: 8+ characters with letters and digits, `+=_~`, or two lower-to-upper case changes. Plain words and version-like words are prose, so "Basic internationalization support", "Bearer authentication/authorization required" and "Basic HTTP/1.1" are kept,
- JWTs, provider keys (Stripe, GitHub classic and fine-grained `github_pat_`, Slack, AWS, Google) and URL user info. For the special schemes `http`, `https`, `ws`, `wss`, `ftp` and `file`, user info needs no `//`: as URL parsers do, any run of `/` or `\`, even none, starts the authority, so `https:svc:pw@host` and `https:\\svc:pw@host` lose `svc:pw` (in catalog URLs, free text and the catalog schema's server URL pattern).

Every rule runs in time linear in the text: no pattern rescans a long word once per character.

The failure-event validator rejects exactly the text the catalog redacts. Every removal is reported as a `CREDENTIAL_REDACTED` warning. Diagnostics and failure-event issues all pass through one sanitizer: each pointer segment is redacted as its raw key, before JSON Pointer escaping (otherwise a URL key's `//` would become `~1~1` and hide its user info), and messages are redacted as text. Parse failures report only a line and column, never source text. Authorization header parameters are ignored, as OpenAPI specifies.

### Diagnostics

| Code | Meaning |
| --- | --- |
| `INVALID_SPEC` | the document is neither a string nor an object (such as `null`), cannot be parsed or lacks `info`/`paths`, or is not plain JSON data (a cycle, getter that throws, class instance, more than 248 levels of nesting or 1,000,000 values); any OpenAPI member the catalog reads has the wrong type, such as an operation that is not an object (`get: null`), `responses: []`, `content: []`, `servers: {…}`, `tags: "x"`, `properties: []`, `required: "yes"` or a non-string description (a present value is never replaced by a default); a security scheme lacks a valid `type` or a member its type requires (as in OpenAPI 3.0/3.1: `apiKey` needs `name` and `in` of `query`, `header` or `cookie`; `http` needs `scheme`; `openIdConnect` needs `openIdConnectUrl`; `oauth2` needs `flows` with at least one of `implicit` (needs `authorizationUrl`), `password` and `clientCredentials` (need `tokenUrl`) and `authorizationCode` (needs both), each with `scopes`, possibly empty; any other flow name except an `x-*` extension is an error); a parameter is declared twice at one level (header names case-insensitively); an identifier or map key holds a credential; a path-template parameter is undeclared or a declared path parameter is not in the template; a parameter lacks a name or valid `in`; a response key is not a status, range or `default`; a path does not start with `/`; a server lacks a URL or a variable lacks a default; `security` is not an array, a requirement is not an object, or its scopes are not an array of strings (malformed requirements never become anonymous access) |
| `INVALID_MANIFEST` | the manifest is not an object (such as `null`); manifest shape error, including unknown (misspelled) fields; a name derived from a long operationId exceeds 128 characters (set `name`) |
| `MISSING_OPERATION_ID` | a spec operation has no manifest binding |
| `DUPLICATE_OPERATION_ID` | a stable ID is repeated, an operation is bound twice, or an OpenAPI operationId repeats |
| `UNMATCHED_OPERATION_BINDING` | a binding matches no spec operation |
| `NAME_COLLISION` | two names collide case- and underscore-insensitively (e.g. `getUser` / `get_user`) |
| `UNRESOLVED_REF` | a `$ref` is missing (every schema reference emitted into the catalog is checked, including those reached through a parameter, body or response outside `components`), external (bundle first), cyclic, resolves to a value of the wrong type (such as `null` or a string), or a schema ref or discriminator mapping target that is not `#/components/schemas/<name>` (including pointers into a component); references are checked by OpenAPI context, so property, header and component names are never mistaken for keywords and literal schema data is never a reference |
| `UNKNOWN_SECURITY_SCHEME` | a security requirement names an undeclared scheme |
| `UNSUPPORTED_SERIALIZATION` | no supported media type remains (error; dropped alternatives are warnings); two media types that normalize to the same type are described differently; a parameter or form encoding uses `content` or an unsupported style (the message says whether listing the type in the manifest helps or only a spec change does); the manifest lists an unsupported media type; or multipart part headers or response headers are dropped (warning) |
| `UNKNOWN_REPLACEMENT` | a deprecation replacement is not another catalog operation |
| `AGENT_POLICY_REQUIRED` | `agent.expose` without `executionPolicy`; `operation-catalog.v1` also requires a string `executionPolicyRef` when `agent.expose` is true, and `createReleaseDescriptor` rejects such an operation (`INVALID_RELEASE`) |
| `CREDENTIAL_REDACTED` | warning: a credential-like value was removed |
| `INVALID_RELEASE` | `createReleaseDescriptor` input error: a field outside the pattern or length bound of `release-descriptor.v1` (generator, package, target, release ID, or the catalog API ID, version, digests and operation IDs it copies), a credential in any of them, an operation exposed to agents without a valid `executionPolicyRef`, or input that is not plain JSON; it never throws, and it reads its input once, so getters cannot change a value after it was checked |

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

`validateClientFailureEvent(input)` returns `{ ok: true, event }` (canonical, round-trippable) or `{ ok: false, issues }`; it never throws, and non-plain objects (Maps, Dates, class instances, functions), cycles and nesting deeper than 256 levels are `TYPE` issues. Its cost is bounded by the event size limit, not by the input: reading stops as soon as the event exceeds 8192 bytes (`TOO_LARGE`, before any key or value is scanned), after 1,000,000 values (an array's length is checked before it is read) or after 32 problems. It reads the input once into a plain-data snapshot and validates and returns exactly that snapshot, so a getter cannot change a value after it was checked. Events (`apifn.client-failure/v1`) carry `eventId`, `occurredAt`, `api`, `operation {id, name?, method?, pathTemplate?}`, `release {releaseId, catalogDigest?, sdk?}`, `failure {kind, httpStatus?, errorCode?, message?, retryable?, attempt?}`, and optional `runtime`, `correlation` and `attributes`. The validator rejects, rather than trims, any of these:

- unknown fields, including `Object.prototype` names such as `constructor` or `__proto__`,
- credential-bearing keys (`authorization`, `cookie`, `*token*`, `*secret*`, `*password*`, `*api_key*`, …, with `_`, `.` or `-` anywhere inside, as in `pass_word`) and keys that hold a credential; the schema's `propertyNames` pattern is generated from the same fragment list,
- credential-like values; fields restricted to an identifier pattern (`errorCode`, IDs, versions, names) use the identifier rule, where `:` is a namespace separator (`token:expired` is a valid `errorCode`, `token=abc123` is not),
- path templates with query strings,
- `occurredAt` values that are not real UTC calendar dates and times,
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
