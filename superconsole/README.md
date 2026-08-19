# Super Console

Super Console is the self-hosted, explicitly composed operator administration
surface for Superfunctions. Enabled function adapters remain authoritative for
operations, schemas, policy targets, redaction, audit, REST/OpenAPI, the
TypeScript client, and McpFn tools. Customer-facing portals are separate apps.

## Installation module

Create a deployment module and compile it as part of your server application:

```ts
import {
  createAuthFnOperatorAuth,
  createSuperConsole,
  type SuperConsolePrincipal,
} from "superconsole/server";
import { authFnConfig } from "./authfn-config.js";
import { adminAdapters, services } from "./superfunctions.js";

const auth = createAuthFnOperatorAuth({
  config: authFnConfig,
  resolveOperator: async ({ session }): Promise<SuperConsolePrincipal | null> =>
    services.operators.resolve(session.actorId),
  authorizeScope: ({ principal, requested }) =>
    services.operators.authorizeScope(principal, requested),
});

export const superConsole = createSuperConsole({
  adapters: adminAdapters,
  enabledModules: [
    "authfn",
    "watchfn",
    "plugfn",
    "sendfn",
    "mailfn",
    "billfn",
    "filefn",
  ],
  auth,
  shellPolicy: services.shellPolicy,
  policy: services.adminPolicy,
  audit: services.watchFnAuditSink,
  auditQuery: services.watchFnAuditQuery,
  idempotency: services.durableIdempotency,
  confirmation: services.boundConfirmations,
  search: services.searchFn,
  overview: services.overview,
  settings: services.settings,
  // Set this when AuthFn's cookie prefix/policy differs from its secure default.
  // Keep the authFnSession/authFnApiKey keys used by protected operations.
  openApiSecuritySchemes: services.openApiSecuritySchemes,
});
```

Every enabled module must have a registered adapter. Use `[]` for a shell-only
installation. Nested `catchfn`/`logfn` require `watchfn`; `contentfn` requires
`cmsfn`. Startup fails closed when enabled operations require infrastructure
that was not injected: a required audit sink, atomic idempotency store,
AuthFn-owned mutation authorization, or a bound confirmation issuer/verifier.
Required-audit mutations and confirmation issuance append a sanitized
`attempted` event before invoking the mutable dependency, then append a
terminal outcome. The audit sink and function/confirmation store are separate
systems: this fail-closed preflight does not claim a cross-store transaction,
so deployments must monitor terminal-event failures and reconcile attempts.

Set `SUPERCONSOLE_INSTALLATION` to the absolute filesystem path or `file://`
URL of the compiled module. The loader accepts `superConsole`, `default`, or an
async `createSuperConsoleInstallation` export and loads it once per process.

```sh
SUPERCONSOLE_INSTALLATION=file:///srv/app/dist/super-console-installation.js \
  node build
```

The stable server-only package entry is `superconsole/server`; browser code
must not import it.

## Administration surfaces

- `/api/admin/v1/registry` discovers enabled manifests and authorized shell surfaces.
- `/api/admin/v1/openapi.json` exposes OpenAPI 3.1 after shell authorization.
- `/api/admin/v1/modules/:moduleId/**` dispatches enabled function operations.
- `/api/admin/v1/confirmations` issues actor/scope/operation/input-bound tokens.
- `/api/admin/v1/mcp/transport` is the authenticated McpFn streamable-HTTP endpoint.
- `/api/admin/v1/auth/sign-in`, `/auth/2fa`, and `/auth/sign-out` delegate to AuthFn.

Automation consumers can use `@superfunctions/admin`'s `createAdminClient` for
registry, overview, search, audit, settings, MCP metadata, confirmation
issuance, route invocation, and operation-ID invocation. McpFn mutations carry
reserved controls under `_admin`; those fields are stripped before domain
validation and never enter function storage.

HTTP requests are recorded with `source: "rest"`; callers cannot override
audit provenance with a request header. McpFn invocations are recorded as
`source: "mcp"`, while direct in-process SDK dispatchers set their own trusted
source in `AdminOperationContext`.

UIFn powers the operator shell and shared visual system. AuthFn, WatchFn,
SearchFn, McpFn, and enabled product functions power their respective runtime
capabilities; Super Console does not replace them with local substitutes.
