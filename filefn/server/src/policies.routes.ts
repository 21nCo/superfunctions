import type { PolicyRegistry } from './policies.js';
import { resolvePrincipal, type AuthConfig } from './auth.js';
import { FileFnError, authRequired } from './errors.js';

export interface PolicyRoutesContext {
  policyRegistry: PolicyRegistry;
  auth: AuthConfig;
}

function getRequestId(request: Request): string | undefined {
  return request.headers.get('x-request-id') || undefined;
}

function successResponse(data: unknown, requestId?: string): Response {
  return Response.json({ ok: true, data, requestId }, { status: 200 });
}

export function createPolicyRoutes(ctx: PolicyRoutesContext) {
  const { policyRegistry, auth } = ctx;

  return {
    async listPolicies(request: Request): Promise<Response> {
      const requestId = getRequestId(request);
      // Same rule as the upload routes: a caller who could not start an upload
      // does not learn the policies' names, limits and visibility either.
      const principal = await resolvePrincipal(request, auth);
      if (!principal && auth.required !== false) {
        const error: FileFnError = authRequired();
        return Response.json({ ok: false, error: error.toJSON(), requestId }, { status: error.statusCode });
      }

      const policies = policyRegistry.list().map((p) => ({
        name: p.name,
        maxSizeBytes: p.maxSizeBytes,
        contentTypes: p.contentTypes,
        visibility: p.visibility,
      }));

      return successResponse({ policies }, requestId);
    },
  };
}

export type PolicyRoutes = ReturnType<typeof createPolicyRoutes>;
