import {
  ContextLengthError,
  LangFnError,
  NotConfiguredError,
  ProviderAuthError,
  ProviderError,
  TimeoutError,
  ValidationError,
} from "../../core/errors.js";
import type { CompletionRequest, CompletionResponse, StreamEvent } from "../../core/types.js";
import { type SecretProvider, resolveSecret } from "../../tools/policy.js";
import { ChatModel } from "../base.js";
import { defineCapabilityProfile, requireCapability, type CapabilityProfile } from "../profiles/types.js";
import { type BodyErrorState, throwIfBodyFailed } from "../stream-lines.js";
import { getTransportClient } from "../transport.js";
import { type CredentialSource, isBearerToken } from "./credentials.js";
import { ReauthRequiredError } from "./errors.js";
import { buildResponsesPayload } from "./request.js";
import { isCallerAbort, parseResponsesResponse, raiseForResponsesStatus, readResponsesBody } from "./response.js";
import { mapResponsesStream, readServerSentEvents } from "./stream.js";
import type { ResponsesChatRequest, ResponsesChatResponse, ResponsesReasoningConfig } from "./types.js";

export interface ResponsesChatModelConfig {
  /** Provider model id, such as `gpt-5.1` or `openai/gpt-5.1` on OpenRouter. */
  model: string;
  /** API base URL; `/responses` is appended (see {@link OPENAI_BASE_URL}, {@link OPENROUTER_BASE_URL}). */
  baseUrl: string;
  /** What the endpoint and model accept; requests needing anything else fail before sending. */
  profile: CapabilityProfile;
  /**
   * Provider name on the model and its errors. LangFn's completion cache and cost meter key on
   * it, so the default is unique to this endpoint: `<profile id>-responses:<baseUrl><path>`,
   * such as `openai-responses:https://api.openai.com/v1/responses`. It never equals another
   * model class's name (such as OpenAIChatModel's `openai`), and two endpoints never share
   * cache entries by default. An explicit value is the caller's chosen scope: models given the
   * same provider and model share cache entries and cost rates.
   */
  provider?: string;
  /** Sent as `Authorization: Bearer <key>`. Omit for endpoints authenticated by `headers`. */
  apiKey?: string;
  /**
   * A pluggable bearer credential, such as an {@link OAuthTokenSource} for Sign in with ChatGPT,
   * asked before every request and told about a 401 (see {@link CredentialSource}). Exclusive
   * with `apiKey`, `apiKeyRef` and an Authorization header: a failed request never falls back to
   * another credential. Each source call is bounded by `timeout` and the request's signal; none
   * starts once the signal has aborted.
   */
  credentials?: CredentialSource;
  apiKeyRef?: string;
  secretProvider?: SecretProvider;
  /** Extra request headers, such as OpenRouter attribution or a custom endpoint's auth header. */
  headers?: Record<string, string>;
  /** Path of the Responses endpoint below the base URL; defaults to `/responses`. */
  path?: string;
  timeout?: number;
  fetchImpl?: typeof fetch;
  maxResponseBytes?: number;
  /**
   * Largest single server-sent event line, in bytes. The terminal event repeats the whole turn
   * (including encrypted reasoning) on one line, so it defaults to `maxResponseBytes`, or 16 MiB.
   */
  maxStreamLineBytes?: number;
  /** Default output token budget; a request's `maxOutputTokens` overrides it. */
  maxOutputTokens?: number;
  /** Default reasoning configuration; needs the profile's `reasoning` capability. */
  reasoning?: ResponsesReasoningConfig;
  /**
   * Optional input token estimator. With the profile's `contextWindow` it rejects requests
   * whose estimated input plus output budget exceed the window before sending them.
   */
  estimateInputTokens?: (input: readonly Record<string, unknown>[]) => number;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** fetch accepts only Latin-1 (ByteString) header values; CR, LF and NUL are never valid. */
function isHeaderValue(value: unknown): value is string {
  return typeof value === "string" && /^[^\r\n\0\u0100-\uffff]*$/.test(value);
}
const DEFAULT_MAX_STREAM_LINE_BYTES = 16 * 1024 * 1024;

/**
 * A stateless Responses API chat model for OpenAI, OpenRouter and any compatible endpoint.
 * Every request sends `store: false` with the full caller-supplied history; the model never
 * falls back to another provider.
 */
export class ResponsesChatModel extends ChatModel {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly profile: CapabilityProfile;
  private readonly path: string;
  /** The canonical endpoint (see {@link endpointHref}); every request goes to exactly this URL. */
  private readonly endpoint: URL;
  private readonly rawApiKey?: string;
  private readonly apiKeyRef?: string;
  private readonly secretProvider?: SecretProvider;
  private readonly credentials?: CredentialSource;
  private readonly headers: Record<string, string>;
  private readonly timeout: number;
  private readonly fetchImpl?: typeof fetch;
  private readonly maxResponseBytes?: number;
  private readonly maxStreamLineBytes: number;
  private readonly maxOutputTokens?: number;
  private readonly reasoning?: ResponsesReasoningConfig;
  private readonly estimateInputTokens?: ResponsesChatModelConfig["estimateInputTokens"];

