# Changelog

## 0.1.3

### Changed

- Tests run against `@mcpfn/core` 0.2.0 and include an end-to-end call of an
  OpenAPI tool through `fromOpenAPI` and `httpExecutor`. The published client
  does not depend on `@mcpfn/core` at runtime.

## 0.1.1

### Changed

- Tests run against `@mcpfn/core` 0.0.8, which carries the MCP-21 security
  fixes. The published client does not depend on `@mcpfn/core` at runtime.

## 0.1.0

### Changed

- The main entry, `@mcpfn/client`, is remote-only. Importing it no longer
  loads the MCP SDK stdio transport, `cross-spawn`, `node:child_process` or any
  other Node.js built-in, so a Cloudflare Worker can bundle it without the
  `nodejs_compat` flag and connect to a remote server over Streamable HTTP.
- `stdioTarget()` and `McpFnStdioTargetOptions` move to the Node.js-only
  subpath `@mcpfn/client/stdio`.
- On Cloudflare Workers, and on other hosts that forbid runtime code
  generation, the client validates tool output schemas with the official SDK's
  `@cfworker/json-schema` validator instead of Ajv. An explicit
  `clientOptions.jsonSchemaValidator` still takes precedence. It applies the
  dialect each output schema's `$schema` declares (draft-04, draft-07, 2019-09
  or 2020-12) and 2020-12 when none is declared, and fails calls to a tool that
  declares any other dialect as unsupported. Verdicts can differ from the
  draft-07 Ajv default on Node.js: a declared draft-07 schema ignores keywords
  beside a `$ref`, which Ajv applies, and undeclared schemas also enforce
  2020-12 keywords such as `prefixItems` and `unevaluatedProperties`.
- Default request IDs use Web Crypto `crypto.randomUUID()` instead of
  `node:crypto`.

### Deprecated

- `stdioTarget` and `McpFnStdioTargetOptions` exported from the main entry.
  They remain for this minor version as a compatibility path for existing
  stdio users: on Node.js the target loads `@mcpfn/client/stdio` when it opens
  and behaves as before. In runtimes without the `node` export condition, such
  as Cloudflare Workers, opening it fails with `MCPFN_TARGET_OPEN_FAILED`.
  The main-entry exports are removed in 0.2.0. Migrate with:

  ```ts
  // Before
  import { createMcpFnClient, stdioTarget } from "@mcpfn/client";
  // After
  import { createMcpFnClient } from "@mcpfn/client";
  import { stdioTarget } from "@mcpfn/client/stdio";
  ```
