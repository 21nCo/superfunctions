import type { OAuthProviderDescriptor } from "@superfunctions/oauth-core";
import type {
  OAuthRevocationRequest,
  OAuthTokenEndpointRequest,
  OAuthTokenEndpointResponse,
  OAuthTokenGrantType,
  OAuthTokenHttpClient
} from "./index.js";
import { OAuthHttpError, normalizeOAuthErrorBody, unsupportedTokenAuthMethodError } from "./errors.js";
import { DEFAULT_OAUTH_RETRY_POLICY, decideRetry, type OAuthRetryPolicy } from "./retry-policy.js";

interface HeadersLike {
  get(name: string): string | null;
}

interface ResponseLike {
  ok: boolean;
  status: number;
  headers: HeadersLike;
  text(): Promise<string>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type OAuthFetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

export interface OAuthTokenClientOptions {
  fetcher?: OAuthFetchLike;
  retryPolicy?: OAuthRetryPolicy;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface DisconnectWithRevokeInput {
  revokeSupported: boolean;
  revokeRequest: OAuthRevocationRequest;
  deleteLocalTokenRecord: () => Promise<void>;
  deleteConnectionRecord: () => Promise<void>;
  onRevocationFailure?: (error: OAuthHttpError) => Promise<void> | void;
}

export interface DisconnectWithRevokeResult {
  remoteRevokeAttempted: boolean;
  localTokenDeleted: boolean;
  connectionDeleted: boolean;
}

export class DefaultOAuthTokenHttpClient implements OAuthTokenHttpClient {
  private readonly fetcher: OAuthFetchLike;
  private readonly retryPolicy: OAuthRetryPolicy;
  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(options: OAuthTokenClientOptions = {}) {
    this.fetcher = options.fetcher ?? getGlobalFetch();
    this.retryPolicy = options.retryPolicy ?? DEFAULT_OAUTH_RETRY_POLICY;
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  async exchangeToken(input: OAuthTokenEndpointRequest): Promise<OAuthTokenEndpointResponse> {
    const authMethod = getTokenAuthMethod(input.provider.tokenAuthMethod);
    const endpointRequest = createTokenRequest(input, authMethod);
    const response = await this.executeWithRetry(input.provider.tokenUrl, endpointRequest);
    const contentType = response.headers.get("content-type");
    const rawBodyText = await response.text();
    const parsedBody = parseResponseBody(rawBodyText, contentType);

    if (!response.ok) {
      throw createTokenEndpointError({
        status: response.status,
        grantType: input.grantType,
        providerId: input.provider.id,
        parsedBody
      });
    }

    return normalizeTokenResponse(parsedBody);
  }

  async revokeToken(input: OAuthRevocationRequest): Promise<void> {
    if (!input.provider.revocationUrl) {
      return;
    }

    const authMethod = getTokenAuthMethod(input.provider.tokenAuthMethod);
    const endpointRequest = createRevokeRequest(input, authMethod);
    const response = await this.executeWithRetry(input.provider.revocationUrl, endpointRequest);
    if (response.ok) {
      return;
    }

    const contentType = response.headers.get("content-type");
    const rawBodyText = await response.text();
    const parsedBody = parseResponseBody(rawBodyText, contentType);
    const normalized = normalizeOAuthErrorBody(parsedBody);
    const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
    throw new OAuthHttpError(normalized.message, {
      code: response.status === 429 ? "PROVIDER_RATE_LIMITED" : "INTERNAL_ERROR",
      status: response.status,
      retryable,
      details: {
        providerId: input.provider.id,
        operation: "revoke",
        ...normalized.details
      }
    });
  }

  private async executeWithRetry(url: string, init: RequestInitLike): Promise<ResponseLike> {
    let attempt = 1;
    let response = await this.fetcher(url, init);

    while (true) {
      const decision = decideRetry(
        {
          attempt,
          status: response.status,
          retryAfterHeader: response.headers.get("retry-after")
        },
        this.retryPolicy
      );

      if (!decision.retry) {
        return response;
      }

      await this.sleep(decision.delayMs);
      attempt += 1;
      response = await this.fetcher(url, init);
    }
  }
}

export async function disconnectWithRevoke(
  client: OAuthTokenHttpClient,
  input: DisconnectWithRevokeInput
): Promise<DisconnectWithRevokeResult> {
  let revokeError: OAuthHttpError | null = null;
  let localTokenDeleted = false;
  let connectionDeleted = false;

  if (input.revokeSupported) {
    try {
      await client.revokeToken(input.revokeRequest);
    } catch (error) {
      revokeError = ensureOAuthHttpError(error);
      if (input.onRevocationFailure) {
        await input.onRevocationFailure(revokeError);
      }
    }
  }

  await input.deleteLocalTokenRecord();
  localTokenDeleted = true;
  await input.deleteConnectionRecord();
  connectionDeleted = true;

  if (revokeError) {
    throw new OAuthHttpError("provider revoke failed after local cleanup", {
      code: "INTERNAL_ERROR",
      status: 502,
      retryable: false,
      details: {
        remoteRevokeAttempted: true,
        localTokenDeleted,
        connectionDeleted,
        revokeErrorCode: revokeError.code,
        revokeMessage: revokeError.message
      }
    });
  }

  return {
    remoteRevokeAttempted: input.revokeSupported,
    localTokenDeleted,
    connectionDeleted
  };
}

function createTokenRequest(
  input: OAuthTokenEndpointRequest,
  tokenAuthMethod: "client_secret_post" | "client_secret_basic"
): RequestInitLike {
  const params = new URLSearchParams();
  params.set("grant_type", input.grantType);

  if (input.grantType === "authorization_code") {
    if (!input.code) {
      throw new OAuthHttpError("authorization code is required", {
        code: "VALIDATION_ERROR",
        status: 400
      });
    }

    params.set("code", input.code);
    if (input.redirectUri) {
      params.set("redirect_uri", input.redirectUri);
    }

    if (input.codeVerifier) {
      params.set("code_verifier", input.codeVerifier);
    }
  } else if (input.grantType === "refresh_token") {
    if (!input.refreshToken) {
      throw new OAuthHttpError("refresh token is required", {
        code: "VALIDATION_ERROR",
        status: 400
      });
    }

    params.set("refresh_token", input.refreshToken);
    if (input.redirectUri) {
      params.set("redirect_uri", input.redirectUri);
    }
  }

  if (input.scopes && input.scopes.length > 0) {
    params.set("scope", input.scopes.join(input.provider.scopeSeparator ?? " "));
  }

  return {
    method: "POST",
    headers: createAuthHeaders(input.clientId, input.clientSecret, tokenAuthMethod, params),
    body: params.toString()
  };
}

function createRevokeRequest(
  input: OAuthRevocationRequest,
  tokenAuthMethod: "client_secret_post" | "client_secret_basic"
): RequestInitLike {
  const params = new URLSearchParams();
  params.set("token", input.token);
  if (input.tokenTypeHint) {
    params.set("token_type_hint", input.tokenTypeHint);
  }

  return {
    method: "POST",
    headers: createAuthHeaders(input.clientId, input.clientSecret, tokenAuthMethod, params),
    body: params.toString()
  };
}

function createAuthHeaders(
  clientId: string,
  clientSecret: string,
  tokenAuthMethod: "client_secret_post" | "client_secret_basic",
  params: URLSearchParams
): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json, application/x-www-form-urlencoded, text/plain"
  };