  constructor(config: ResponsesChatModelConfig) {
    super();
    if (!config || typeof config !== "object") throw new ValidationError("ResponsesChatModel requires a config");
    if (typeof config.model !== "string" || !config.model.trim()) throw new ValidationError("ResponsesChatModel requires a model");
    this.profile = defineCapabilityProfile(config.profile);
    this.model = config.model;
    this.baseUrl = validateBaseUrl(config.baseUrl);
    this.path = validatePath(config.path ?? "/responses");
    const endpoint = endpointHref(this.baseUrl, this.path);
    this.endpoint = new URL(endpoint);
    if (config.provider !== undefined && (typeof config.provider !== "string" || !config.provider.trim())) {
      throw new ValidationError("ResponsesChatModel provider must be a non-empty string");
    }
    this.provider = config.provider ?? `${this.profile.id}-responses:${endpoint}`;
    this.headers = validateHeaders(config.headers);
    const hasAuthHeader = Object.keys(this.headers).some((name) => name.toLowerCase() === "authorization");
    if (hasAuthHeader && (config.apiKey !== undefined || config.apiKeyRef !== undefined)) {
      throw new ValidationError("Configure either apiKey/apiKeyRef or an Authorization header, not both");
    }
    if (config.credentials !== undefined) {
      const source = config.credentials as Partial<CredentialSource> | null;
      if (!source || typeof source.getAccessToken !== "function" || typeof source.onAuthError !== "function") {
        throw new ValidationError("credentials must implement getAccessToken() and onAuthError()");
      }
      if (hasAuthHeader || config.apiKey !== undefined || config.apiKeyRef !== undefined) {
        throw new ValidationError("Configure credentials alone, without apiKey, apiKeyRef or an Authorization header");
      }
      this.credentials = config.credentials;
    }
    // The credential becomes a header value; a value fetch would reject fails here, typed and
    // without echoing it.
    if (config.apiKey !== undefined && !isHeaderValue(config.apiKey)) {
      throw new ValidationError("ResponsesChatModel apiKey must be a single-line Latin-1 string");
    }
    // A blank key is no credential; sent as "Bearer   " it would only fail at the provider.
    if (config.apiKey && !config.apiKey.trim()) {
      throw new ValidationError("ResponsesChatModel apiKey must not be blank");
    }
    this.rawApiKey = config.apiKey;
    this.apiKeyRef = config.apiKeyRef;
    this.secretProvider = config.secretProvider;
    this.timeout = config.timeout ?? 60_000;
    this.fetchImpl = config.fetchImpl;
    this.maxResponseBytes = config.maxResponseBytes;
    this.maxStreamLineBytes = config.maxStreamLineBytes ?? config.maxResponseBytes ?? DEFAULT_MAX_STREAM_LINE_BYTES;
    if (!Number.isSafeInteger(this.maxStreamLineBytes) || this.maxStreamLineBytes <= 0) {
      throw new ValidationError("maxStreamLineBytes must be a positive safe integer");
    }
    this.maxOutputTokens = config.maxOutputTokens;
    if (config.reasoning !== undefined) requireCapability(this.profile, "reasoning", "the model sets a default reasoning configuration");
    this.reasoning = config.reasoning;
    if (config.estimateInputTokens !== undefined && typeof config.estimateInputTokens !== "function") {
      throw new ValidationError("estimateInputTokens must be a function");
    }
    this.estimateInputTokens = config.estimateInputTokens;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    return await this.completeFromChat(request);
  }

