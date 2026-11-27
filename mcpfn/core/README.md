# McpFn Core

`defineMcpFnServer()` creates a side-effect-free declaration whose registry and
manifest are shared by runtime, tests, and release tooling. Call
`declaration.createServer()` once per transport connection. Existing
`createMcpFnServer()` usage remains supported.

Declare protocol capabilities on `defineMcpFnServer()`. Per-connection runtime
options provide context, visibility, task storage, and transport behavior but
cannot add capabilities, so `declaration.manifest()` and every runtime manifest
remain byte-for-byte identical. When combining a supplied registry with inline
definitions, the declaration clones the registry before adding them.

`@mcpfn/core` is the shared MCP runtime for Superfunctions. It delegates wire protocol and transport behavior to the official Model Context Protocol SDK while providing the pieces product code needs to remain stable:

- an explicit, validated tool, resource, template, and prompt registry;
- authenticated, versioned client-profile catalog projection and trusted enrichment;
- actionable, value-free JSON Schema diagnostics;
- pagination, completions, subscriptions, and task-capable tools;
- server-initiated roots, sampling, elicitation, logging, and list-change notifications;
- MCP Apps resource and tool-link contracts;
- consistent structured and text results;
- deterministic, hashed manifests;
- breaking, additive, and model-behavior compatibility classification;
- stdio, Web Standard Streamable HTTP, and in-memory transport support through the official SDK.

```ts
import {
  McpFnRegistry,
  createMcpFnServer,
  structuredResult,
} from "@mcpfn/core";

const registry = new McpFnRegistry()
  .register({
    name: "greet",
    description: "Greet one person by name.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { greeting: { type: "string" } },
      required: ["greeting"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: async ({ name }) =>
      structuredResult({ greeting: `Hello, ${String(name)}!` }),
  });

const server = createMcpFnServer({
  info: { name: "example", version: "1.0.0" },
  registry,
  transports: ["stdio", "streamable-http"],
});

await server.serveStdio();
```

Tool definitions are public contracts. Do not derive tool names, descriptions, or exposed fields from storage schemas without an explicit exposure manifest.

## Tools from an OpenAPI document

`fromOpenAPI()` from `@mcpfn/core/openapi` turns the operations of a parsed
OpenAPI 3.0 or 3.1 document into tools on an `McpFnRegistry`. Parse YAML
yourself; the function takes the document object. Calls go to the executor you
pass; each handler forwards the arguments the registry validated, unchanged.

```ts
import { fromOpenAPI } from "@mcpfn/core/openapi";

const { registry, tools, skipped } = fromOpenAPI(document, {
  executor: { execute: ({ operation, args, signal }) => send(operation, args, signal) },
  include: ["listPets", "tag:stores", "GET /health"],
  exclude: ["tag:internal"],
  prefix: "petstore.",
});
for (const { operation, code, reason } of skipped) {
  console.warn(`${operation.method ?? "*"} ${operation.path}: ${code} (${reason})`);
}
```

- **Exposure.** Only `GET` and `HEAD` are exposed by default. Any other method
  needs its operationId in `include` or `allowMutations: true`; a `tag:` or
  `METHOD /path` selector selects an operation but does not opt a mutation in.
  `{ operationId: "<id>" }` selects an operationId exactly, for one that reads
  as a tag or route selector (such as `{ operationId: "tag:pets" }`), and
  opts it in like a plain operationId.
  When `include` is given, nothing outside it is exposed, and `exclude` always
  wins. Deprecated operations need `includeDeprecated: true`.
- **Names.** The operationId, with `prefix` prepended, characters outside
  `[A-Za-z0-9_.-]` replaced by `_`, and truncated to 128 characters. Without an
  operationId the name is `<method>_<path segments>`, such as
  `get_users_userId_posts`. Collisions, including with tools already on a
  supplied registry, get `_2`, `_3`, ... in document order; an operation
  skipped at registration does not take a name. A `name(operation)`
  callback replaces this; an invalid or duplicate result throws an error naming
  the operation before anything is registered.
- **Inputs.** The input schema is `{ path, query, header, body }`, each group
  present only when the operation has such inputs. The wrapper and the
  `path`, `query` and `header` groups have `additionalProperties: false`;
  `body` follows its own schema. Referenced component schemas are copied
  under `definitions` (draft-07). `readOnly` properties (flagged on the
  property, on a schema it references, on an `allOf` member, or on every
  non-null alternative of an `anyOf`/`oneOf` such as
  `anyOf: [{ $ref }, { type: "null" }]`) are left out of inputs where they are
  declared: the property becomes `false` (or is dropped from an object closed
  by `additionalProperties: false`) and leaves that object's `required`, so
  the name is refused whatever `patternProperties` or `additionalProperties`
  say. This is done only along a plain chain from the body: `properties`, one
  `items` schema, a schema-valued `additionalProperties`, `allOf`, `$ref`, and
  `anyOf`/`oneOf` members that accept different kinds of value (an object
  and `null`, an object and an array). The operation is skipped
  (`unsupported-access-flag`) when a flagged property sits under alternatives
  that can accept the same kind of value, `not`, `if`/`then`/`else`, a
  dependency, `patternProperties`, `contains`, tuple `items`,
  `additionalItems` or `propertyNames`; when another schema for the object
  requires the name or has `const`, `enum`, `minProperties` or a dependency;
  when a conditional schema for the object lists the name or has
  `maxProperties`, `patternProperties`, `propertyNames` or a closed
  `additionalProperties`; or when a child value holding flagged properties
  has more than one schema, sits under a condition, or is compared whole
  (`const`, `enum`, `uniqueItems`, `contains`). Patterns in the document are
  never evaluated for this. In OpenAPI 3.0 every `$ref` sibling is ignored, `readOnly`
  and unsupported keywords included; in 3.1 they apply. The request
  body is the first `application/json` media entry that is an object, else the
  first such `*+json` one; a declared body without a JSON media type is
  skipped (`non-json-body`), one whose JSON entries are not usable objects or
  that declares no content is skipped (`invalid-request-body`), and a media
  entry without `schema` accepts any JSON value. `Authorization`, `Cookie`,
  `Host`, `Content-Length`, `Proxy-*`, `Accept` and `Content-Type` headers are
  never inputs: credentials and transport headers belong to the executor.
