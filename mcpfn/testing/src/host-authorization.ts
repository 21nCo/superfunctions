import type { OAuthClientMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  matchMcpRedirectUri,
  normalizeMcpClientRegistration,
  type McpFnClientRegistrationSource,
  type McpFnNormalizedClientRegistration,
  type McpFnRedirectMatch,
  type McpFnRedirectPolicy,
} from "@mcpfn/auth";
import {
  derivePkceS256Challenge,
  redactOAuthValue,
} from "@superfunctions/oauth-core";

export interface McpFnHostedRegistrationFixture {
  clientId: string;
  source: McpFnClientRegistrationSource;
  metadata: OAuthClientMetadata;
}

export interface McpFnHostedAuthorizationRequestFixture {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  state: string;
  codeVerifier: string;
}

export interface McpFnHostedTokenRequestFixture {
  grantType: string;
  /** Optional independently-authored code override for negative token-exchange cases. */
  code?: string;
  refreshToken?: string;
  refreshAfterExchange?: boolean;
}

export interface McpFnHostedAuthorizationCase {
  id: string;
  host: "chatgpt" | "claude" | "generic";
  registration: McpFnHostedRegistrationFixture;
  authorization: McpFnHostedAuthorizationRequestFixture;
  token?: McpFnHostedTokenRequestFixture;
  expected: {
    outcome: "allowed" | "rejected";
    /**
     * Expected OAuth error code. A dynamic or client-metadata-document client
     * may be rejected with an HTML error page; its code is the text of the
     * page's first `<code>` element that is a valid RFC 6749 error code. When
     * this is set, a rejection without a code fails; when it is unset, the
     * rejection is matched on outcome and phase only.
     */
    errorCode?: string;
    phase?: "client-registration" | "authorization-request" | "token-exchange" | "token-refresh";
  };
}

export interface McpFnHostedAuthorizationTargetAdapter {
  issuer: string;
  /**
   * Redirect policy of the target's authorization server (its
   * `redirectPolicy`). The harness decides whether a requested redirect URI
   * is registered with the same matching rule, including RFC 8252 loopback
   * runtime ports. Defaults to the @mcpfn/auth default policy.
   */
  redirectPolicy?: McpFnRedirectPolicy;
  /**
   * Token endpoint authentication methods the target supports (its
   * `capabilities.tokenEndpointAuthMethods`). When declared, a registration
   * with another method is ineligible and registers no redirect URI. When
   * omitted, the harness adds no authentication-method constraint.
   */
  tokenEndpointAuthMethods?: string[];
  /**
   * Scopes the target supports (its `supportedScopes`). When declared, a
   * registration whose `scope` names another scope is ineligible. When
   * omitted, the harness adds no scope constraint.
   */
  supportedScopes?: string[];
  prepareRegistration(fixture: McpFnHostedRegistrationFixture): Promise<void>;
  request(request: Request): Promise<Response>;
}

export interface McpFnHostedAuthorizationCaseResult {
  formatVersion: 1;
  id: string;
  host: McpFnHostedAuthorizationCase["host"];
  status: "passed" | "failed";
  phase: "client-registration" | "authorization-request" | "token-exchange" | "token-refresh";
  layer: "mcpfn-preflight" | "authorization-server";
  responseStatus?: number;
  errorCode?: string;
  error?: string;
}

export interface McpFnHostedAuthorizationFixtureOptions {
  issuer: string;
  resource: string;
  chatgptRedirectUri?: string;
  claudeRedirectUri?: string;
}

/**
 * Provider-shaped role-3 fixtures. Registration metadata and authorization
 * requests are separate objects so redirect, grant, and deployment drift can
 * fail instead of being generated from one self-consistent source.
 */