  async chat(request: ResponsesChatRequest): Promise<ResponsesChatResponse> {
    if (this.profile.streamOnly) return await this.chatFromStream(request);
    const payload = this.payload(request, false);
    // The call ids of the history as sent, before the caller can change its messages.
    const sent = sentCallIds(payload);
    const response = await this.send(payload, request.signal, "application/json");
    const text = await readResponsesBody(this.provider, response, request.signal);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new ProviderError("Responses body is not valid JSON", { provider: this.provider, cause: error });
    }
    return parseResponsesResponse(data, this.provider, { sentCallIds: sent });
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamEvent> {
    yield* this.streamChat({
      messages: [{ role: "user", content: request.prompt }],
      signal: request.signal,
      metadata: request.metadata,
    });
  }

  /** Stream a full chat request (history, tools, structured output, reasoning). */
  async *streamChat(request: ResponsesChatRequest): AsyncIterable<StreamEvent> {
    yield* this.streamTurn(request);
  }

  /** A stream-only route's whole turn: the streamed request, read to its terminal response. */
  private async chatFromStream(request: ResponsesChatRequest): Promise<ResponsesChatResponse> {
    let result: ResponsesChatResponse | undefined;
    for await (const event of this.streamTurn(request, (response) => { result = response; })) {
      if (event.type === "end") break;
    }
    if (!result) throw new ProviderError("Responses stream ended before a terminal response event", { provider: this.provider });
    return result;
  }

  private async *streamTurn(
    request: ResponsesChatRequest,
    onResponse?: (response: ResponsesChatResponse) => void,
  ): AsyncIterable<StreamEvent> {
    const payload = this.payload(request, true);
    // The call ids of the history as sent, before the caller can change its messages.
    const sent = sentCallIds(payload);
    const response = await this.send(payload, request.signal, "text/event-stream");
    if (!response.body) throw new ProviderError("Responses stream body was empty", { provider: this.provider });
    const signal = request.signal;
    // The transport errors the body on a timeout, a byte limit crossed by a prefetched chunk or
    // an abort; the line reader records that error.
    const bodyError: BodyErrorState = {};
    // Events may already be buffered when the caller aborts or the body fails, so both are
    // checked before every yield and as soon as the caller resumes, before the mapper reads
    // further: after either, nothing more is delivered, and the stream rejects with the abort
    // reason or the body error instead of finishing normally or failing on a later frame. The
    // body error goes first: it is the first failure, since a caller abort before it errors the
    // body with the abort reason. Once the terminal response is parsed the mapper has released
    // the body, so a later deadline or byte limit cannot fail the turn; after `end` is
    // delivered nothing is checked and the stream completes normally.
    const check = () => {
      throwIfBodyFailed(bodyError);
      throwIfAborted(signal);
    };
    // A body failure that is neither LangFn's own nor the caller's cancellation (an upstream or
    // transport abort, say) is a ProviderError with that cause, as a JSON body read makes it.
    const classify = (error: unknown): unknown => (error instanceof LangFnError || isCallerAbort(error, signal)
      ? error
      : new ProviderError("Responses stream body could not be read", { provider: this.provider, cause: error }));
    const events = readServerSentEvents(response.body, this.maxStreamLineBytes, { bodyError });
    try {
      try {
        for await (const event of mapResponsesStream(events, this.provider, { sentCallIds: sent, onResponse })) {
          check();
          yield event;
          if (event.type === "end") return;
          check();
        }
      } catch (error) {
        check();
        throw error;
      }
      check();
    } catch (error) {
      throw classify(error);
    }
  }