  if (tokenAuthMethod === "client_secret_post") {
    params.set("client_id", clientId);
    params.set("client_secret", clientSecret);
  } else {
    params.set("client_id", clientId);
    const auth = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    headers.authorization = `Basic ${auth}`;
  }

  return headers;
}

function parseResponseBody(rawBodyText: string, contentType: string | null): unknown {
  if (rawBodyText.length === 0) {
    return {};
  }

  const normalizedContentType = contentType?.toLowerCase() ?? "";
  if (normalizedContentType.includes("application/json")) {
    return safeParseJson(rawBodyText);
  }

  if (
    normalizedContentType.includes("application/x-www-form-urlencoded") ||
    normalizedContentType.includes("text/plain")
  ) {
    return parseFormBody(rawBodyText);
  }

  const maybeJson = safeParseJson(rawBodyText);
  if (maybeJson !== null) {
    return maybeJson;
  }

  return parseFormBody(rawBodyText);
}

function normalizeTokenResponse(parsedBody: unknown): OAuthTokenEndpointResponse {
  const payload = parsedBody as Record<string, unknown>;
  const accessToken = asString(payload.access_token);
  if (!accessToken) {
    throw new OAuthHttpError("OAuth token response missing access_token", {
      code: "OAUTH_TOKEN_EXCHANGE_FAILED",
      status: 502,
      retryable: false,
      details: { parsedBody: payload }
    });
  }

  const result: OAuthTokenEndpointResponse = {
    accessToken,
    refreshToken: asString(payload.refresh_token),
    tokenType: asString(payload.token_type),
    scope: asString(payload.scope),
    idToken: asString(payload.id_token),
    raw: payload
  };

  const expiresIn = asNumber(payload.expires_in);
  if (expiresIn !== undefined) {
    result.expiresIn = expiresIn;
  }

  return result;
}

function createTokenEndpointError(input: {
  status: number;
  grantType: OAuthTokenGrantType;
  providerId: string;
  parsedBody: unknown;
}): OAuthHttpError {
  const normalized = normalizeOAuthErrorBody(input.parsedBody);
  const retryable = input.status === 429 || (input.status >= 500 && input.status <= 599);
  if (input.status === 429) {
    return new OAuthHttpError(normalized.message, {
      code: "PROVIDER_RATE_LIMITED",
      status: input.status,
      retryable: true,
      details: {
        providerId: input.providerId,
        grantType: input.grantType,
        ...normalized.details
      }
    });
  }

  return new OAuthHttpError(normalized.message, {
    code: input.grantType === "refresh_token" ? "OAUTH_TOKEN_REFRESH_FAILED" : "OAUTH_TOKEN_EXCHANGE_FAILED",
    status: input.status,
    retryable,
    details: {
      providerId: input.providerId,
      grantType: input.grantType,
      ...normalized.details
    }
  });
}

function getTokenAuthMethod(
  method: OAuthProviderDescriptor["tokenAuthMethod"] | string | undefined
): "client_secret_post" | "client_secret_basic" {
  if (!method || method === "client_secret_post") {
    return "client_secret_post";
  }

  if (method === "client_secret_basic") {
    return "client_secret_basic";
  }

  throw unsupportedTokenAuthMethodError(method);
}

function parseFormBody(rawBodyText: string): Record<string, unknown> {
  const params = new URLSearchParams(rawBodyText);
  const payload: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    payload[key] = value;
  }

  return payload;
}

function safeParseJson(rawBodyText: string): Record<string, unknown> | null {
  try {
    return JSON.parse(rawBodyText) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }

  return undefined;
}

function ensureOAuthHttpError(error: unknown): OAuthHttpError {
  if (error instanceof OAuthHttpError) {
    return error;
  }

  return new OAuthHttpError("OAuth HTTP operation failed", {
    code: "INTERNAL_ERROR",
    status: 500,
    retryable: false,
    details: { cause: String(error) }
  });
}

function getGlobalFetch(): OAuthFetchLike {
  const globalFetch = (globalThis as { fetch?: unknown }).fetch;
  if (typeof globalFetch !== "function") {
    throw new OAuthHttpError("No fetch implementation configured for OAuth HTTP client", {
      code: "INTERNAL_ERROR",
      status: 500
    });
  }

  return globalFetch as OAuthFetchLike;
}