- **Parameters.** A path, query or header parameter must accept either single
  primitive values or arrays of primitives, judged through `$ref`, `allOf`,
  `anyOf` and `oneOf`; `null` may accompany either. A parameter that can be an
  object (including a schema without `type`, `enum` or `const`, such as `{}`),
  an array of objects or arrays, or both an array and a single value is skipped.
- **Outputs.** The selected response schema is the first `application/json`
  entry with a `schema`, scanning 2xx responses in order. It is always
  converted, for `HEAD` too, so the skip rules apply to it whatever its
  shape or method; a schema that is discarded, or whose `writeOnly`
  properties are left out, is first compiled by mcpFn's validator as
  written. A `HEAD` tool never declares an output schema, since its response
  has no body. When the executor sets `outputSchemaRule: "every-success"`
  (as `httpExecutor` does), neither does an operation that documents a
  `default` response (which covers the 2xx statuses not listed, the
  bodyless `204` and `205` among them) or whose documented 2xx responses do
  not all offer only JSON content with that same schema (such as a `200`
  with a body beside a `204`, a `2XX` range, which also covers the bodyless
  `204` and `205`, `201` and `202` with different bodies, or a JSON body
  beside `text/plain`), since a call could succeed with a body the schema
  does not describe, or with none. Under that rule a schema
  written on a `204` or `205` entry is neither converted nor compiled, and
  two responses count as having the same schema when it is the same object
  or written identically (compared once per pair of shared values, within a
  fixed budget; past it, no output schema). Otherwise the schema becomes
  the output schema when it accepts objects and nothing else (also through a 3.1 `$ref` with sibling
  keywords, an `allOf`, or a `not` of bare types such as
  `not: { type: "null" }`), with `writeOnly` properties left out by the same
  rule as `readOnly` ones in inputs; when that rule cannot be applied, the
  operation is skipped (`unsupported-access-flag`), so no tool returns
  structured content its schema did not check.
- **Paths.** `x-*` entries of the Paths Object are extensions and are ignored.
- **Annotations and description.** `GET`/`HEAD` are `readOnlyHint`, `DELETE`
  is `destructiveHint`, `PUT`/`DELETE` are `idempotentHint`, and every tool is
  `openWorldHint`. The description is the trimmed summary and description,
  joined by a blank line and capped at 2,000 characters.