export function createHostedAuthorizationFixtures(
  options: McpFnHostedAuthorizationFixtureOptions,
): McpFnHostedAuthorizationCase[] {
  const issuer = new URL(options.issuer);
  const resource = new URL(options.resource).toString();
  const chatgptRedirect = options.chatgptRedirectUri ??
    "https://chatgpt.com/connector_platform_oauth_redirect";
  const claudeRedirect = options.claudeRedirectUri ??
    "https://claude.example.com/oauth/callback";
  const verifier = "mcpfn-role3-shared-pkce-verifier-000000000000000000000000";
  const registration = (
    clientId: string,
    source: McpFnClientRegistrationSource,
    redirectUri: string,
    grantTypes: string[],
  ): McpFnHostedRegistrationFixture => ({
    clientId,
    source,
    metadata: {
      client_name: `McpFn ${source} fixture`,
      redirect_uris: [redirectUri],
      response_types: ["code"],
      grant_types: grantTypes,
      token_endpoint_auth_method: "none",
    },
  });
  const authorization = (
    clientId: string,
    redirectUri: string,
  ): McpFnHostedAuthorizationRequestFixture => ({
    clientId,
    redirectUri,
    resource,
    scopes: ["mcp:read"],
    state: "mcpfn-role3-state",
    codeVerifier: verifier,
  });
  const chatgptId = "chatgpt-client";
  const claudeId = new URL("/client-metadata/claude", issuer).toString();
  const dcrId = "dcr-client";
  const supported = ["authorization_code", "refresh_token"];
  return [
    {
      id: "chatgpt-pre-registered-code-pkce",
      host: "chatgpt",
      registration: registration(chatgptId, "pre-registered", chatgptRedirect, supported),
      authorization: authorization(chatgptId, chatgptRedirect),
      token: {
        grantType: "authorization_code",
        refreshAfterExchange: true,
      },
      expected: { outcome: "allowed" },
    },
    {
      id: "claude-client-metadata-extensible-grants",
      host: "claude",
      registration: registration(claudeId, "client-metadata-document", claudeRedirect, [
        ...supported,
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "urn:ietf:params:oauth:grant-type:device_code",
        "urn:example:params:oauth:grant-type:extension",
      ]),
      authorization: authorization(claudeId, claudeRedirect),
      token: {
        grantType: "authorization_code",
        refreshAfterExchange: true,
      },
      expected: { outcome: "allowed" },
    },
    {
      id: "dynamic-registration-code-pkce",
      host: "generic",
      registration: registration(dcrId, "dynamic", "http://127.0.0.1/callback", supported),
      authorization: authorization(dcrId, "http://127.0.0.1/callback"),
      token: { grantType: "authorization_code" },
      expected: { outcome: "allowed" },
    },
    {
      id: "chatgpt-unregistered-redirect",
      host: "chatgpt",
      registration: registration(chatgptId, "pre-registered", chatgptRedirect, supported),
      authorization: authorization(chatgptId, `${chatgptRedirect}/drift`),
      expected: {
        outcome: "rejected",
        errorCode: "invalid_request",
        phase: "authorization-request",
      },
    },
    {
      id: "incompatible-registration-grants",
      host: "generic",
      registration: registration(
        "incompatible-client",
        "pre-registered",
        "https://client.example.com/callback",
        ["urn:ietf:params:oauth:grant-type:jwt-bearer"],
      ),
      authorization: authorization(
        "incompatible-client",
        "https://client.example.com/callback",
      ),
      expected: {
        outcome: "rejected",
        errorCode: "invalid_client",
        phase: "authorization-request",
      },
    },
    {
      id: "actual-unsupported-token-grant",
      host: "generic",
      registration: registration(
        "unsupported-token-client",
        "pre-registered",
        "https://client.example.com/callback",
        supported,
      ),
      authorization: authorization(
        "unsupported-token-client",
        "https://client.example.com/callback",
      ),
      token: { grantType: "urn:example:unsupported-token-grant" },
      expected: {
        outcome: "rejected",
        errorCode: "unsupported_grant_type",
        phase: "token-exchange",
      },
    },
  ];
}

