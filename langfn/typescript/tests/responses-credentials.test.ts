import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { ProviderAuthError, RateLimitError, ValidationError } from "../src/core/errors.js";
import type { StreamEvent } from "../src/core/types.js";
import {
  chatGPTSignInProfile,
  defineCapabilityProfile,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  openAIProfile,
  openRouterProfile,
  RouteRestrictionError,
  type CapabilityProfile,
} from "../src/models/profiles/index.js";
import {
  buildResponsesPayload,
  OAuthTokenSource,
  QuotaExceededError,
  ReauthRequiredError,
  ResponsesChatModel,
  StaticApiKeySource,
  type CredentialSource,
  type OAuthRefreshContext,
  type ResponsesChatRequest,
} from "../src/models/responses/index.js";
import { retryAsync } from "../src/utils/retry.js";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/responses");
// Obviously fake credentials; no value here is a real token.
const TEST_API_KEY = "test-api-key";
const FIRST_TOKEN = "test-oauth-access-token-1";
const SECOND_TOKEN = "test-oauth-access-token-2";

interface RecordedRequest {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

/** Serve recorded fixtures in order and record each request; never touches the network. */
function replay(fixtures: string[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...fixtures];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const fixture = queue.shift();
    if (!fixture) throw new Error(`Unexpected request to ${String(input)}`);
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const path = resolve(fixtureRoot, fixture);
    if (fixture.endsWith(".sse")) {
      return new Response(readFileSync(path, "utf8"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const recorded = JSON.parse(readFileSync(path, "utf8"));
    return new Response(JSON.stringify(recorded.body), { status: recorded.status, headers: recorded.headers });
  });
  return { fetchImpl, requests, remaining: () => queue.length };
}

function oauthSource(tokens: Array<string | null>, initial: string | undefined = FIRST_TOKEN) {
  const refreshes: OAuthRefreshContext[] = [];
  const queue = [...tokens];
  const refresh = vi.fn(async (context: OAuthRefreshContext) => {
    refreshes.push(context);
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected refresh");
    return next === null ? null : { accessToken: next };
  });
  const source = new OAuthTokenSource({ token: initial ? { accessToken: initial } : undefined, refresh });
  return { source, refresh, refreshes };
}

/** Wrap a source to count its calls without changing its behavior. */
function spied(source: CredentialSource) {
  const getAccessToken = vi.fn(() => source.getAccessToken());
  const onAuthError = vi.fn((context: Parameters<CredentialSource["onAuthError"]>[0]) => source.onAuthError(context));
  return { getAccessToken, onAuthError };
}

function chatgptModel(fetchImpl: typeof fetch, credentials: CredentialSource, profile: CapabilityProfile = chatGPTSignInProfile()) {
  return new ResponsesChatModel({ model: "gpt-5.1", baseUrl: OPENAI_BASE_URL, profile, credentials, fetchImpl });
}

const ask: ResponsesChatRequest = { messages: [{ role: "user", content: "What is the capital of France?" }] };

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Sign in with ChatGPT credentials", () => {
  it("refreshes the token once after a 401 and retries with the new token", async () => {
    const server = replay(["chatgpt-signin/unauthorized.json", "chatgpt-signin/stream-text.sse"]);
    const { source, refreshes } = oauthSource([SECOND_TOKEN]);
    const response = await chatgptModel(server.fetchImpl, source).chat(ask);

    expect(response.message.content).toBe("Paris is the capital.");
    expect(response.responseId).toBe("resp_fixture_chatgpt_stream");
    expect(server.requests.map((request) => request.headers.get("authorization"))).toEqual([
      `Bearer ${FIRST_TOKEN}`,
      `Bearer ${SECOND_TOKEN}`,
    ]);
    expect(refreshes).toEqual([{ reason: "rejected", previousToken: FIRST_TOKEN }]);
    // The retry resends the same request.
    expect(server.requests[1].body).toEqual(server.requests[0].body);
    expect(server.remaining()).toBe(0);
  });

  it("requires sign-in again when the refreshed token is rejected too, and asks again next time", async () => {
    const server = replay(["chatgpt-signin/unauthorized.json", "chatgpt-signin/unauthorized.json", "chatgpt-signin/stream-text.sse"]);
    const { source, refreshes } = oauthSource([SECOND_TOKEN, "test-oauth-access-token-3"]);
    const model = chatgptModel(server.fetchImpl, source);

    const error = await model.chat(ask).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReauthRequiredError);
    expect(error).toBeInstanceOf(ProviderAuthError);
    expect((error as ReauthRequiredError).code).toBe("PROVIDER_REAUTH_REQUIRED");
    expect(server.requests).toHaveLength(2);

    // The rejected token is not resent: the next request asks the app for a new one first.
    await expect(model.chat(ask)).resolves.toMatchObject({ message: { content: "Paris is the capital." } });
    expect(refreshes.map((context) => context.reason)).toEqual(["rejected", "initial"]);
    expect(server.requests[2].headers.get("authorization")).toBe("Bearer test-oauth-access-token-3");
  });

