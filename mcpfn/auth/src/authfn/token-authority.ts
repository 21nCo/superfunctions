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
  /**
   * The AuthFn environment's issuer, exactly as AuthFn publishes it, advertised
   * verbatim (never normalized) as the authorization server.
   */
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

/** Lets a local test protect an `http://` resource on a literal loopback host. */
export interface AuthFnInsecureLoopbackResourceOption {
  /**
   * Allow `http://` for a resource on `localhost`, `127.0.0.1` or `[::1]`, in
   * controlled local testing. RFC 9728 resource identifiers are otherwise HTTPS.
   */
  allowInsecureLoopbackResource?: boolean;
}

/** What `protect()` takes: the resource server options AuthFn does not supply. */
export type AuthFnProtectedResourceOptions = Omit<
  McpFnOAuthResourceServerOptions,
  "verifier" | "authorizationServers" | "requiredScopes" | "allowTokensWithoutExpiry"
> &
  AuthFnInsecureLoopbackResourceOption;

/** What `verifier()` needs from the host's MCP SDK. */
export interface AuthFnVerifierOptions extends AuthFnInsecureLoopbackResourceOption {
  /**
   * The `InvalidTokenError` class the host's bearer middleware recognizes,
   * imported from the same `@modelcontextprotocol/sdk` copy as that middleware
   * (`@modelcontextprotocol/sdk/server/auth/errors.js`). The SDK's
   * `requireBearerAuth` answers 401 `invalid_token` only for an error that is
   * `instanceof` its own class, and `@mcpfn/auth` inlines a separate SDK copy,
   * so the class has to come from the host.
   */
  invalidTokenError: new (message: string) => Error;
}