  private payload(request: ResponsesChatRequest, stream: boolean): Record<string, unknown> {
    const payload = buildResponsesPayload(request, {
      model: this.model,
      profile: this.profile,
      stream,
      maxOutputTokens: this.maxOutputTokens,
      reasoning: this.reasoning,
    });
    const contextWindow = this.profile.contextWindow;
    if (this.estimateInputTokens && contextWindow !== undefined) {
      const estimated = this.estimateInputTokens(payload.input as Record<string, unknown>[]);
      if (!Number.isSafeInteger(estimated) || estimated < 0) {
        throw new ValidationError("estimateInputTokens must return a nonnegative safe integer");
      }
      const output = typeof payload.max_output_tokens === "number" ? payload.max_output_tokens : 0;
      if (estimated + output > contextWindow) {
        throw new ContextLengthError(
          `Estimated ${estimated} input tokens plus ${output} output tokens exceed the ${this.profile.id} context window of ${contextWindow}`,
          { provider: this.provider, metadata: { estimatedInputTokens: estimated, maxOutputTokens: output, contextWindow } },
        );
      }
    }
    return payload;
  }

  /**
   * Send with the configured credential. A credential source sees a 401 and may renew its token
   * for one retry; any other outcome, a quota or rate limit included, is final.
   */
  private async send(payload: Record<string, unknown>, signal: AbortSignal | undefined, accept: string): Promise<Response> {
    const source = this.credentials;
    if (!source) return await this.sendOnce(payload, signal, accept);
    let token = await this.accessToken(source, signal);
    let firstRejection: ProviderAuthError;
    try {
      return await this.sendOnce(payload, signal, accept, token);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      firstRejection = error;
    }
    const retry = await this.credentialStep(() => source.onAuthError({ token, error: firstRejection, attempt: 1 }), signal);
    if (retry !== true) throw firstRejection;
    token = await this.accessToken(source, signal);
    try {
      return await this.sendOnce(payload, signal, accept, token);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      await this.credentialStep(() => source.onAuthError({ token, error, attempt: 2 }), signal);
      throw new ReauthRequiredError(undefined, { provider: this.provider, metadata: error.metadata, cause: error });
    }
  }

  private async accessToken(source: CredentialSource, signal: AbortSignal | undefined): Promise<string> {
    const token = await this.credentialStep(() => source.getAccessToken(), signal);
    // Checked without echoing the token.
    if (typeof token !== "string" || !token.trim()) {
      throw new NotConfiguredError(`${this.provider} credential source returned no access token`, { provider: this.provider });
    }
    if (!isBearerToken(token)) {
      throw new ValidationError(`${this.provider} access token must be a single-line Latin-1 string`, { provider: this.provider });
    }
    return token;
  }

  /**
   * Run a credential step (a token lookup, a refresh) under the caller's signal and the model's
   * timeout. A signal already aborted runs no step; a step that settles after the abort or the
   * timeout has nobody waiting for it, so its outcome is observed and dropped.
   */
  private async credentialStep<T>(step: () => T | Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    throwIfAborted(signal);
    const promise = Promise.resolve().then(() => {
      throwIfAborted(signal);
      return step();
    });
    promise.catch(() => undefined);
    let stop = () => {};
    const stopped = new Promise<never>((_, reject) => {
      const onAbort = () => reject(signal?.reason);
      const timer = this.timeout > 0
        ? setTimeout(() => reject(new TimeoutError(`${this.provider} credential source timed out`, { provider: this.provider })), this.timeout)
        : undefined;
      signal?.addEventListener("abort", onAbort, { once: true });
      stop = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
    });
    stopped.catch(() => undefined);
    try {
      return await Promise.race([promise, stopped]);
    } catch (error) {
      // A source's re-auth signal names the model's provider, as the model's own one does.
      if (error instanceof ReauthRequiredError && error.provider === undefined) {
        throw new ReauthRequiredError(error.message, { provider: this.provider, metadata: error.metadata, cause: error });
      }
      throw error;
    } finally {
      stop();
    }
  }

