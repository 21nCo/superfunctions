import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { HandleRequestOptions } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { bearerChallengeResponse, readBearerToken } from "./auth-response.js";
import {
  protectedResourceMetadataUrl,
  type McpFnWebStandardHandler,
} from "./resource-server.js";

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export interface McpFnPrincipal {
  subject: string;
  clientId: string;
  scopes: string[];
  resourceIds: string[];
  expiresAt?: number;
  tenantId?: string;
  regionId?: string;
  authMethods?: string[];
  extra?: Record<string, unknown>;
}

/** Structural subset implemented by AuthFn and other authentication providers. */
export interface McpFnAuthSessionLike {
  id: string;
  type: string;
  subject: {
    actorId: string;
    actorType: string;
    tenantId?: string;
    regionId?: string;
  };
  resourceIds?: string[];
  scopes?: string[];
  methods?: string[];
  expiresAt?: Date;
  metadata?: unknown;
}

export interface McpFnBearerAuthProviderLike<
  TSession extends McpFnAuthSessionLike,
> {
  /** Authenticate this exact Bearer token; other request credentials must not satisfy it. */
  authenticateBearer(token: string, request: Request): Promise<TSession | null>;
  authorize?(session: TSession, resourceId: string): Promise<boolean>;
  revoke?(sessionId: string): Promise<void>;
}

/** Structural AuthFn contract. McpFn invokes it with only the exact Bearer credential. */
export interface McpFnRequestAuthProviderLike<
  TSession extends McpFnAuthSessionLike,
> {
  authenticate(request: Request): Promise<TSession | null>;
  authorize?(session: TSession, resourceId: string): Promise<boolean>;
  revoke?(sessionId: string): Promise<void>;
}

/** AuthFn is optional: consumers can pass either supported structural provider contract. */
export type McpFnAuthProviderLike<TSession extends McpFnAuthSessionLike> =
  | McpFnBearerAuthProviderLike<TSession>
  | McpFnRequestAuthProviderLike<TSession>;

export interface McpFnAuthProviderAdapterOptions<TSession extends McpFnAuthSessionLike> {
  provider: McpFnAuthProviderLike<TSession>;
  resource: string | URL;
  map?(session: TSession, request: Request): McpFnPrincipal | Promise<McpFnPrincipal>;
  authorize?(input: {
    principal: McpFnPrincipal;
    request: Request;
  }): boolean | Promise<boolean>;
  requiredScopes?:
    | string[]
    | ((input: {
        principal: McpFnPrincipal;
        request: Request;
      }) => string[] | Promise<string[]>);
  /**
   * Audience check. When the provider implements `authorize`, it decides
   * whether the session may use `resource`. Otherwise the principal's
   * `resourceIds` must contain `resource`. Set this to true only when every
   * credential without any `resourceIds` is meant for this server: such
   * credentials are then accepted without `authInfo.resource`. A credential
   * bound to other resources is refused either way.
   */
  allowUnboundCredentials?: boolean;
  /** Current time in milliseconds, for expiry checks. Defaults to Date.now. */
  clock?: () => number;
}

export interface McpFnAuthProviderAdapter<TSession extends McpFnAuthSessionLike> {
  authenticate(request: Request): Promise<{
    session: TSession;
    principal: McpFnPrincipal;
    authInfo: AuthInfo;
  } | null>;
}