export interface AuthFnTokenAuthority {
  /** The issuer every protected resource advertises. */
  readonly issuer: string;
  /**
   * An MCP SDK verifier for one resource, for hosts that use the SDK's own
   * bearer middleware. It rejects with `options.invalidTokenError` for a token
   * the provider does not report active for `resource` or whose expiry has
   * passed, and with the provider's own error when the provider could not be
   * asked.
   */
  verifier(resource: string | URL, options: AuthFnVerifierOptions): OAuthTokenVerifier;
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

/** Marks a token the provider does not report active, inside `protect()`. */
class InactiveTokenError extends Error {
  constructor() {
    super("The access token is not active for this resource");
    this.name = "AuthFnInactiveTokenError";
  }
}

/**
 * An active token as one mode reports it, with its expiry in epoch
 * milliseconds (exact for in-process `Date`s) for the completion-time check.
 */
export interface AuthFnActiveToken {
  info: AuthInfo;
  expiresAtMs: number;
}

/** Verifies a token for an exact resource; `null` means not active there. */
export type AuthFnTokenCheck = (token: string) => Promise<AuthFnActiveToken | null>;

/**
 * The resource in the form RFC 9728 metadata advertises it, which is the form
 * MCP clients send as RFC 8707 `resource` and AuthFn binds tokens to exactly.
 */
function normalizedResource(value: string | URL, allowInsecureLoopback: boolean): string {
  // Diagnostics never echo the value: a query may carry credentials.
  const serialized = value.toString();
  let url: URL;
  try {
    url = new URL(serialized);
  } catch {
    throw new TypeError("An AuthFn protected resource must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("An AuthFn protected resource must be an http or https URL");
  }
  // RFC 9728 resource identifiers use HTTPS, like the issuer and the
  // introspection endpoint; plain HTTP is a local-testing opt-in for loopback.
  const loopbackHttp =
    allowInsecureLoopback &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol === "http:" && !loopbackHttp) {
    throw new TypeError(
      "An AuthFn protected resource must be an HTTPS URL (http:// only for a loopback host with allowInsecureLoopbackResource)",
    );
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    serialized.includes("#") ||
    url.href !== serialized
  ) {
    throw new TypeError(
      "An AuthFn protected resource must be given in its normalized form, without credentials or a fragment",
    );
  }
  return url.href;
}

/**
 * The issuer, exactly as configured. AuthFn publishes its issuer verbatim
 * (`environment.issuer`, a region's `issuer`) and an RFC 8414 client compares
 * it exactly, so it is advertised in the configured spelling, never
 * normalized. RFC 8414 issuers carry no credentials, query or fragment; the
 * scheme is checked with the shared RFC 9728 rules when `protect()` builds
 * its metadata.
 */
// Scheme, `//`, a non-empty authority without userinfo, then an optional path;
// no whitespace, control characters, backslashes, query or fragment.
// eslint-disable-next-line no-control-regex
const ISSUER_SPELLING = /^https?:\/\/[^\x00-\x20\x7f/?#@\\]+(?:\/[^\x00-\x20\x7f?#\\]*)?$/i;

function exactIssuer(value: string | URL): string {
  const serialized = value.toString();
  let url: URL;
  try {
    url = new URL(serialized);
  } catch {
    throw new TypeError("An AuthFn provider issuer must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash || /[?#]/.test(serialized)) {
    throw new TypeError(
      "An AuthFn provider issuer must not carry credentials, a query or a fragment",
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("An AuthFn provider issuer must be an http or https URL");
  }
  // URL parsing repairs spellings such as `https:host` or `https://@host`;
  // the verbatim string must already be a well-formed URL itself.
  if (!ISSUER_SPELLING.test(serialized)) {
    throw new TypeError(
      "An AuthFn provider issuer must be spelled as http:// or https://, a host and an optional path",
    );
  }
  return serialized;
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
    const expiresAtMs = info.expiresAt.getTime();
    return {
      expiresAtMs,
      info: {
        token,
        clientId: info.clientId,
        scopes: [...info.scopes],
        expiresAt: expiresAtMs / 1_000,
        resource: new URL(resource),
        extra: {
          subject: info.userId,
          ...(typeof info.grantId === "string" ? { grantId: info.grantId } : {}),
          ...(typeof info.tokenId === "string" ? { tokenId: info.tokenId } : {}),
        },
      },
    };
  };
}

function unavailableResponse(): Response {
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
  const issuer = exactIssuer(provider.issuer);
  const checkFor = hasLocal
    ? (resource: string) => inProcessCheck(provider as AuthFnInProcessTokenProvider, resource)
    : createIntrospectionVerifier((provider as AuthFnIntrospectionTokenProvider).introspection);

  // Expiry is checked when the provider's answer arrives, in both modes, so
  // a token that lapsed while it was being checked is not active.
  const activeCheckFor = (
    resource: string,
    now: () => number = Date.now,
  ): ((token: string) => Promise<AuthInfo | null>) => {
    const check = checkFor(resource);
    return async (token) => {
      const active = await check(token);
      if (!active || !Number.isFinite(active.expiresAtMs)) return null;
      return active.expiresAtMs > now() ? active.info : null;
    };
  };

  const verifier = (
    resource: string | URL,
    options: AuthFnVerifierOptions,
  ): OAuthTokenVerifier => {
    const InvalidToken = options?.invalidTokenError;
    if (typeof InvalidToken !== "function") {
      throw new TypeError(
        "verifier() needs the invalidTokenError class of the host's MCP SDK bearer middleware",
      );
    }
    const check = activeCheckFor(
      normalizedResource(resource, options.allowInsecureLoopbackResource === true),
    );
    return {
      verifyAccessToken: async (token) => {
        const info = await check(token);
        if (!info) throw new InvalidToken("The access token is not active for this resource");
        return info;
      },
    };
  };

  const protect = (
    mcpHandler: McpFnWebStandardHandler,
    options: AuthFnProtectedResourceOptions,
  ) => {
    const { allowInsecureLoopbackResource, ...serverOptions } = options;
    const resource = normalizedResource(options.resource, allowInsecureLoopbackResource === true);
    // Scopes are passed through for tools to gate on (`*` and `<app>:*`
    // included), never matched exactly at the endpoint.
    const base = {
      ...serverOptions,
      resource,
      authorizationServers: [issuer],
      requiredScopes: undefined,
      allowTokensWithoutExpiry: false,
    };
    // Fails now, not on the first request, for an issuer RFC 9728 refuses.
    // The shared helper normalizes identifiers (a root slash dropped, the host
    // lowercased), so the metadata names the issuer as configured instead.
    const metadataBody = JSON.stringify({
      ...createProtectedResourceMetadata(base),
      authorization_servers: [issuer],
    });
    const metadataUrl = protectedResourceMetadataUrl(resource);
    const check = activeCheckFor(resource, options.clock);
    return async (request: Request): Promise<Response> => {
      const requestUrl = new URL(request.url);
      if (
        request.method === "GET" &&
        requestUrl.origin === metadataUrl.origin &&
        requestUrl.pathname === metadataUrl.pathname
      ) {
        return new Response(metadataBody, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=300",
          },
        });
      }
      // Request-scoped, so concurrent requests never see each other's outcome.
      let unavailable = false;
      const handler = createOAuthResourceServerHandler(mcpHandler, {
        ...base,
        verifier: {
          verifyAccessToken: async (token) => {
            let info: AuthInfo | null;
            try {
              info = await check(token);
            } catch (error) {
              unavailable = true;
              throw error;
            }
            if (!info) throw new InactiveTokenError();
            return info;
          },
        },
      });
      const response = await handler(request);
      return unavailable ? unavailableResponse() : response;
    };
  };

  return { issuer, verifier, protect };
}