  it("requires sign-in again, without a retry, when the refresh reports the session ended", async () => {
    const server = replay(["chatgpt-signin/unauthorized.json"]);
    const { source } = oauthSource([null]);
    await expect(chatgptModel(server.fetchImpl, source).chat(ask)).rejects.toBeInstanceOf(ReauthRequiredError);
    expect(server.requests).toHaveLength(1);
  });

  it("surfaces a refresh failure unchanged and tries the refresh again on the next request", async () => {
    const outage = new Error("token endpoint unreachable");
    const refresh = vi.fn().mockRejectedValueOnce(outage).mockResolvedValueOnce({ accessToken: SECOND_TOKEN });
    const source = new OAuthTokenSource({ refresh });
    await expect(source.getAccessToken()).rejects.toBe(outage);
    await expect(source.getAccessToken()).resolves.toBe(SECOND_TOKEN);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("shares one refresh between concurrent requests rejected with the same token", async () => {
    const server = replay([
      "chatgpt-signin/unauthorized.json",
      "chatgpt-signin/unauthorized.json",
      "chatgpt-signin/stream-text.sse",
      "chatgpt-signin/stream-text.sse",
    ]);
    const { source, refresh } = oauthSource([SECOND_TOKEN]);
    const model = chatgptModel(server.fetchImpl, source);
    const results = await Promise.all([model.chat(ask), model.chat(ask)]);
    expect(results.map((result) => result.message.content)).toEqual(["Paris is the capital.", "Paris is the capital."]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(server.requests.slice(2).map((request) => request.headers.get("authorization"))).toEqual([
      `Bearer ${SECOND_TOKEN}`,
      `Bearer ${SECOND_TOKEN}`,
    ]);
  });

  it("refreshes a token inside its expiry margin before sending", async () => {
    let now = 1_000_000;
    const refresh = vi.fn(async () => ({ accessToken: SECOND_TOKEN, expiresAt: now + 3_600_000 }));
    const source = new OAuthTokenSource({ token: { accessToken: FIRST_TOKEN, expiresAt: now + 120_000 }, refresh, now: () => now });
    await expect(source.getAccessToken()).resolves.toBe(FIRST_TOKEN);
    now += 61_000;
    await expect(source.getAccessToken()).resolves.toBe(SECOND_TOKEN);
    expect(refresh).toHaveBeenCalledWith({ reason: "expired", previousToken: FIRST_TOKEN });
  });

  it("stops waiting for a token when the caller aborts", async () => {
    const server = replay([]);
    const source: CredentialSource = { getAccessToken: () => new Promise<string>(() => {}), onAuthError: () => false };
    const controller = new AbortController();
    const pending = chatgptModel(server.fetchImpl, source).chat({ ...ask, signal: controller.signal });
    const reason = new Error("caller cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(server.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an invalid token from the source without sending or echoing it", async () => {
    const server = replay([]);
    const bad = "test-token\r\nx-injected: 1";
    const error = await chatgptModel(server.fetchImpl, { getAccessToken: () => bad, onAuthError: () => false })
      .chat(ask)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect(String((error as Error).message)).not.toContain("x-injected");
    expect(server.fetchImpl).not.toHaveBeenCalled();
    expect(() => new OAuthTokenSource({ token: { accessToken: " " }, refresh: () => null })).toThrow(ValidationError);
  });
});

describe("quota exhaustion", () => {
  it("surfaces a ChatGPT plan usage limit as QuotaExceededError with no retry or credential switch", async () => {
    const server = replay(["chatgpt-signin/usage-limit.json"]);
    const { source, refresh } = oauthSource([]);
    const calls = spied(source);
    const model = chatgptModel(server.fetchImpl, calls);

    const error = await retryAsync(() => model.chat(ask), { baseDelayMs: 0, maxDelayMs: 0 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).not.toBeInstanceOf(RateLimitError);
    expect((error as QuotaExceededError).code).toBe("PROVIDER_QUOTA_EXCEEDED");
    expect((error as QuotaExceededError).retryAfter).toBe(3600);
    // One request, one token, and the credential is never consulted about the failure.
    expect(server.requests).toHaveLength(1);
    expect(calls.getAccessToken).toHaveBeenCalledTimes(1);
    expect(calls.onAuthError).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("surfaces a usage limit reported inside the stream as QuotaExceededError", async () => {
    const server = replay(["chatgpt-signin/stream-usage-limit.sse"]);
    const { source } = oauthSource([]);
    await expect(collect(chatgptModel(server.fetchImpl, source).streamChat(ask))).rejects.toBeInstanceOf(QuotaExceededError);
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    ["OpenAI insufficient_quota (HTTP 429)", openAIProfile(), OPENAI_BASE_URL, "openai/insufficient-quota.json"],
    ["OpenRouter insufficient credits (HTTP 402)", openRouterProfile(), OPENROUTER_BASE_URL, "openrouter/insufficient-credits.json"],
  ] as const)("maps %s to QuotaExceededError, not a retryable rate limit", async (_name, profile, baseUrl, fixture) => {
    const server = replay([fixture]);
    const model = new ResponsesChatModel({ model: "gpt-5.1", baseUrl, profile, apiKey: TEST_API_KEY, fetchImpl: server.fetchImpl });
    const error = await model.chat(ask).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(QuotaExceededError);
    expect(error).not.toBeInstanceOf(RateLimitError);
  });

  it("keeps an ordinary 429 a RateLimitError", async () => {
    const server = replay(["openai/rate-limit.json"]);
    const model = new ResponsesChatModel({
      model: "gpt-5.1", baseUrl: OPENAI_BASE_URL, profile: openAIProfile(), apiKey: TEST_API_KEY, fetchImpl: server.fetchImpl,
    });
    await expect(model.chat(ask)).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("chatgpt-signin profile", () => {
  const untyped = (extra: Record<string, unknown>) => ({ ...ask, ...extra }) as unknown as ResponsesChatRequest;

  it.each([
    ["previous_response_id", { previous_response_id: "resp_fixture_earlier" }, "previousResponseId"],
    ["previousResponseId", { previousResponseId: "resp_fixture_earlier" }, "previousResponseId"],
    ["background", { background: true }, "background"],
    ["conversation", { conversation: "conv_fixture" }, "hostedHistory"],
    ["store", { store: true }, "hostedHistory"],
    ["tools[0]", { tools: [{ type: "web_search", name: "web_search" }] }, "hostedTools"],
    ["tool_choice", { tool_choice: { type: "web_search_preview" } }, "hostedTools"],
    ["tool_choice", { tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "file_search" }] } }, "hostedTools"],
  ])("rejects %s before any credential or request", async (option, extra, restriction) => {
    const server = replay([]);
    const getAccessToken = vi.fn(() => FIRST_TOKEN);
    const model = chatgptModel(server.fetchImpl, { getAccessToken, onAuthError: () => false });
    for (const run of [() => model.chat(untyped(extra)), () => collect(model.streamChat(untyped(extra)))]) {
      const error = await run().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RouteRestrictionError);
      expect(error).toMatchObject({ code: "ROUTE_RESTRICTION", option, restriction, profileId: "chatgpt-signin" });
    }
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(server.fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a replayed hosted tool call in the history", () => {
    const request: ResponsesChatRequest = {
      messages: [
        ask.messages[0],
        {
          role: "assistant",
          content: "",
          responsesOutput: [{ type: "web_search_call", id: "ws_fixture", status: "completed", action: { type: "search", query: "capital" } }],
        },
        { role: "user", content: "And of Spain?" },
      ],
    };
    expect(() => buildResponsesPayload(request, { model: "gpt-5.1", profile: chatGPTSignInProfile(), stream: true }))
      .toThrow(RouteRestrictionError);
  });

  it("forces stream: true and store: false, and chat() returns the whole streamed turn", async () => {
    const server = replay(["chatgpt-signin/stream-text.sse"]);
    const { source } = oauthSource([]);
    const tools = [{ name: "lookup", description: "Look up a fact", input_schema: { type: "object", properties: {} } }];
    const response = await chatgptModel(server.fetchImpl, source).chat({ ...untyped({ background: false, store: false }), tools });
    expect(server.requests[0].body).toMatchObject({ stream: true, store: false, tools: [{ type: "function", name: "lookup" }] });
    expect(server.requests[0].body).not.toHaveProperty("background");
    expect(server.requests[0].headers.get("accept")).toBe("text/event-stream");
    expect(response).toMatchObject({ message: { role: "assistant", content: "Paris is the capital." }, finishReason: "stop" });
    expect(response.usage).toMatchObject({ prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 });
    expect(() => buildResponsesPayload(ask, { model: "gpt-5.1", profile: chatGPTSignInProfile(), stream: false }))
      .toThrow(RouteRestrictionError);
  });

  it("keeps its route limits fixed", () => {
    for (const field of ["streaming", "streamOnly", "restrictions", "id"]) {
      expect(() => chatGPTSignInProfile({ [field]: false } as never)).toThrow(ValidationError);
    }
    expect(chatGPTSignInProfile({ vision: false })).toMatchObject({ id: "chatgpt-signin", vision: false, streaming: true, streamOnly: true });
    expect(() => defineCapabilityProfile({ ...openAIProfile(), streaming: false, streamOnly: true })).toThrow(ValidationError);
    expect(() => defineCapabilityProfile({ ...openAIProfile(), restrictions: ["hostedHistory", "anything" as never] })).toThrow(ValidationError);
  });
});

describe("credential configuration", () => {
  it("never combines a credential source with an API key or Authorization header", () => {
    const credentials = new StaticApiKeySource(TEST_API_KEY);
    const base = { model: "gpt-5.1", baseUrl: OPENAI_BASE_URL, profile: chatGPTSignInProfile(), credentials };
    expect(() => new ResponsesChatModel({ ...base, apiKey: TEST_API_KEY })).toThrow(ValidationError);
    expect(() => new ResponsesChatModel({ ...base, apiKeyRef: "OPENAI_API_KEY" })).toThrow(ValidationError);
    expect(() => new ResponsesChatModel({ ...base, headers: { Authorization: "Bearer test-other" } })).toThrow(ValidationError);
    expect(() => new ResponsesChatModel({ ...base, credentials: {} as CredentialSource })).toThrow(ValidationError);
  });

  it("sends a static key source exactly as the apiKey option, and surfaces its 401 unchanged", async () => {
    const viaOption = replay(["openai/text.json", "openai/auth.json"]);
    const viaSource = replay(["openai/text.json", "openai/auth.json"]);
    const config = { model: "gpt-5.1", baseUrl: OPENAI_BASE_URL, profile: openAIProfile() };
    const source = spied(new StaticApiKeySource(TEST_API_KEY));
    const models = [
      new ResponsesChatModel({ ...config, apiKey: TEST_API_KEY, fetchImpl: viaOption.fetchImpl }),
      new ResponsesChatModel({ ...config, credentials: source, fetchImpl: viaSource.fetchImpl }),
    ];
    const [first, second] = await Promise.all(models.map((model) => model.chat(ask)));
    expect(second).toEqual(first);
    const errors = await Promise.all(models.map((model) => model.chat(ask).catch((caught: unknown) => caught)));
    for (const error of errors) {
      expect(error).toBeInstanceOf(ProviderAuthError);
      expect(error).not.toBeInstanceOf(ReauthRequiredError);
      expect((error as ProviderAuthError).code).toBe("PROVIDER_AUTH");
    }
    for (const [left, right] of viaOption.requests.map((request, index) => [request, viaSource.requests[index]])) {
      expect(right.url).toBe(left.url);
      expect(right.body).toEqual(left.body);
      expect([...right.headers]).toEqual([...left.headers]);
    }
    expect(viaSource.requests).toHaveLength(2);
    expect(source.onAuthError).toHaveBeenCalledTimes(1);
    expect(() => new StaticApiKeySource(" ")).toThrow(ValidationError);
  });
});