  private async sendOnce(payload: Record<string, unknown>, signal: AbortSignal | undefined, accept: string, token?: string): Promise<Response> {
    const headers: Record<string, string> = { ...this.headers, "content-type": "application/json", accept };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    else if (this.rawApiKey !== undefined || this.apiKeyRef !== undefined) {
      const apiKey = this.rawApiKey || resolveSecret(this.apiKeyRef, this.secretProvider) || "";
      if (!apiKey.trim()) throw new NotConfiguredError(`${this.provider} API key is required`, { provider: this.provider });
      if (!isHeaderValue(apiKey)) {
        throw new ValidationError(`${this.provider} API key must be a single-line Latin-1 string`, { provider: this.provider });
      }
      headers.authorization = `Bearer ${apiKey}`;
    }
    const client = getTransportClient({
      // The transport joins its base and path; the canonical origin and pathname join to the
      // canonical href, so the request names the endpoint the cache identity names.
      baseUrl: this.endpoint.origin,
      headers,
      timeout: this.timeout,
      fetchImpl: this.fetchImpl,
      maxResponseBytes: this.maxResponseBytes,
    });
    // Redirects are never followed: a re-sent POST would carry the credentials, custom auth
    // headers and the caller's history to whatever origin the redirect names.
    const response = await client.request(this.endpoint.pathname, {
      method: "POST",
      signal,
      body: JSON.stringify(payload),
      redirect: "manual",
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      // Release the body without waiting: a cancel that never settles must not outlive the error.
      discardBody(response);
      throw new ProviderError(`${this.provider} Responses endpoint answered with a redirect, which is not followed`, {
        provider: this.provider,
        metadata: { status: response.status, redirect: true },
      });
    }
    await raiseForResponsesStatus(this.provider, response, signal);
    return response;
  }
}

/** The function call ids in the history a payload sends: its stateless call ledger. */
function sentCallIds(payload: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const item of payload.input as Record<string, unknown>[]) {
    if (item.type === "function_call" && typeof item.call_id === "string") ids.add(item.call_id);
  }
  return ids;
}

/**
 * The endpoint path stays below the base URL and is canonical, so the request and the default
 * cache identity name the same endpoint: no query, fragment, whitespace, backslash or dot
 * segment (also percent-encoded).
 */
function validatePath(path: unknown): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new ValidationError("ResponsesChatModel path must start with a single /");
  }
  if (/[\s?#\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment))) {
    throw new ValidationError("ResponsesChatModel path must not contain whitespace, control characters, ?, #, a backslash or dot segments");
  }
  return path;
}

/**
 * The URL a request goes to, as fetch resolves it. It must stay on the base origin and under the
 * base path; the default cache identity names this canonical href.
 */
function endpointHref(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  let url: URL;
  try {
    url = new URL(`${baseUrl}${path}`);
  } catch {
    throw new ValidationError("ResponsesChatModel path does not form a valid URL with the baseUrl");
  }
  const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || url.search || url.hash) {
    throw new ValidationError("ResponsesChatModel path must stay under the baseUrl");
  }
  return url.href;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason;
}

/** A 401 from the endpoint itself (not an auth error reported inside a 200 body or stream). */
function isUnauthorized(error: unknown): error is ProviderAuthError {
  return error instanceof ProviderAuthError && !(error instanceof ReauthRequiredError) && error.metadata.status === 401;
}

function discardBody(response: Response): void {
  try {
    response.body?.cancel().catch(() => undefined);
  } catch {
    // A body that cannot be cancelled is left to the garbage collector.
  }
}

function validateBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value) throw new ValidationError("ResponsesChatModel requires a baseUrl");
  if (value !== value.trim()) throw new ValidationError("ResponsesChatModel baseUrl must not have leading or trailing whitespace");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("ResponsesChatModel baseUrl must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("ResponsesChatModel baseUrl must use http or https");
  }
  if (url.username || url.password) throw new ValidationError("ResponsesChatModel baseUrl must not embed credentials");
  // A bare trailing "?" or "#" leaves url.search and url.hash empty but would still swallow the path.
  if (url.search || url.hash || value.includes("?") || value.includes("#")) throw new ValidationError("ResponsesChatModel baseUrl must not have a query or fragment");
  // Build from the parsed URL so non-canonical spellings (a trailing backslash, dot segments)
  // cannot yield a different path than the one validated.
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  return `${url.origin}${path}`;
}

function validateHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined) return {};
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new ValidationError("headers must be an object");
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) throw new ValidationError(`Invalid header name: ${name}`);
    if (!isHeaderValue(value)) throw new ValidationError(`Header ${name} must be a single-line Latin-1 string`);
    const lower = name.toLowerCase();
    if (lower === "content-type" || lower === "accept") throw new ValidationError(`Header ${name} is set by the model`);
    if (seen.has(lower)) throw new ValidationError(`Header ${name} is set more than once`);
    seen.add(lower);
    result[name] = value;
  }
  return result;
}
