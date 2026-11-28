import type { AuthFnTokenCheck } from "./token-authority.js";

/** Remote verification through AuthFn's RFC 7662 introspection endpoint. */
export interface AuthFnIntrospectionOptions {
  /** `{issuer origin}{basePath}/oauth/introspect`, for example `https://auth.example.com/auth/oauth/introspect`. */
  endpoint: string | URL;
  /**
   * The `introspectionSecret` AuthFn has configured for this resource: an
   * RFC 6750 `b64token`. AuthFn reports a token active only to the resource it
   * was issued for, so one secret serves one resource.
   */
  secret: string;
  fetch?: typeof fetch;
  /** Deadline for the whole introspection answer. Defaults to 5000 ms. */
  timeoutMs?: number;
  /** Allow `http://` for a literal loopback endpoint in local testing. */
  allowInsecureLoopback?: boolean;
}

// RFC 6750 2.1 b64token, as AuthFn requires of introspection secrets.
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/** The provider answered, but not with a usable introspection document. */
class IntrospectionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthFnIntrospectionUnavailableError";
  }
}

function validateEndpoint(options: AuthFnIntrospectionOptions): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint.toString());
  } catch {
    throw new TypeError("The AuthFn introspection endpoint must be an absolute URL");
  }
  const loopbackHttp =
    options.allowInsecureLoopback === true &&
    endpoint.protocol === "http:" &&
    LOOPBACK_HOSTS.has(endpoint.hostname);
  if ((endpoint.protocol !== "https:" && !loopbackHttp) || endpoint.username || endpoint.password || endpoint.hash) {
    throw new TypeError(
      "The AuthFn introspection endpoint must use HTTPS without credentials or a fragment",
    );
  }
  return endpoint;
}

function readScopes(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (typeof value !== "string") return undefined;
  return value.split(" ").filter((scope) => scope.length > 0);
}

/**
 * Builds a per-resource check that POSTs the token to the introspection
 * endpoint with the resource's secret. An answer that is not `active: true`
 * for exactly this resource, with a client, subject and finite `exp`, is
 * `null` (not active). A failed request, a timeout, a redirect, a non-200
 * status or a body that is not a JSON object throws: the provider could not
 * be asked.
 */
export function createIntrospectionVerifier(
  options: AuthFnIntrospectionOptions,
): (resource: string) => AuthFnTokenCheck {
  if (!options || typeof options !== "object") {
    throw new TypeError("AuthFn introspection options are required");
  }
  const endpoint = validateEndpoint(options);
  if (typeof options.secret !== "string" || !B64TOKEN.test(options.secret)) {
    throw new TypeError("The AuthFn introspection secret must be an RFC 6750 b64token");
  }
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("The AuthFn introspection timeoutMs must be a positive number");
  }
  const fetchFn = options.fetch ?? globalThis.fetch;
  const authorization = `Bearer ${options.secret}`;

  return (resource) => async (token) => {
    let body: unknown;
    try {
      const response = await fetchFn(endpoint.toString(), {
        method: "POST",
        headers: {
          authorization,
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ token, token_type_hint: "access_token" }).toString(),
        // Never resend the secret to wherever a redirect points.
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) {
        void response.body?.cancel().catch(() => undefined);
        throw new IntrospectionUnavailableError(
          `AuthFn introspection answered ${response.status}`,
        );
      }
      body = await response.json();
    } catch (error) {
      if (error instanceof IntrospectionUnavailableError) throw error;
      throw new IntrospectionUnavailableError("AuthFn introspection failed");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new IntrospectionUnavailableError("AuthFn introspection answered a non-object");
    }
    const answer = body as Record<string, unknown>;
    const scopes = readScopes(answer.scope);
    if (
      answer.active !== true ||
      answer.aud !== resource ||
      typeof answer.client_id !== "string" ||
      typeof answer.sub !== "string" ||
      typeof answer.exp !== "number" ||
      !Number.isFinite(answer.exp) ||
      scopes === undefined ||
      (answer.token_type !== undefined &&
        (typeof answer.token_type !== "string" || answer.token_type.toLowerCase() !== "bearer"))
    ) {
      return null;
    }
    return {
      token,
      clientId: answer.client_id,
      scopes,
      expiresAt: answer.exp,
      resource: new URL(resource),
      extra: { subject: answer.sub },
    };
  };
}