- **Supported forms.** Local `#/components/{schemas,parameters,requestBodies,responses}/<name>`
  references (recursive schemas included when the recursion descends into a
  property or item); path- and operation-level parameters
  in `path`, `query` and `header` with their default styles over primitives and
  arrays of primitives; `application/json` and `*+json` bodies; OpenAPI 3.0
  `nullable`, which adds `null` to an explicit `type` only (an `enum` keeps
  excluding `null` unless it lists it). Anything else is listed in `skipped` with a code and reason:
  external or URL references, `cookie` parameters, a parameter named after
  a property every object inherits (`__proto__`, `toString`, `constructor`,
  ...) (`unsupported-parameter-name`), and a schema that declares, requires
  or lists in a dependency such a name, in a body or a response
  (`unsupported-property-name`), with no exception, under either engine: Ajv reads those names through the
  prototype (and leaves a `__proto__` key of `properties` out) while
  @cfworker/json-schema reads own properties only. Also skipped:
  non-default styles,
  object-valued or mixed parameters, bodies without a JSON media type, a
  `$ref` cycle that returns to the same value without descending into a
  property or item, and the 2019-09/2020-12 keywords `prefixItems`,
  `$dynamicRef`, `unevaluatedProperties`, `unevaluatedItems`,
  `dependentSchemas`, `minContains` and `maxContains` (`dependentRequired` is
  translated to draft-07 `dependencies`). A 3.1 `jsonSchemaDialect` or
  `$schema` other than a published OAS 3.1 base dialect id
  (`.../dialect/base`, `.../dialect/2024-10-25` or `.../dialect/2024-11-10`)
  or JSON Schema 2020-12,
  or any `$schema` in a 3.0 document, skips the schemas it governs
  (`unsupported-dialect`), boolean schemas included; a schema root that names
  a supported `$schema` itself is read in it, and a JSON body without
  `schema` declares none, so it accepts any JSON value in any dialect. A 3.1
  `dependencies` keyword is ignored, since 2020-12 defines none. One budget bounds all of one call's work: once
  its conversions and copies have produced 1,000,000 nodes plus 64 per value
  of the document, every schema converted after that is skipped
  (`schema-too-large`). Each tool schema copy (its root, literals included,
  and the component schemas it holds) is charged node by node as it is made,
  and so are a copy made to check a schema and each walk of a closure's
  references; a copy that fails is charged only for what it copied. Each
  tool's catalog entry copies its schemas again: that copy is charged in
  document order and given back when the tool does not register. A schema
  several tools share is compiled at its first reuse, and when the registry's
  validator rejects it, every tool holding it is skipped with that verdict
  and holds no catalog copy, so it never crowds out a later tool. No schema has a size or depth limit of its own: a schema that
  repeats objects the document shares between positions into more than four
  times the values they hold is skipped (`schema-too-large`), and a schema
  nested or referencing too deeply for the converter or the registry's
  validator to compile (a stack overflow) is skipped the same way. Under
  @cfworker/json-schema, which follows references only while validating, the
  frames one value stacks are read from the schema itself and compared with
  how deep the engine validates on the call's stack, measured once per call
  with the engine. At every position (parameters, bodies, properties and
  items) the subschemas and references applied in place count, each child
  value from its own first frame. Only the chain every valid tool input
  takes stacks on its parent's frames: from the input (or a registered
  output), a property a `required` list names, through `properties`, a matching
  `patternProperties` entry or else `additionalProperties`, when only
  objects are accepted (`number` also admits integers), every declared
  property of a closed object (`additionalProperties: false`, no
  `patternProperties`; with several, the names they all declare) whose
  `minProperties` is at least their number, less any name a member declares
  `false`, and
  the items up to `minItems` when only arrays are,
  read together from one schema object and its inline `allOf` members (for
  example `required` in one member and `properties` in another). A pattern
  is matched against required names only when it has no groups,
  alternation, backreferences or lookaround and at most one quantifier,
  with the matching charged; any other pattern forces nothing. A required
  name must be an own property (mcpFn requires @cfworker/json-schema
  `^4.1.6`, which reads own properties only). A child a
  call can leave out or avoid (an optional body or property, an
  `anyOf`/`oneOf` branch) never stacks, since a shallow valid input exists,
  and a chain of required children from the input that never ends, which
  no finite value satisfies, is too deep. This reading is charged to the same budget. Near
  the validator's own limit, that verdict is the validator's. A forced child
  whose `type`, `required` or `minItems` sits only behind a `$ref` is not
  read as forced, so such a tool can register; a call whose value then nests
  too deeply for the engine's stack is rejected by the registry like any
  other invalid arguments (`MCPFN_INVALID_ARGUMENTS`, keyword `depth`),
  never as a thrown `RangeError`. A schema compiled
  only to be checked (a `HEAD` or non-object response, or one with
  properties to leave out) is compiled once per distinct schema. A Swagger
  2.0 document throws.
- **Catalog.** `tools` holds copies of the registered schemas, so changing
  them changes neither what the registry lists nor what it validates. In a
  registry `fromOpenAPI` creates, tools with identical schemas register one
  deeply frozen object, compiled once; a supplied registry gets a fresh
  object per tool.
  `operation` is deeply frozen and typed read-only.
- **Servers.** `operation.servers` is the first non-empty `servers` list of
  the operation, path item and document, else `[{ url: "/" }]`.
- **Security.** `operation.security` is the operation's requirement list,
  else the document's, and `operation.securitySchemes` holds the schemes it
  names that `components.securitySchemes` defines (`$ref` followed, each
  name resolved at most once per conversion), each as
  `{ type, name?, in?, scheme? }`. Credentials are the executor's job (D9):
  a parameter an `apiKey` scheme of the operation sends its credential in
  (header, query or cookie) is never a tool input, whatever the executor.
- **Executor.** `execute` receives `{ operation, args, context, signal,
  hasOutputSchema, checkOutput }`: `context` is the trusted context the
  server's `context` factory built for the call, `hasOutputSchema` says
  whether a success must carry `structuredContent`, and `checkOutput(value)`
  (with an output schema) says whether the registry's output validator
  (its `compileSchema`'s, or the built-in one's) accepts a value. An executor may
  set `outputSchemaRule` (see Outputs) and implement `unsupported(operation)`,
  returning why it cannot send an operation; such operations are skipped
  (`unsupported-by-executor`) before any tool name is chosen. It may also
  implement `ownsParameter({ name, in, required })` for query and header
  parameters: one it supplies itself returns `true` and is left out of the
  tool input and `operation.parameters`, so no caller value is accepted for it.
  An executor that implements `sendsRequestMedia(contentType)` has the
  request body chosen only among the JSON entries it can send, when there is
  one, so the tool takes that entry's schema and media type together.

### Sending calls over HTTP

`httpExecutor()` is the executor that sends each call as one HTTP request to
an API the operator fixes, with credentials the operator supplies:

```ts
import { fromOpenAPI, httpExecutor } from "@mcpfn/core/openapi";

const { registry } = fromOpenAPI<{ apiToken: string }>(document, {
  executor: httpExecutor<{ apiToken: string }>({
    baseUrl: "https://api.example.com/v1",
    headers: (context) => ({ authorization: `Bearer ${context.apiToken}` }),
    timeoutMs: 30_000,
    maxResponseBytes: 1024 * 1024,
  }),
});
```