export function createMcpFnAuthProviderAdapter<TSession extends McpFnAuthSessionLike>(
  options: McpFnAuthProviderAdapterOptions<TSession>,
): McpFnAuthProviderAdapter<TSession> {
  const normalized = new URL(options.resource.toString());
  normalized.hash = "";
  // Kept as strings so nothing outside can change the expected audience.
  // Resource IDs are compared as identifiers: exactly the configured string,
  // as AuthFn registers and verifies them (no URL normalization either side).
  const audience = normalized.toString();
  const configuredResource = options.resource.toString();
  if (!options.provider.authorize && configuredResource !== audience) {
    // Without an authorize() hook the adapter matches resourceIds exactly.
    // Protected-resource metadata advertises the normalized form, so tokens are
    // issued for it; a differently spelled configuration would refuse them.
    // A hook receives the normalized form, so any spelling works there.
    // The URL itself stays out of the message: it may carry a secret.
    throw new Error(
      "MCP resource must be given in its normalized form (as new URL(resource).toString() serializes it, without a fragment)",
    );
  }
  return {
    async authenticate(request) {
      const bearer = readBearerToken(request);
      if (!bearer) return null;
      const provider = options.provider;
      const session = "authenticateBearer" in provider
        ? await withRequestClone(request, (providerRequest) =>
          provider.authenticateBearer(bearer, providerRequest))
        : await provider.authenticate(new Request(request.url, {
          method: request.method,
          headers: { authorization: `Bearer ${bearer}` },
          credentials: "omit",
        }));
      if (!session) return null;
      const expired = () => {
        const now = options.clock?.() ?? Date.now();
        // A non-finite deadline (Infinity, NaN) counts as expired.
        if (session.expiresAt !== undefined && !expiresAfter(session.expiresAt.getTime(), now)) return true;
        // A custom mapping's expiry (whole seconds) is checked as given; the
        // default mapping's comes from session.expiresAt, checked exactly above.
        const mappedExpiry = options.map ? principal?.expiresAt : undefined;
        return mappedExpiry !== undefined && !expiresAfter(mappedExpiry * 1_000, now);
      };
      let principal: McpFnPrincipal | undefined;
      if (expired()) return null;
      principal = options.map
        ? await withRequestClone(request, (mapRequest) =>
          options.map!(session, mapRequest))
        : defaultPrincipal(session);
      // Fail fast, before authorization hooks run for an expired principal.
      if (expired()) return null;
      let audienceVerified = false;
      // A scalar here would make includes() a substring match.
      if (!Array.isArray(principal.resourceIds)) return null;
      if (options.provider.authorize) {
        if (!(await options.provider.authorize(session, audience))) return null;
        audienceVerified = true;
      } else if (principal.resourceIds.includes(configuredResource)) {
        audienceVerified = true;
      } else if (options.allowUnboundCredentials !== true || principal.resourceIds.length > 0) {
        // The opt-in covers credentials with no binding at all; one bound to
        // another resource is always refused.
        return null;
      }
      if (
        options.authorize &&
        !(await withRequestClone(request, (authorizeRequest) =>
          options.authorize!({ principal: principal!, request: authorizeRequest })))
      ) {
        return null;
      }
      // Checked again after the asynchronous steps above.
      if (expired()) return null;
      return {
        session,
        principal,
        authInfo: {
          token: bearer,
          clientId: principal.clientId,
          scopes: [...principal.scopes],
          ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}),
          // A fresh URL each time: a handler changing it cannot move the audience.
          ...(audienceVerified ? { resource: new URL(audience) } : {}),
          extra: {
            ...principal.extra,
            subject: principal.subject,
            resourceIds: [...principal.resourceIds],
            ...(principal.tenantId ? { tenantId: principal.tenantId } : {}),
            ...(principal.regionId ? { regionId: principal.regionId } : {}),
            ...(principal.authMethods ? { authMethods: [...principal.authMethods] } : {}),
          },
        },
      };
    },
  };
}

/** Whether a millisecond deadline is finite and later than now. */
function expiresAfter(deadline: number, now: number): boolean {
  return Number.isFinite(deadline) && deadline > now;
}

async function withRequestClone<T>(
  request: Request,
  callback: (clone: Request) => T | Promise<T>,
): Promise<T> {
  const clone = request.clone();
  try {
    return await callback(clone);
  } finally {
    void clone.body?.cancel().catch(() => undefined);
  }
}