/** Run the independently-configured hosted-authorization matrix. */
export async function runHostedAuthorizationRegression(
  target: McpFnHostedAuthorizationTargetAdapter,
  fixtures: readonly McpFnHostedAuthorizationCase[],
): Promise<McpFnHostedAuthorizationCaseResult[]> {
  const results: McpFnHostedAuthorizationCaseResult[] = [];
  for (const fixture of fixtures) {
    results.push(await runHostedCase(target, fixture));
  }
  return results;
}

async function runHostedCase(
  target: McpFnHostedAuthorizationTargetAdapter,
  fixture: McpFnHostedAuthorizationCase,
): Promise<McpFnHostedAuthorizationCaseResult> {
  let phase: McpFnHostedAuthorizationCaseResult["phase"] = "client-registration";
  let responseStatus: number | undefined;
  try {
    await target.prepareRegistration(structuredClone(fixture.registration));
    phase = "authorization-request";
    const authorization = hostedAuthorizationUrl(target.issuer, fixture);
    responseStatus = undefined;
    const authorizationResponse = await target.request(new Request(authorization, {
      redirect: "manual",
    }));
    responseStatus = authorizationResponse.status;
    const redirectMatch = registeredRedirectMatch(fixture, target);
    const authorizationError = await oauthError(authorizationResponse);
    if (authorizationError) {
      await validateOAuthRejection(
        authorizationResponse,
        fixture,
        target.issuer,
        "authorization",
        redirectMatch,
      );
      return assessHostedCase(fixture, phase, authorizationResponse.status, authorizationError);
    }
    if (isUnvettedErrorPage(authorizationResponse, fixture, redirectMatch)) {
      const pageErrorCode = await validateUnvettedErrorPage(
        authorizationResponse,
        fixture,
        redirectMatch,
      );
      return assessHostedCase(fixture, phase, responseStatus, pageErrorCode, undefined, true);
    }
    if (!isRedirect(authorizationResponse.status)) {
      throw new Error(`Authorization request did not redirect (HTTP ${authorizationResponse.status})`);
    }
    const code = validatedRedirectCode(authorizationResponse, fixture, target.issuer);
    if (fixture.token) return runHostedTokenCase(target, fixture, fixture.token, code);
    return assessHostedCase(fixture, phase, responseStatus);
  } catch (error) {
    return assessHostedFailure(fixture, phase, responseStatus, error);
  }
}

async function runHostedTokenCase(
  target: McpFnHostedAuthorizationTargetAdapter,
  fixture: McpFnHostedAuthorizationCase,
  token: NonNullable<McpFnHostedAuthorizationCase["token"]>,
  code: string,
): Promise<McpFnHostedAuthorizationCaseResult> {
  let phase: McpFnHostedAuthorizationCaseResult["phase"] = token.grantType === "refresh_token"
    ? "token-refresh"
    : "token-exchange";
  let responseStatus: number | undefined;
  try {
    const tokenResponse = await target.request(hostedTokenRequest(
      target.issuer,
      tokenRequestBody(fixture, token, code),
    ));
    responseStatus = tokenResponse.status;
    const tokenError = await oauthError(tokenResponse);
    if (tokenError) {
      await validateOAuthRejection(tokenResponse, fixture, target.issuer, "token");
      return assessHostedCase(fixture, phase, responseStatus, tokenError);
    }
    if (!tokenResponse.ok) throw new Error(`Token request returned HTTP ${tokenResponse.status}`);
    const tokenSet = await validatedTokenSet(tokenResponse);
    if (!token.refreshAfterExchange) {
      return assessHostedCase(fixture, phase, responseStatus);
    }
    if (typeof tokenSet.refresh_token !== "string" || !tokenSet.refresh_token) {
      throw new Error("Authorization-code response did not include a refresh token");
    }
    phase = "token-refresh";
    responseStatus = undefined;
    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: fixture.authorization.clientId,
      refresh_token: tokenSet.refresh_token,
      resource: fixture.authorization.resource,
    });
    const refreshResponse = await target.request(hostedTokenRequest(target.issuer, refreshBody));
    responseStatus = refreshResponse.status;
    const refreshError = await oauthError(refreshResponse);
    if (refreshError) {
      await validateOAuthRejection(refreshResponse, fixture, target.issuer, "token");
      return assessHostedCase(fixture, phase, responseStatus, refreshError);
    }
    if (!refreshResponse.ok) {
      throw new Error(`Refresh request returned HTTP ${refreshResponse.status}`);
    }
    await validatedTokenSet(refreshResponse);
    return assessHostedCase(fixture, phase, responseStatus);
  } catch (error) {
    return assessHostedFailure(fixture, phase, responseStatus, error);
  }
}