- **Where requests go.** `baseUrl` is an absolute `http:` or `https:` URL
  without credentials, query or fragment; the operation's path is appended
  to its path, and the document's `servers` are ignored. Path parameters are
  percent-encoded with `encodeURIComponent` (array items joined by commas, a
  schema-valid `null` empty), so `/`, `?` and `#` stay inside their segment.
  A call whose templated segment would be empty, `.` or `..`, or whose path
  a URL parser would rewrite (such as a template with a backslash), is
  refused with an `isError` result before anything is sent; an operation
  whose template text outside its `{name}` parts a URL parser would rewrite
  (such as `/a b` or `/café`) is skipped as `unsupported-by-executor`, by the
  same check. Query
  parameters use `form` style, arrays repeating the key; with
  `allowReserved`, `:/?@$,;[]` are sent as they are while `&`, `=`, `+` and
  `#` stay encoded so a value cannot add parameters. A `null` query or
  header value is left out. The JSON body is sent with the operation's media
  type (`application/json` or the selected `*+json` type). Operations fetch
  cannot send (`TRACE`, `GET` or `HEAD` with a request body, a required
  header fetch manages, such as `Connection`, `Sec-Fetch-Mode` or `Range`,
  a required header whose name is not an HTTP token (such as `X Bad`), or a body
  whose documented media type names a charset other than UTF-8, since the
  body is sent as UTF-8, or has a character no header can carry, such as a
  CR, LF, NUL or one above 0xFF, unless another documented JSON entry can be
  sent, which is then the one used) are skipped by `fromOpenAPI`
  as `unsupported-by-executor`, and so is an operation whose every security
  requirement needs an `apiKey` credential in the query or in a header
  fetch manages, which operator headers cannot carry, and one whose security
  is malformed (a level that is not a list, a requirement that is not a
  plain object, such as a `Map`, `Date` or class instance, or one with a
  non-enumerable key, a `security` that is not enumerable, or one held by
  a document or operation that is not a plain object (an inherited or
  prototype-getter `security`), so it never reads as absent, scopes that
  are not a list of strings; `fromOpenAPI` reports it
  to any executor as `operation.securityUnresolved`) or names a scheme that
  does not resolve (missing, an external `$ref`, a cycle, a `type` OpenAPI
  does not define such as `api-key`, a scheme object that is not a plain
  object or has a non-enumerable key, such as a non-enumerable `$ref`) or an `apiKey` scheme without a usable `name` and `in` (a header
  or cookie name must be an HTTP token, a query name not empty), since the parameter that carries its credential is then
  unknown. `fromOpenAPI` reads the document once: it copies it, reading
  each own property of each object once through its descriptor, and makes
  every decision (security included) from that copy, so no operator code
  (a getter, `toString`, `valueOf`, `Symbol.toPrimitive`, an iterator)
  runs and what is checked is what was copied. A `Date` is copied by its
  time value, a `Map` or `Set` entry by entry and a typed array by its
  bytes, whatever their prototypes; any other object as a plain object of
  its own enumerable data properties (as `structuredClone` copies a class
  instance), marked as not plain where that matters. An object is plain
  only on positive proof, never because no known slot was found: it
  carries no internal slot such as a boxed primitive's, an `ArrayBuffer`'s,
  a `DataView`'s, an `Error`'s or a `RegExp`'s (told by its slots, never by
  its prototype), its prototype is `null` or `Object.prototype` (a
  prototype that is a `Proxy` is never read; where the runtime cannot tell
  a `Proxy`, only `null` and this realm's `Object.prototype` count), it has
  no own symbol key and every own string key is an enumerable data
  property, and, when it has no own key at all (so it would read as an
  anonymous requirement), `structuredClone` of that one empty object (which
  runs no operator code) returns an ordinary object. So an iterator, an
  `Intl` object, a `URL`, `Headers`, `URLSearchParams` or `DOMException`, or
  a `Proxy`, given a `null` or `Object.prototype` prototype, is not plain
  where it would read as `{}`; without `structuredClone` no empty object is
  plain, so security fails closed. Known limits: an exotic or host object
  given such a prototype and its own enumerable keys copies as those keys
  (how JSON reads it; never as `{}`), and an object whose only state is in
  private class fields or outside it (as Node implements `Event`,
  `AbortSignal` or `TextEncoder` in JavaScript) is an ordinary object and,
  with no own key, copies as `{}`, as JSON and `structuredClone` read it;
  `DOMException` is told by its brand check. Shared objects and
  cycles stay shared. Whatever the executor, it throws
  `McpFnValidationError` ("fromOpenAPI expects a plain JSON document") when
  any object reachable from the document, `Map` and `Set` entries included,
  has an accessor (getter or setter) property, or holds a function, a
  symbol, an object `structuredClone` cannot copy (a `WeakMap`, `WeakSet`,
  `WeakRef`, `FinalizationRegistry`, `Promise`, generator or iterator,
  where the runtime can tell one) or a `Proxy` (where the runtime can tell one, as Node can; elsewhere
  a `Proxy` is read through its traps, still once per property); the error
  names the path, never a value. It sets `outputSchemaRule: "every-success"`
  (see Outputs).
- **Credentials (D9).** `headers` is a plain object (prototype
  `Object.prototype` or `null`) or a function of the server's trusted
  context (and the operation), called on every call, returning one or a
  promise of one; values are printable ASCII. Leaving `headers` out sends
  none; `null` or any other value is refused when the executor is created,
  and a function result that is not a plain object refuses the call. A record is validated once,
  when the executor is created, and that copy is sent on every call:
  changing the object later changes nothing, so rotate credentials with a
  function. A `Map`, a `Headers` or
  another realm's object is refused rather than read as empty, and so is a
  record with a symbol or non-enumerable key: every own key is sent or
  refused, so only an explicit `{}` sends no operator headers. An operator
  `Content-Type` is sent as written with a JSON body only when its media
  type is the operation's documented one, any charset it names is UTF-8, and
  it has the same other parameters (such as `profile`) as the documented media
  type, in both directions: neither has a name the other lacks or gives
  another value (names compared without case, values exactly);
  otherwise the call is refused before it is sent. With such a `Content-Type`
  in a record, the request body is chosen among the documented JSON entries
  it can label, by the same rule; when none can, an operation whose body is
  required is skipped as `unsupported-by-executor` (every call would be
  refused), and one whose body is optional stays listed (a call without a
  body can still be made) while a call with a body is refused. A function
  source is checked per call. The tool input offers only what the executor sends: the
  forbidden headers (`Authorization`, `Cookie`, `Host`, `Content-Length`,
  `Proxy-*`, `Accept`, `Content-Type`), optional transport headers
  (`Connection`, `Transfer-Encoding`, `Expect`, and the headers undici
  rewrites: `Sec-Fetch-Mode`, and `Range`, beside which it adds `identity`
  to `Accept-Encoding`; an operator entry for one is refused), optional
  headers whose name is not an HTTP token, `apiKey` credential
  parameters and, with a `headers` record, every header it sets are not
  inputs; a value injected past validation for one of them is never sent,
  and an `apiKey` credential the operator does not set goes unsent. With a
  `headers` function, whose header names are known only per call, a call
  that gives a header parameter it sets a value is refused with an
  `isError` result rather than having the value dropped; a required header
  parameter the function sets therefore refuses every call, so set such a
  header with a `headers` record, which removes it from the input. So a caller can
  neither replace nor add credentials; argument names the operation does not
  declare are never read. Nothing from the MCP client's request, such as its
  `Authorization` header, is forwarded. Every operator header value is
  treated as a secret and never appears in results or errors. The executor
  looks for each value as sent (trimmed), the credential after a scheme such
  as `Bearer`, and each value of a `Cookie` header, also percent-decoded as
  UTF-8 (a cookie parser's reading); and for echoes of these spelled with
  JSON escapes, percent escapes (also with `+` for a space) or HTML character
  references as HTML decodes them (numeric references and every named
  reference to an ASCII character, with or without the closing `;` where HTML
  allows it), one or two of these, in either order. When a credential form
  has a non-ASCII character (a percent-decoded cookie value), any named
  reference left undecoded (such as `&eacute;`) counts as an echo. A body is decoded in
  the encoding it marks or declares (a UTF-16 or UTF-8 byte order mark,
  else the `Content-Type` charset, read with quoted values respected, else
  UTF-8) and checked in that text, also with any NUL characters removed,
  and read as UTF-8; its bytes are searched for each credential in UTF-8,
  UTF-16LE and UTF-16BE at any offset, so the check never depends on the
  declared charset being honest. One whose `Content-Type` cannot be parsed
  or whose charset cannot be decoded is withheld. In a JSON body each
  number is also read as written, as a parser reads it (also under a
  duplicate key), so one that parses to a credential (`1.2345e4` for
  `12345`) is caught; a number spelled inside a string, or in a body that
  is not JSON, is left alone. Structured content is returned with its
  compact serialization as text (no pretty-printing, which deep nesting
  would multiply), and both are checked as returned.
  An error body that reveals no credential is excerpted as it is. One that
  reveals a credential is redacted only when it is plain, so its literal
  text is its only reading: UTF-8 that decodes cleanly, with no NUL and no
  byte order mark, no JSON escape, percent escape, `+` or HTML reference,
  JSON written as its compact serialization (the reading a success body is
  checked in) with every number written as it parses, and no UTF-16 form of a
  credential in its bytes. Its literal echoes (overlapping and adjacent ones
  merged) are then shown as `[REDACTED]`, never cut inside one, and the body
  with them masked, and the excerpt as returned, must reveal nothing. Any
  other body that reveals a credential is withheld whole. Redaction uses a mask of
  the body's length, so memory stays a small multiple of `maxResponseBytes`
  however densely the body echoes a credential. A success body that reveals one is withheld with
  an `isError` result that says the call succeeded, since rewriting it could
  change the data; so a short or common header value withholds every
  success body that happens to contain it. These spellings cover an upstream
  that reflects a credential it received; an upstream set on leaking one can
  always disguise it, and is outside what the executor can detect. An
  invalid header, a record whose properties throw, or a `headers` function
  that fails or returns no record is a server error (`MCPFN_TOOL_ERROR` for the client) whose
  message names at most the header, never a value or the function's own
  error.
- **Responses.** Redirects are never followed (`redirect: "manual"`): a 3xx
  is an `isError` result naming the status. A 2xx becomes structured content
  when the tool has an output schema, else text. A 2xx the output schema
  does not describe (no body, as for `204` or `HEAD`, a body that is not a
  JSON object, one that fails `checkOutput`, or one whose numbers JSON
  parsing would change, such as an integer beyond 2^53 however it is
  spelled or a decimal with more digits than a double holds, like
  `1.0000000000000001`) cannot be
  structured content; it is an `isError` result that says the call
  succeeded and not to repeat it, followed by the body text. Any other
  status is an `isError` result with the status and an excerpt of at most
  4 KiB of its body, which is read whole first. A body over
  `maxResponseBytes` (default 1 MiB), read or declared by `Content-Length`,
  is cancelled and reported with the status and no excerpt. `timeoutMs`
  (default 30 s) bounds the response and its body; a status already
  received is still reported, and after a 2xx the result says the call may
  have taken effect, so it is not retried as unanswered. The MCP request's abort signal cancels
  the call, also while the `headers` function runs; a response that arrives
  after either has its body cancelled. Network failures are reported
  without details. With the default `fetch`, a `407 Proxy Authentication
  Required` reaches the executor as a network error (Fetch turns it into
  one), so it is reported as a failed request with no status or excerpt; a
  `fetch` that returns the `407` response gets the result described above
  for any other status. Pass `fetch` to use another implementation.
- **Not covered.** A base URL that resolves to internal addresses (DNS
  rebinding), instructions inside upstream responses, and a local user who
  can read the operator's environment are outside this executor's guarantees.

## Server context and errors

Build trusted context once at the server boundary:

```ts
const server = createMcpFnServer({
  info: { name: "example", version: "1.0.0" },
  registry: new McpFnRegistry<{ workspaceId: string }>(),
  context: async (extra) => ({
    workspaceId: await authenticateRequest(extra.requestInfo),
  }),
});
```

For tenant- or actor-specific discovery, use `toolVisibility`. McpFn applies
the hook to both `tools/list` and `tools/call` and passes the request in
`requestKind` (`"tools/list"` or `"tools/call"`). A tool the hook rejects for
`tools/list` is left out of that listing; a call the hook rejects for
`tools/call` returns the same protocol `MethodNotFound` response as an unknown
tool and never reaches the handler. A hook that ignores `requestKind` applies
one decision to both. The static manifest continues to describe the complete
server contract.

```ts
const server = createMcpFnServer({
  info: { name: "admin", version: "1.0.0" },
  registry,
  context: (extra) => resolvePrincipal(extra.authInfo),
  toolVisibility: ({ tool, context }) =>
    context.permissions.includes(String(tool._meta?.permission)),
});
```

A host may decide the two requests differently. Keep the authorization check
for both request kinds and add any discovery-only condition separately, for
example to keep a permitted tool out of listings while still accepting direct
calls to it:

```ts
toolVisibility: ({ tool, context, requestKind }) => {
  if (!context.permissions.includes(String(tool._meta?.permission))) {
    return false;
  }
  return requestKind === "tools/call" || tool._meta?.hideFromDiscovery !== true;
},
```

A hook that returns `true` for every `tools/call` lets any caller reach the
tool by name, so do that only when the tool handler performs the same
authorization check itself.

Do not accept workspace, tenant, actor, or credential identifiers as tool arguments. The context factory receives the official SDK request metadata and runs before every tool call.

Invalid input returns `MCPFN_INVALID_ARGUMENTS`; invalid declared output returns
`MCPFN_INVALID_OUTPUT`; other handler failures return `MCPFN_TOOL_ERROR`.
Error objects that already expose a string `code` keep it. Schema issues retain
`instancePath`, `schemaPath`, `keyword`, and safe keyword-specific names
such as `rejectedProperty` and `missingProperty`; rejected values are never
included. `handleInvalidArguments` is available for existing domain packages
that must map schema failures into a stable legacy envelope.

When a tool declares a success `outputSchema`, error details remain in its JSON text content and `structuredContent` is omitted so the official SDK does not validate an error envelope against the success schema. Tools without an output schema retain both structured and text error envelopes.

In a tool result, only `McpFnError` (and its subclasses), the SDK's `McpError` (as code `MCPFN_TOOL_ERROR`, its JSON-RPC code not kept, with its message and its `data` as `details`) and a thrown plain `{ code, message }` object reach the client with their code, message and details. Resource, prompt, completion, subscription and other request handlers keep only `McpFnError` and `McpError`; a thrown plain object is withheld there too. Any other thrown value, such as a filesystem, database or upstream
HTTP error, becomes `{ code: "MCPFN_TOOL_ERROR", message: "The tool failed",
details: { errorId } }`; resource, prompt, completion and subscription handlers
answer such errors with a JSON-RPC `InternalError` carrying the same `errorId`.
This covers errors from context factories, visibility hooks and task creation
as well. The original error goes to the server's `onError({ error, errorId,
method, tool })` sink, which is not awaited. An `McpError` from another copy of the SDK (such as the application's own) is recognised by its `McpError` name and `MCP error <code>:` message; a renamed subclass of it is withheld, so throw `McpFnError` for domain errors that must reach the client. `exposeErrors: true` restores verbatim error text. Argument validation
stops at the first failure where the schema allows it: a large array whose
`items` fail stops at the first bad item, while a failing `anyOf` or `oneOf`
still reports each branch and, on `@cfworker/json-schema`, a tuple with
`additionalItems: false` reports each extra item (responses keep at most 100
issues), and tool arguments with more than 100,000 values in total are refused before any schema validation. Each client may hold at most `maxResourceSubscriptions` (default 1000) resource
subscriptions.

One `McpFnServer` instance connects to one transport. Create a new instance per concurrent connection and share the registry.

## Authenticated client profiles

Use `clientProfiles` only when an authenticated client needs a projected
catalog and server-owned required arguments. Profile matching receives a
`McpFnVerifiedClientIdentity` produced from trusted context; reported client
name/version and capabilities are available to hooks separately and cannot
select the profile.

```ts
const server = createMcpFnServer({
  info: { name: "example", version: "1.0.0" },
  registry,
  context: (extra) => authenticateRequest(extra.authInfo),
  clientProfiles: {
    resolveVerifiedIdentity: ({ context }) => ({
      subject: context.authenticatedClientId,
    }),
    profiles: [{
      id: "consumer/trusted",
      version: "1",
      matches: ({ subject }) => subject === "trusted-client-id",
      serverOwnedArguments: { lookup: ["workspaceId"] },
      projectCatalog: ({ tools }) => tools.map((tool) => {
        if (tool.name !== "lookup") return tool;
        const { workspaceId: _hidden, ...properties } =
          tool.inputSchema.properties ?? {};
        return {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            properties,
            required: tool.inputSchema.required?.filter(
              (name) => name !== "workspaceId",
            ),
          },
        };
      }),
      enrichArguments: ({ arguments: args, context }) => ({
        ...args,
        workspaceId: context.workspaceId,
      }),
    }],
  },
});
```

McpFn applies canonical visibility before projection, checks calls against the
same effective catalog, rejects model-supplied server-owned fields, enriches
from trusted context, and only then invokes canonical Ajv validation. Declared
server-owned fields must be canonical required properties, must be absent from
the projected schema, and must be supplied by the enricher. A profile cannot
invent or duplicate tools or mutate model-owned arguments.

A client that matches no profile (no verified identity, or one no profile
accepts) sees the canonical catalog without the tools that any profile gives
server-owned arguments: it could never call them, since it may not supply
those arguments and they are required. Calling such a tool answers like an
unknown tool, so a client cannot pick a tenant or workspace by not matching a
profile. Set `unmatchedServerOwnedArguments: "allow"` to list those tools and
pass their arguments through unchanged, as before; the handler must then
derive the value from trusted context itself.

The optional `evidence` sink receives only bounded structural lifecycle
events. It is observational: a sink failure cannot fail or change a request.

## Resources, prompts, and client features

Use `registerResource`, `registerResourceTemplate`, and `registerPrompt` on the same registry. Resource-template and prompt completers advertise the completions capability automatically. Resource subscription handlers advertise `resources.subscribe`. List calls use stable `mcpfn:<offset>` cursors and a configurable server page size.

Task support is declared with `execution.taskSupport` and a `taskHandler`; a task-capable server must receive an official SDK `TaskStore`. `server.listRoots()`, `server.sample()`, and `server.elicit()` invoke matching client capabilities over a transport connected with `server.connect()`. Behind `createWebStandardHandler()`, each request or session is served by its own isolated server, so tool handlers call `server.listRootsForRequest(extra)`, `server.sampleForRequest(extra, ...)` and `server.elicitForRequest(extra, ...)` with the handler's `extra`; the plain methods throw `MCPFN_CLIENT_REQUEST_NEEDS_REQUEST` there. Server notifications never leak one client's data to other sessions: `sendLoggingMessage(params)` reaches only the transport connected with `server.connect()`, and `sendLoggingMessage(params, sessionId)` reaches only the client with that session id (tool handlers pass `extra.sessionId`; stateless handlers log through `extra.sendNotification`). `sendResourceUpdated()` reaches the directly connected transport and only those `createWebStandardHandler()` sessions that hold a successful `resources/subscribe` for that exact URI, until they unsubscribe or the session closes (an unsubscribe also cancels a subscribe for that URI that is still running). `sendToolListChanged()`, `sendResourceListChanged()` and `sendPromptListChanged()` carry no data and reach every connected client. Declare required client features in `clientRequirements` so manifests and host-profile tests can reject incompatible hosts before deployment.

`createWebStandardHandler()` accepts the official SDK `HandleRequestOptions`, including validated `authInfo`. Use `@mcpfn/auth` to publish OAuth protected-resource metadata and produce that trusted value. In stateless mode, McpFn creates and disposes an isolated SDK server and transport for every request. Attach protocol instrumentation with `configureRequestServer`; it receives the live isolated server before transport connection and runs once per request, or once per session initialization attempt. Because configuration precedes SDK request validation, a rejected attempt can invoke the hook without retaining a session. Supply a cryptographically secure `sessionIdGenerator` when the server uses sampling, elicitation, or another server-to-client request that must be correlated across HTTP requests; session-enabled handlers retain their transport across the session.

Each stateful handler defaults to 1,000 sessions (`maxSessions`) and 100 sessions per principal (`maxSessionsPerPrincipal`). Anonymous clients share one principal allowance. A request without a session ID reserves a slot during initialization, and closing sessions count until cleanup finishes. At capacity, requests for new sessions receive HTTP 429 for the principal limit or HTTP 503 for the handler limit. Clients can retry after a slot is freed.

An idle session expires after 30 minutes without a matching HTTP request that passes the configured Host and Origin checks (`sessionIdleTimeoutMs`), even if a response stream is open or a previous request is still pending. Initialization has the same time limit from admission until the HTTP response is ready. A stalled initialization receives HTTP 408. Expiry closes the isolated server and transport and calls `onsessionclosed`, when supplied. Subsequent requests receive HTTP 404 and must initialize a new session. Set any of the three options to a positive safe integer to adjust the defaults.

Use `onsessionclosed` to release host-managed session resources such as subscription registrations. Pending lifecycle hooks and event-store writes started during setup hold capacity until they finish and cleanup completes. Give hooks and event stores that rely on external services their own timeouts.

HTTP security defaults: a request carrying an `Origin` header is refused with
HTTP 403 unless `allowedOrigins` lists it or it is a loopback origin equal to the
request's `Host`; a browser may omit `Origin` on a same-origin GET, so local servers should also accept only their own `Host` names (`originPolicy: "off"` disables this; setting
`enableDnsRebindingProtection` hands Host and Origin checks to the SDK
transport). A session belongs to the principal that created it
(`sessionPrincipal`, by default the `authInfo.extra.subject` and client ID, with `extra.issuer` and `extra.tenantId` when the verifier reports them, or the token itself when the verifier sets no subject, so set `extra.subject` for sessions to outlive token refresh; a server that trusts more than one issuer must also set `extra.issuer`, since subjects from verifiers that leave it unset share one namespace); a request
from another principal, including GET and DELETE, gets the same 404 as an
unknown session. In sessionful mode a configured `eventStore` is scoped per
session, so `Last-Event-ID` resumption only replays the session's own events; a
stateless handler has no session to scope it to, so don't share an event store
between principals there.

## Cloudflare Workers and edge runtimes

`@mcpfn/core` is a self-contained bundle: the official MCP SDK and a single
pinned Zod runtime are inlined into `dist`. Bundle it into a Cloudflare Worker
next to your application's own root `zod` dependency without adding a bundler
alias for `zod`/`zod/v4`, an import condition override, or any other
application-local shim. Enable Cloudflare's `nodejs_compat` compatibility flag,
which provides Node built-ins such as `node:crypto` used by the official MCP
SDK, and serve MCP through `createWebStandardHandler()`. Schema validation uses
Ajv draft-07 on Node and `@cfworker/json-schema` with the same dialect on
Cloudflare Workers and other runtimes that forbid runtime code generation. See
[ADR-0001](https://github.com/21nCo/super-functions/blob/main/mcpfn/ADR-0001-COMPATIBILITY.md)
for the compatibility policy.

See the [architecture](https://github.com/21nCo/super-functions/blob/main/mcpfn/ARCHITECTURE.md), [testing guide](https://github.com/21nCo/super-functions/blob/main/mcpfn/TESTING.md), and runnable [calculator example](https://github.com/21nCo/super-functions/blob/main/mcpfn/examples/calculator-server.ts).

Profile hooks that consume initialization metadata require a sessionful HTTP
handler (`sessionIdGenerator`). Stateless handlers accept only profiles explicitly
marked `requiresReportedClient: false`; their hooks must depend solely on verified
identity and request context. Model-owned property schemas retain their canonical
types and constraints. Projection may hide server-owned required fields, but does
not replace the canonical validator.

Projected input schemas may use static references within the document or an
embedded `$id` resource. Named draft-07 `$id` fragments and modern anchors are
aliases in their containing resource, so `#` and `#/...` still address that
resource's root. Dynamic, recursive, and unresolved external references fail
closed during catalog validation. Server-owned fields may only be hidden where
the root object contract can be compared without conditional or whole-object
ownership-sensitive constraints.
Draft-07 `$ref` siblings evaluated by the registry's Ajv, including `$id`
resource scope, are rejected during catalog validation because draft-07 clients
can ignore them while the runtime validator evaluates them.
The MCP-required root `type: "object"` is permitted; place other assertions on
the referenced target. Later-draft keywords and unknown extensions ignored by
the registry's draft-07 Ajv may remain beside `$ref`.