export function createAuthProviderMcpHandler<TSession extends McpFnAuthSessionLike>(
  mcpHandler: McpFnWebStandardHandler,
  options: McpFnAuthProviderAdapterOptions<TSession>,
): (request: Request) => Promise<Response> {
  const adapter = createMcpFnAuthProviderAdapter(options);
  const metadataUrl = protectedResourceMetadataUrl(options.resource);
  return async (request) => {
    let authenticationRequest: Request;
    try {
      authenticationRequest = request.clone();
    } catch {
      return invalidTokenResponse(metadataUrl);
    }
    let authenticated;
    try {
      authenticated = await adapter.authenticate(authenticationRequest);
    } catch {
      return new Response(JSON.stringify({
        error: "temporarily_unavailable",
        error_description: "The authentication provider is unavailable",
      }), {
        status: 503,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } finally {
      void authenticationRequest.body?.cancel().catch(() => undefined);
    }
    if (!authenticated) {
      return invalidTokenResponse(metadataUrl);
    }
    let requiredScopes: string[];
    if (typeof options.requiredScopes === "function") {
      const scopeRequest = request.clone();
      try {
        requiredScopes = await options.requiredScopes({
          principal: authenticated.principal,
          request: scopeRequest,
        });
      } finally {
        void scopeRequest.body?.cancel().catch(() => undefined);
      }
    } else {
      requiredScopes = options.requiredScopes ?? [];
    }
    // Scope resolution may have awaited: refuse a credential that expired
    // meanwhile (session or mapped deadline), before judging its scopes.
    const now = options.clock?.() ?? Date.now();
    const sessionExpiry = authenticated.session.expiresAt;
    const mappedExpiry = authenticated.authInfo.expiresAt;
    if ((sessionExpiry !== undefined && !expiresAfter(sessionExpiry.getTime(), now)) ||
        (mappedExpiry !== undefined && !expiresAfter(mappedExpiry * 1_000, now))) {
      return invalidTokenResponse(metadataUrl);
    }
    const grantedScopes = new Set(authenticated.principal.scopes);
    const missingScopes = [...new Set(requiredScopes)].filter(
      (scope) => !grantedScopes.has(scope),
    );
    if (missingScopes.length) {
      return bearerChallengeResponse(403, metadataUrl, {
        error: "insufficient_scope",
        description: "The Bearer credential lacks required scopes",
        scope: [...new Set(requiredScopes)]
          .sort(compareCodeUnits)
          .join(" "),
      });
    }
    const handleOptions: HandleRequestOptions = { authInfo: authenticated.authInfo };
    return mcpHandler(request, handleOptions);
  };
}

function invalidTokenResponse(metadataUrl: URL): Response {
  return bearerChallengeResponse(401, metadataUrl, {
    error: "invalid_token",
    description: "A valid Bearer access token is required",
  });
}

function defaultPrincipal(session: McpFnAuthSessionLike): McpFnPrincipal {
  return {
    subject: session.subject.actorId,
    // Never the session ID: authInfo.clientId reaches tool handlers and logs.
    clientId: defaultClientId(session),
    scopes: [...(session.scopes ?? [])],
    resourceIds: [...(session.resourceIds ?? [])],
    ...(session.expiresAt
      // Exact, as fractional epoch seconds: neither early nor late.
      ? { expiresAt: session.expiresAt.getTime() / 1_000 }
      : {}),
    ...(session.subject.tenantId ? { tenantId: session.subject.tenantId } : {}),
    ...(session.subject.regionId ? { regionId: session.subject.regionId } : {}),
    ...(session.methods ? { authMethods: [...session.methods] } : {}),
  };
}

function defaultClientId(session: McpFnAuthSessionLike): string {
  const metadata = session.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const clientId = (metadata as { clientId?: unknown }).clientId;
    if (typeof clientId === "string" && clientId) return clientId;
  }
  return `${session.subject.actorType}:${session.subject.actorId}`;
}