function tokenRequestBody(
  fixture: McpFnHostedAuthorizationCase,
  token: NonNullable<McpFnHostedAuthorizationCase["token"]>,
  code: string,
): URLSearchParams {
  const body = new URLSearchParams({
    grant_type: token.grantType,
    client_id: fixture.authorization.clientId,
  });
  if (token.grantType === "authorization_code") {
    body.set("code", token.code ?? code);
    body.set("redirect_uri", fixture.authorization.redirectUri);
    body.set("code_verifier", fixture.authorization.codeVerifier);
    body.set("resource", fixture.authorization.resource);
  } else if (token.refreshToken) {
    body.set("refresh_token", token.refreshToken);
    body.set("resource", fixture.authorization.resource);
  }
  return body;
}

function hostedTokenRequest(issuer: string, body: URLSearchParams): Request {
  return new Request(new URL("token", ensureTrailingSlash(issuer)), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

function assessHostedFailure(
  fixture: McpFnHostedAuthorizationCase,
  phase: McpFnHostedAuthorizationCaseResult["phase"],
  responseStatus: number | undefined,
  error: unknown,
): McpFnHostedAuthorizationCaseResult {
  const redacted = redactOAuthValue(error);
  const safe = redacted && typeof redacted === "object"
    ? redacted as Record<string, unknown>
    : {};
  const code = typeof safe.code === "string" ? safe.code : undefined;
  const message = typeof safe.message === "string" ? safe.message : String(redacted);
  return assessHostedCase(
    fixture,
    phase,
    responseStatus,
    code,
    message || "Hosted adapter failed",
  );
}

function hostedAuthorizationUrl(
  issuer: string,
  fixture: McpFnHostedAuthorizationCase,
): URL {
  const authorization = new URL("authorize", ensureTrailingSlash(issuer));
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("client_id", fixture.authorization.clientId);
  authorization.searchParams.set("redirect_uri", fixture.authorization.redirectUri);
  authorization.searchParams.set(
    "code_challenge",
    derivePkceS256Challenge(fixture.authorization.codeVerifier),
  );
  authorization.searchParams.set("code_challenge_method", "S256");
  authorization.searchParams.set("state", fixture.authorization.state);
  authorization.searchParams.set("resource", fixture.authorization.resource);
  authorization.searchParams.set("scope", fixture.authorization.scopes.join(" "));
  return authorization;
}

function assessHostedCase(
  fixture: McpFnHostedAuthorizationCase,
  phase: McpFnHostedAuthorizationCaseResult["phase"],
  responseStatus?: number,
  errorCode?: string,
  error?: string,
  rejected = false,
): McpFnHostedAuthorizationCaseResult {
  const observedOutcome = errorCode || error || rejected ? "rejected" : "allowed";
  const expected = fixture.expected;
  const passed = !error && observedOutcome === expected.outcome &&
    (expected.errorCode === undefined || expected.errorCode === errorCode) &&
    (expected.phase === undefined || expected.phase === phase);
  const expectedCode = expected.errorCode ? `:${expected.errorCode}` : "";
  const observedCode = errorCode ? `:${errorCode}` : "";
  const mismatch = `Expected ${expected.outcome}${expectedCode}, received ${observedOutcome}${observedCode}`;
  return {
    formatVersion: 1,
    id: fixture.id,
    host: fixture.host,
    status: passed ? "passed" : "failed",
    phase,
    layer: phase === "client-registration" ? "mcpfn-preflight" : "authorization-server",
    ...(responseStatus === undefined ? {} : { responseStatus }),
    ...(errorCode ? { errorCode } : {}),
    ...(!passed || error ? {
      error: error ?? mismatch,
    } : {}),
  };
}

function isJsonResponse(response: Response): boolean {
  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(mediaType);
}

async function oauthError(response: Response): Promise<string | undefined> {
  const location = response.headers.get("location");
  if (location) {
    const code = new URL(location).searchParams.get("error");
    if (code) return code;
  }
  if (!isJsonResponse(response)) return undefined;
  const body = await response.clone().json().catch(() => undefined) as
    | { error?: unknown }
    | undefined;
  return typeof body?.error === "string" ? body.error : undefined;
}

async function validateOAuthRejection(
  response: Response,
  fixture: McpFnHostedAuthorizationCase,
  issuer: string,
  context: "authorization" | "token",
  redirectMatch?: McpFnRedirectMatch,
): Promise<void> {
  if (context === "authorization" && isRedirect(response.status)) {
    validateAuthorizationErrorRedirect(response, fixture, issuer, redirectMatch);
    return;
  }
  const text = await response.clone().text().catch(() => "");
  const body = parseJson(text) as { error?: unknown } | null | undefined;
  const registered = redirectMatch !== undefined;
  const unvetted = context === "authorization" && registered && isUnvettedRedirectSource(fixture);
  const clientRejected = typeof body?.error === "string" && CLIENT_REJECTION_CODES.has(body.error);
  if (context === "authorization" && !clientRejected && registered && !unvetted) {
    throw new Error("Registered authorization requests require an OAuth error callback");
  }
  if (response.status !== 400) throw new Error("OAuth error response has invalid HTTP status");
  if (response.headers.has("location") || !isJsonResponse(response) ||
      !body || typeof body.error !== "string" || !body.error) {
    throw new Error("OAuth error response must be a JSON error envelope");
  }
  if (unvetted) assertRedirectUriNotReflected(text, fixture, redirectMatch);
}

/**
 * The server rejects an unknown or invalid client registration before it
 * matches the redirect URI, so these errors never use the error callback.
 */
const CLIENT_REJECTION_CODES: ReadonlySet<string> = new Set([
  "invalid_client",
  "invalid_client_metadata",
]);

/**
 * Redirect URIs of dynamic and client-metadata-document clients are chosen by
 * unauthenticated parties, so an authorization server may answer their
 * authorization-request errors without redirecting (RFC 9700 section 4.11.2).
 */
const PROVISIONED_REDIRECT_SOURCES: ReadonlySet<McpFnClientRegistrationSource> = new Set<
  McpFnClientRegistrationSource
>(["pre-registered", "enterprise"]);

function isUnvettedRedirectSource(fixture: McpFnHostedAuthorizationCase): boolean {
  return !PROVISIONED_REDIRECT_SOURCES.has(fixture.registration.source);
}

/**
 * The one decision whether the requested redirect URI is registered, made
 * with the authorization server's own matching rule (exact match after
 * normalization, plus RFC 8252 loopback runtime ports unless the policy
 * disables them). Like the server, it applies only to the client the request
 * names, and a registration the server rejects before it matches the redirect
 * URI registers nothing: a malformed field (including a redirect URI the MCP
 * redirect profile rejects) or an ineligible registration (see
 * `isEligibleRegistration`). A URI that does not match is never registered.
 */
function registeredRedirectMatch(
  fixture: McpFnHostedAuthorizationCase,
  target: Pick<
    McpFnHostedAuthorizationTargetAdapter,
    "redirectPolicy" | "tokenEndpointAuthMethods" | "supportedScopes"
  >,
): McpFnRedirectMatch | undefined {
  const { registration, authorization } = fixture;
  if (authorization.clientId !== registration.clientId) return undefined;
  const policy = target.redirectPolicy;
  try {
    const client = normalizeMcpClientRegistration({ ...registration, redirectPolicy: policy });
    if (!isEligibleRegistration(client, registration, target)) return undefined;
    return matchMcpRedirectUri(authorization.redirectUri, client.redirectUris, policy);
  } catch {
    // A mismatch or a malformed registration is not a registered redirect.
    return undefined;
  }
}

/**
 * Mirrors the authorization server's client compatibility check, which runs
 * before redirect matching: the registration must allow response type `code`
 * and grant type `authorization_code`; its token endpoint authentication
 * method and its `scope` must be supported by the target when the adapter
 * declares `tokenEndpointAuthMethods` or `supportedScopes`.
 */
function isEligibleRegistration(
  client: McpFnNormalizedClientRegistration,
  registration: McpFnHostedRegistrationFixture,
  target: Pick<McpFnHostedAuthorizationTargetAdapter, "tokenEndpointAuthMethods" | "supportedScopes">,
): boolean {
  if (!client.responseTypes.includes("code")) return false;
  if (!client.grantTypes.includes("authorization_code")) return false;
  if (target.tokenEndpointAuthMethods) {
    // A Client ID Metadata Document without a method defaults to
    // client_secret_basic on the server.
    const method = client.source === "client-metadata-document" &&
        registration.metadata.token_endpoint_auth_method === undefined
      ? "client_secret_basic"
      : client.tokenEndpointAuthMethod;
    if (!target.tokenEndpointAuthMethods.includes(method)) return false;
  }
  const scope: unknown = client.metadata.scope;
  if (scope === undefined) return true;
  if (typeof scope !== "string") return false;
  if (!target.supportedScopes) return true;
  const supported = new Set(target.supportedScopes);
  return scope.split(/\s+/).filter(Boolean).every((entry) => supported.has(entry));
}

function isUnvettedErrorPage(
  response: Response,
  fixture: McpFnHostedAuthorizationCase,
  redirectMatch: McpFnRedirectMatch | undefined,
): boolean {
  return response.status >= 400 && response.status < 500 &&
    redirectMatch !== undefined && isUnvettedRedirectSource(fixture);
}

async function validateUnvettedErrorPage(
  response: Response,
  fixture: McpFnHostedAuthorizationCase,
  redirectMatch: McpFnRedirectMatch | undefined,
): Promise<string | undefined> {
  if (response.status !== 400) {
    throw new Error("Authorization error page has invalid HTTP status");
  }
  if (response.headers.has("location")) {
    throw new Error("Authorization error page must not redirect");
  }
  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "text/html") {
    throw new Error("Authorization error response must be an HTML page or a JSON error envelope");
  }
  const body = await response.clone().text();
  assertRedirectUriNotReflected(body, fixture, redirectMatch);
  return htmlErrorCode(body);
}

/** RFC 6749 section 5.2: error = 1*( %x20-21 / %x23-5B / %x5D-7E ). */
const OAUTH_ERROR_CODE = /^[\x20-\x21\x23-\x5B\x5D-\x7E]+$/;

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
};