Structural diagnostics are bounded: a result carries at most 100 issues;
property names, keywords and messages are cut to 256 characters; and instance or
schema paths longer than 256 characters are reported as the root (`/`, `#`).
Any issue shortened this way has `truncated: true`, so consumers can tell an
exact name or path from a bounded one. Report sinks that aggregate many issues
should still apply their own size cap.

Task profile evidence distinguishes the creation handler from result persistence.
`handler` reports the creation callback's outcome; `task-result-storage: failed`
reports the first observed persistence failure for that request, including delayed
writes after creation returns. Retries do not repeat that failure event. It does
not reverse handler success or claim a final task status. Output validation still
runs for each attempted result before persistence.

Lifecycle evidence retains only recognized framework error codes; application-defined codes become `MCPFN_TOOL_ERROR`. Protocol error responses preserve the original application code and details.

## Supported Node runtimes

Core supports Node 18.18 and later. The SDK's web-standard HTTP transport requires
`globalThis.crypto.randomUUID`; on Node 18 enable global WebCrypto before starting
HTTP handlers, for example `NODE_OPTIONS=--experimental-global-webcrypto node app.mjs`.
Node 20 provides this global by default. This prerequisite also applies to the
previous SDK version; schema validation and in-memory transport do not require it.
`@superfunctions/admin` requires Node 20 or later.

After building core and shared admin, run
`node mcpfn/core/scripts/packed-runtime-acceptance.mjs` from the repository root to
pack both packages, install them in a disposable consumer, audit production
dependencies, and exercise ESM/CJS validation and MCP transport. Set `NODE18` and
`NODE20` to additional runtime executables. Set the WebCrypto `NODE_OPTIONS` flag
when testing Node 18 HTTP. The consumer directory is removed afterward.
