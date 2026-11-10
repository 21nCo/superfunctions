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
  /** Structured-cloneable data only; prototypes are not preserved. Enrich claims in map. */
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
  /** Trusted provider project/org ID associated with this MCP resource URL. */
  providerResourceId?: string;
  /** Explicitly permit resource-agnostic sessions. Defaults to reject. */
  unboundSessions?: "reject" | "allow";
  /** Map trusted identity claims; nonempty resourceIds must bind this resource. Empty IDs require unboundSessions: "allow". */
  map?(session: TSession, request: Request): McpFnPrincipal | Promise<McpFnPrincipal>;
  authorize?(input: {
    principal: McpFnPrincipal;
    request: Request;
    resource: URL;
    resourceBound: boolean;
  }): boolean | Promise<boolean>;
  requiredScopes?:
    | string[]
    | ((input: {
        principal: McpFnPrincipal;
        request: Request;
      }) => string[] | Promise<string[]>);
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
  const resource = new URL(options.resource.toString());
  resource.hash = "";
  const providerResourceId = options.providerResourceId;
  if (providerResourceId !== undefined && (typeof providerResourceId !== "string" || (!providerResourceId.trim() || providerResourceId !== providerResourceId.trim()))) {
    throw new TypeError("providerResourceId must be a nonempty string");
  }
  if (providerResourceId !== undefined && typeof options.provider.authorize !== "function") {
    throw new TypeError("providerResourceId requires provider.authorize");
  }
  const matchesBinding = (id: string) => id === providerResourceId || matchesResource(id, resource);
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
      if (typeof session.id !== "string" || !session.id || !session.subject ||
          typeof session.subject.actorId !== "string" || !session.subject.actorId ||
          !optionalString(session.subject.tenantId) || !optionalString(session.subject.regionId) ||
          (session.scopes !== undefined && !isStringArray(session.scopes)) ||
          (session.methods !== undefined && !isStringArray(session.methods))) return null;
      if (session.expiresAt !== undefined && !(session.expiresAt instanceof Date)) return null;
      if (session.resourceIds !== undefined && !isStringArray(session.resourceIds)) return null;
      if (session.resourceIds?.length && !session.resourceIds.some(matchesBinding)) return null;
      const sessionExpiresAt = session.expiresAt === undefined
        ? undefined : Math.floor(session.expiresAt.getTime() / 1_000);
      const now = Math.floor(Date.now() / 1_000);
      if (sessionExpiresAt !== undefined &&
          (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= now)) return null;
      const mapped = options.map
        ? await withRequestClone(request, (mapRequest) =>
          options.map!(session, mapRequest))
        : defaultPrincipal(session);
      const mappedPrincipal = snapshotPrincipal(mapped);
      if (!mappedPrincipal) return null;
      if (mappedPrincipal.expiresAt !== undefined &&
          (!Number.isFinite(mappedPrincipal.expiresAt) || mappedPrincipal.expiresAt <= now)) return null;
      // Mapping cannot extend the lifetime of the authenticated credential.
      const expiresAt = sessionExpiresAt === undefined ? mappedPrincipal.expiresAt
        : Math.min(sessionExpiresAt, mappedPrincipal.expiresAt ?? sessionExpiresAt);
      const principal = { ...mappedPrincipal, ...(expiresAt !== undefined ? { expiresAt } : {}) };
      const hasBinding = principal.resourceIds.some(matchesBinding);
      if (!hasBinding && (principal.resourceIds.length > 0 || options.unboundSessions !== "allow")) return null;
      const authorizeResource = provider.authorize;
      if (providerResourceId !== undefined && typeof authorizeResource !== "function") return null;
      if (authorizeResource && !(await authorizeResource.call(provider, session, providerResourceId ?? resource.toString()))) return null;
      if (options.authorize && !(await withRequestClone(request, authorizeRequest =>
        options.authorize!({ principal: structuredClone(principal), request: authorizeRequest, resource: new URL(resource), resourceBound: hasBinding })))) return null;
      // Async policy evaluation must not carry credentials past their expiry.
      if (expiresAt !== undefined && expiresAt <= Math.floor(Date.now() / 1_000)) return null;
      return {
        session,
        principal,
        authInfo: {
          token: bearer,
          clientId: principal.clientId,
          scopes: [...principal.scopes],
          ...(principal.expiresAt !== undefined ? { expiresAt: principal.expiresAt } : {}),
          resource: new URL(resource),
          extra: {
            ...principal.extra,
            resourceBinding: hasBinding ? "bound" : "unbound",
            boundResourceId: hasBinding ? (providerResourceId ?? resource.toString()) : undefined,
            subject: principal.subject,
            resourceIds: [...principal.resourceIds],
            tenantId: principal.tenantId,
            regionId: principal.regionId,
            authMethods: principal.authMethods ? [...principal.authMethods] : undefined,
          },
        },
      };
    },
  };
}

export class McpFnPrincipalConfigurationError extends Error {
  readonly code = "MCPFN_INVALID_PROVIDER_CONFIGURATION";
  constructor() {
    super("Mapped extra claims must be structured-cloneable data");
    this.name = "McpFnPrincipalConfigurationError";
  }
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function snapshotPrincipal(value: McpFnPrincipal): McpFnPrincipal | null {
  if (!value || typeof value !== "object") return null;
  // Read claims once before validation: policy hooks never receive this snapshot.
  const { subject, clientId, scopes, resourceIds, expiresAt, tenantId, regionId, authMethods, extra } = value;
  if (typeof subject !== "string" || !subject || typeof clientId !== "string" || !clientId ||
      !isStringArray(scopes) || !isStringArray(resourceIds) ||
      !optionalString(tenantId) || !optionalString(regionId) ||
      (authMethods !== undefined && !isStringArray(authMethods)) ||
      (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)))) return null;
  const snapshot: McpFnPrincipal = { subject, clientId, scopes: [...scopes], resourceIds: [...resourceIds], expiresAt,
    tenantId, regionId, authMethods: authMethods === undefined ? undefined : [...authMethods] };
  try { snapshot.extra = extra === undefined ? undefined : structuredClone(extra); }
  catch { throw new McpFnPrincipalConfigurationError(); }
  return snapshot;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}

function matchesResource(id: string, resource: URL): boolean {
  try {
    const candidate = new URL(id);
    candidate.hash = "";
    return candidate.toString() === resource.toString();
  } catch {
    return false;
  }
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
    } catch (error) {
      if (error instanceof McpFnPrincipalConfigurationError) {
        return Response.json({ error: "invalid_provider_configuration",
          error_description: "Mapped extra claims must be structured-cloneable data" },
          { status: 500, headers: { "cache-control": "no-store" } });
      }
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
          principal: structuredClone(authenticated.principal),
          request: scopeRequest,
        });
      } finally {
        void scopeRequest.body?.cancel().catch(() => undefined);
      }
    } else {
      requiredScopes = options.requiredScopes ?? [];
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
    clientId: session.id,
    scopes: [...(session.scopes ?? [])],
    resourceIds: [...(session.resourceIds ?? [])],
    ...(session.expiresAt
      ? { expiresAt: Math.floor(session.expiresAt.getTime() / 1_000) }
      : {}),
    ...(session.subject.tenantId ? { tenantId: session.subject.tenantId } : {}),
    ...(session.subject.regionId ? { regionId: session.subject.regionId } : {}),
    ...(session.methods ? { authMethods: [...session.methods] } : {}),
  };
}
