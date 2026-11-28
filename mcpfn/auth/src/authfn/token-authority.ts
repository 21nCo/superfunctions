import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";

import {
  createOAuthResourceServerHandler,
  createProtectedResourceMetadata,
  protectedResourceMetadataUrl,
  type McpFnOAuthResourceServerOptions,
  type McpFnWebStandardHandler,
} from "../resource-server.js";
import { createIntrospectionVerifier, type AuthFnIntrospectionOptions } from "./introspection.js";

/**
 * An active access token as AuthFn's `verifyOAuthAccessToken` reports it
 * (structural: `@authfn/oauth-provider` is not imported).
 */
export interface AuthFnOAuthAccessTokenLike {
  tokenId?: string;
  grantId?: string;
  clientId: string;
  /** The user the token acts for. */
  userId: string;
  /** The resource (audience) the token is bound to. */
  resource: string;
  scopes: readonly string[];
  expiresAt: Date;
}

/** Verifies a token in the AuthFn server's process, against its database. */
export interface AuthFnInProcessTokenProvider {
  /** The AuthFn environment's issuer, advertised as the authorization server. */
  issuer: string | URL;
  /**
   * Usually `(token, { resource }) => verifyOAuthAccessToken(store, token, { resource })`.
   * Resolve `null` for a token that is unknown, expired, revoked or bound to
   * another resource; throw only when the token could not be checked.
   */
  verifyAccessToken(
    token: string,
    options: { resource: string },
  ): Promise<AuthFnOAuthAccessTokenLike | null>;
  introspection?: undefined;
}

/** Verifies a token remotely through AuthFn's RFC 7662 introspection endpoint. */
export interface AuthFnIntrospectionTokenProvider {
  /** The AuthFn environment's issuer, advertised as the authorization server. */
  issuer: string | URL;
  introspection: AuthFnIntrospectionOptions;
  verifyAccessToken?: undefined;
}

export type AuthFnTokenAuthorityProvider =
  | AuthFnInProcessTokenProvider
  | AuthFnIntrospectionTokenProvider;

/** What `protect()` takes: the resource server options AuthFn does not supply. */
export type AuthFnProtectedResourceOptions = Omit<
  McpFnOAuthResourceServerOptions,
  "verifier" | "authorizationServers" | "requiredScopes" | "allowTokensWithoutExpiry"
>;

export interface AuthFnTokenAuthority {
  /** The issuer every protected resource advertises. */
  readonly issuer: string;
  /**
   * An MCP SDK verifier for one resource. It rejects with an `invalid_token`
   * error for a token the provider does not report active for `resource`, and
   * with any other error when the provider could not be asked.
   */
  verifier(resource: string | URL): OAuthTokenVerifier;
  /**
   * Wraps an MCP Web Standard handler: serves RFC 9728 metadata naming the
   * AuthFn issuer at the resource's well-known URL, and passes requests whose
   * Bearer token the provider reports active for this resource to the MCP
   * handler with its `authInfo` (scopes, client, subject).
   */
  protect(
    mcpHandler: McpFnWebStandardHandler,
    options: AuthFnProtectedResourceOptions,
  ): (request: Request) => Promise<Response>;
}

/** Thrown by the verifier for a token the provider does not report active. */
export class AuthFnInvalidTokenError extends Error {
  readonly errorCode = "invalid_token";
  constructor(message = "The access token is not active for this resource") {
    super(message);
    this.name = "AuthFnInvalidTokenError";
  }
}

/** Verifies a token for an exact resource; `null` means not active there. */
export type AuthFnTokenCheck = (token: string) => Promise<AuthInfo | null>;

/**
 * The resource in the form RFC 9728 metadata advertises it, which is the form
 * MCP clients send as RFC 8707 `resource` and AuthFn binds tokens to exactly.
 */
function normalizedResource(value: string | URL): string {
  const serialized = value.toString();
  let url: URL;
  try {
    url = new URL(serialized);
  } catch {
    throw new TypeError("An AuthFn protected resource must be an absolute URL");
  }
  if (url.hash || serialized.includes("#") || url.href !== serialized) {
    throw new TypeError(
      `An AuthFn protected resource must be given in its normalized form without a fragment (${url.origin}${url.pathname}${url.search})`,
    );
  }
  return url.href;
}

function isFiniteDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function inProcessCheck(
  provider: AuthFnInProcessTokenProvider,
  resource: string,
): AuthFnTokenCheck {
  return async (token) => {
    const info = await provider.verifyAccessToken(token, { resource });
    if (
      !info ||
      info.resource !== resource ||
      typeof info.clientId !== "string" ||
      typeof info.userId !== "string" ||
      !Array.isArray(info.scopes) ||
      !info.scopes.every((scope) => typeof scope === "string") ||
      !isFiniteDate(info.expiresAt)
    ) {
      return null;
    }
    return {
      token,
      clientId: info.clientId,
      scopes: [...info.scopes],
      expiresAt: info.expiresAt.getTime() / 1_000,
      resource: new URL(resource),
      extra: {
        subject: info.userId,
        ...(typeof info.grantId === "string" ? { grantId: info.grantId } : {}),
        ...(typeof info.tokenId === "string" ? { tokenId: info.tokenId } : {}),
      },
    };
  };
}

function unavailableResponse(metadataUrl: URL): Response {
  return new Response(
    JSON.stringify({
      error: "temporarily_unavailable",
      error_description: "The access token could not be verified; retry later",
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "retry-after": "5",
        link: `<${metadataUrl.toString()}>; rel="oauth-protected-resource"`,
      },
    },
  );
}

/**
 * Lets an MCP endpoint accept access tokens issued by an AuthFn OAuth
 * provider (`@authfn/oauth-provider`). Every request asks the provider, so a
 * revoked grant or token stops working at once; nothing is cached. A token is
 * accepted only when the provider reports it active for this exact resource
 * and it has not expired. A token that is not active is answered 401
 * `invalid_token`; a provider that could not be asked (an error, a timeout,
 * a non-200 introspection answer) is answered 503 without touching the MCP
 * handler, so clients keep their tokens.
 */
export function createAuthFnTokenAuthority(
  provider: AuthFnTokenAuthorityProvider,
): AuthFnTokenAuthority {
  if (!provider || typeof provider !== "object") {
    throw new TypeError("createAuthFnTokenAuthority needs an AuthFn provider");
  }
  const hasLocal = typeof provider.verifyAccessToken === "function";
  const hasRemote = provider.introspection !== undefined;
  if (hasLocal === hasRemote) {
    throw new TypeError(
      "An AuthFn provider needs exactly one of verifyAccessToken or introspection",
    );
  }
  if (provider.issuer === undefined || provider.issuer === null) {
    throw new TypeError("An AuthFn provider needs its issuer");
  }
  const issuer = provider.issuer.toString();
  const checkFor = hasLocal
    ? (resource: string) => inProcessCheck(provider as AuthFnInProcessTokenProvider, resource)
    : createIntrospectionVerifier((provider as AuthFnIntrospectionTokenProvider).introspection);

  const verifier = (resource: string | URL): OAuthTokenVerifier => {
    const check = checkFor(normalizedResource(resource));
    return {
      verifyAccessToken: async (token) => {
        const info = await check(token);
        if (!info) throw new AuthFnInvalidTokenError();
        return info;
      },
    };
  };

  const protect = (
    mcpHandler: McpFnWebStandardHandler,
    options: AuthFnProtectedResourceOptions,
  ) => {
    const resource = normalizedResource(options.resource);
    const base = { ...options, resource, authorizationServers: [issuer] };
    // Fails now, not on the first request, for an issuer RFC 9728 refuses.
    createProtectedResourceMetadata(base);
    const metadataUrl = protectedResourceMetadataUrl(resource);
    const tokenVerifier = verifier(resource);
    return async (request: Request): Promise<Response> => {
      // Request-scoped, so concurrent requests never see each other's outcome.
      let unavailable = false;
      const handler = createOAuthResourceServerHandler(mcpHandler, {
        ...base,
        verifier: {
          verifyAccessToken: async (token) => {
            try {
              return await tokenVerifier.verifyAccessToken(token);
            } catch (error) {
              if (!(error instanceof AuthFnInvalidTokenError)) unavailable = true;
              throw error;
            }
          },
        },
      });
      const response = await handler(request);
      return unavailable ? unavailableResponse(metadataUrl) : response;
    };
  };

  return { issuer, verifier, protect };
}
