---
title: Server setup
description: Configure persistence, encryption, host context, and route mounting.
---

Create the server with an adapter-backed database, encryption key source, trusted request context, and host authorization. The returned object contains `router`, `vault`, `access`, `rateLimit`, `audit`, `scanner`, and `getSchema()`.

```ts
import type { Adapter } from "@superfunctions/db";
import { createSecFnServer, type SecFnAdminAction, type SecFnRequestContext } from "@secfn/server";

interface Principal extends SecFnRequestContext {
  actorId: string;
  tenantId: string;
  allowedActions: SecFnAdminAction[];
}
interface Context extends SecFnRequestContext {
  allowedActions: SecFnAdminAction[];
}

export function createSecretsServer(
  db: Adapter,
  authenticate: (request: Request) => Promise<Principal | null>,
) {
  return createSecFnServer<Context>({
    db,
    basePath: "/secfn",
    encryption: { masterKey: process.env.SECFN_MASTER_KEY!, keyId: "env:main" },
    context: async (request) => {
      const principal = await authenticate(request);
      if (principal) {
        return { actorId: principal.actorId, tenantId: principal.tenantId,
          namespace: principal.namespace, allowedActions: principal.allowedActions };
      }
      // Runtime callers have no session. These headers are client-controlled: runtime
      // routes check them against the bearer token's tenant and namespace bindings.
      const tenantId = request.headers.get("x-secfn-tenant") ?? undefined;
      return {
        tenantId,
        // Namespace-scoped access requires a tenant.
        namespace: tenantId ? request.headers.get("x-secfn-namespace") ?? undefined : undefined,
        allowedActions: [],
      };
    },
    authorize: (ctx, action) => Boolean(
      ctx.actorId && ctx.tenantId && ctx.allowedActions.includes(action),
    ),
    namespaceProvider: (ctx) => ctx.namespace,
  });
}
```

The host’s `authenticate` callback must verify session identity and derive action grants from trusted policy. No session means no admin access; even audit listing requires an explicit `audit-events:list` grant. Runtime requests from `@secfn/runtime` carry only a bearer token plus `x-secfn-tenant` and `x-secfn-namespace` headers. The router reads runtime scope from the context and query, not from those headers, so the context factory must map them as shown; the token's tenant and namespace bindings are still verified against that scope, and the resulting context has no actor or admin grants. These headers are client-controlled and untrusted, so issue service tokens bound to both a tenant and a namespace; a token without those bindings accepts whatever tenant or namespace the headers name. Namespace-only runtime calls are unsupported: the server rejects a namespace without a tenant, so the example maps the namespace header only when a tenant is present. Also return trusted `ip`, `userAgent`, and `requestId` values from the host's proxy layer in the context; the server uses them for per-IP rate limits and audit events and does not read them from the request itself.

Supply either `keyProvider` or `encryption.masterKey`; server creation fails when both are absent. The host owns key custody and rotation. The default router base path is `/secfn`, and the default JSON body limit is one MiB. SecFn does not re-export Express, Hono, Fastify, Next.js, or SvelteKit adapters. Use the shared HTTP adapter for the chosen host.

Rate limiting is disabled unless `rateLimit.enabled` is `true`. Every admin route passes a rate check and the host's `authorize` callback. If `authorize` is absent, admin access is denied. Runtime routes require a bearer service token and verify its scope before returning values. The health route returns `{ ok: true, data: { status: "ok" } }`. See [route reference](/docs/reference/routes) and [source router](https://github.com/21nCo/super-functions/blob/dev/secfn/server/src/router.ts).