/** Text of the first `<code>` element that is a valid OAuth error code. */
function htmlErrorCode(html: string): string | undefined {
  for (const match of html.matchAll(/<code\b[^>]*>([^<]*)<\/code\s*>/gi)) {
    const text = match[1]!.replace(
      /&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi,
      (_entity, decimal?: string, hex?: string, name?: string) => {
        // Anything that cannot be part of an error code decodes to NUL, which
        // the error-code charset rejects.
        if (name) return HTML_ENTITIES[name.toLowerCase()] ?? "\0";
        const point = decimal ? Number.parseInt(decimal, 10) : Number.parseInt(hex!, 16);
        return point >= 0x20 && point <= 0x7e ? String.fromCharCode(point) : "\0";
      },
    ).trim();
    if (OAUTH_ERROR_CODE.test(text)) return text;
  }
  return undefined;
}

function assertRedirectUriNotReflected(
  body: string,
  fixture: McpFnHostedAuthorizationCase,
  redirectMatch: McpFnRedirectMatch | undefined,
): void {
  // The requested URI as sent and as the server normalized it, and the
  // registered URI it matched.
  const redirectUris = new Set([
    fixture.authorization.redirectUri,
    ...(redirectMatch ? [redirectMatch.requested, redirectMatch.registered] : []),
  ]);
  const forms = [...redirectUris].flatMap((redirectUri) => [
    redirectUri,
    JSON.stringify(redirectUri).slice(1, -1),
    redirectUri.replaceAll("/", "\\/"),
    redirectUri.replaceAll("&", "&amp;"),
  ]);
  if (forms.some((form) => body.includes(form))) {
    throw new Error("Authorization error response must not reflect the client redirect URI");
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function validateAuthorizationErrorRedirect(
  response: Response,
  fixture: McpFnHostedAuthorizationCase,
  issuer: string,
  redirectMatch: McpFnRedirectMatch | undefined,
): void {
  const callback = new URL(response.headers.get("location") ?? "");
  // Redirects must target a requested URI that matched a registration, never
  // a rejected requested URI.
  if (!redirectMatch) {
    throw new Error("Rejected redirect URI must not receive a callback");
  }
  const errors = callback.searchParams.getAll("error");
  if (errors.length !== 1 || !errors[0] || callback.searchParams.has("code")) {
    throw new Error("Invalid OAuth error callback");
  }
  if (CLIENT_REJECTION_CODES.has(errors[0])) {
    throw new Error("Invalid-client authorization failures must not redirect");
  }
  callback.searchParams.delete("error");
  callback.searchParams.delete("error_description");
  callback.searchParams.delete("error_uri");
  callback.searchParams.set("code", "error-envelope-validation");
  validatedRedirectCode(
    new Response(null, { status: response.status, headers: { location: callback.toString() } }),
    fixture,
    issuer,
  );
}

function validatedRedirectCode(
  response: Response,
  fixture: McpFnHostedAuthorizationCase,
  issuer: string,
): string {
  const location = response.headers.get("location");
  if (!location) throw new Error("Authorization callback is missing");
  const callback = new URL(location);
  const expected = new URL(fixture.authorization.redirectUri);
  const codes = callback.searchParams.getAll("code");
  const states = callback.searchParams.getAll("state");
  if (codes.length !== 1 || !codes[0] || states.length !== 1 || states[0] !== fixture.authorization.state) {
    throw new Error("Authorization callback code or state is invalid");
  }
  const issuers = callback.searchParams.getAll("iss");
  if (issuers.length > 1 || (issuers.length === 1 && issuers[0] !== issuer)) {
    throw new Error("Authorization callback issuer is invalid");
  }
  if (callback.protocol !== expected.protocol || callback.host !== expected.host ||
      callback.username !== expected.username || callback.password !== expected.password ||
      callback.pathname !== expected.pathname || callback.hash !== expected.hash ||
      [...new Set(expected.searchParams.keys())].some((key) =>
        JSON.stringify(callback.searchParams.getAll(key)) !== JSON.stringify(expected.searchParams.getAll(key)))) {
    throw new Error("Authorization callback destination is invalid");
  }
  return codes[0];
}

async function validatedTokenSet(response: Response): Promise<{ refresh_token?: unknown }> {
  if (response.status !== 200) throw new Error("Successful token responses must use HTTP 200");
  if (!isJsonResponse(response)) throw new Error("Token response must use a JSON media type");
  if (!hasHeaderDirective(response.headers.get("cache-control"), "no-store") ||
      !hasHeaderDirective(response.headers.get("pragma"), "no-cache")) {
    throw new Error("Token responses must disable caching with Cache-Control: no-store and Pragma: no-cache");
  }
  const value = await response.clone().json() as Record<string, unknown> | null;
  if (!value || typeof value.access_token !== "string" || !/^[\dA-Za-z._~+/-]+=*$/.test(value.access_token) ||
      typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") {
    throw new Error("Token response requires an access token and Bearer token type");
  }
  return value;
}

function hasHeaderDirective(value: string | null, expected: string): boolean {
  return (value ?? "").split(",").some((directive) =>
    directive.trim().toLowerCase() === expected,
  );
}

function isRedirect(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function ensureTrailingSlash(value: string): URL {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
