import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolAgent } from "../src/agents/tool_agent.js";
import { LangFn } from "../src/client.js";
import {
  ContextLengthError,
  ProviderAuthError,
  ProviderError,
  RateLimitError,
} from "../src/core/errors.js";
import type { StreamEvent } from "../src/core/types.js";
import {
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  openAIProfile,
  openRouterHeaders,
  openRouterProfile,
  UnsupportedCapabilityError,
  type CapabilityProfile,
  type CapabilityProfileOverrides,
} from "../src/models/profiles/index.js";
import { ResponsesChatModel, type ResponsesMessage } from "../src/models/responses/index.js";
import { Tool } from "../src/tools/base.js";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/responses");
const TEST_API_KEY = "test-api-key";

interface RecordedRequest {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

/** Serve recorded fixtures in order and record each request; never touches the network. */
function replay(profileName: string, fixtures: string[]) {
  const requests: RecordedRequest[] = [];
  const queue = [...fixtures];
  const fetchImpl: typeof fetch = async (input, init) => {
    const fixture = queue.shift();
    if (!fixture) throw new Error(`Unexpected request to ${String(input)}`);
    requests.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    const path = resolve(fixtureRoot, profileName, fixture);
    if (fixture.endsWith(".sse")) {
      return new Response(readFileSync(path, "utf8"), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    const recorded = JSON.parse(readFileSync(path, "utf8"));
    return new Response(JSON.stringify(recorded.body), { status: recorded.status, headers: recorded.headers });
  };
  return { fetchImpl, requests, remaining: () => queue.length };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/**
 * Required fields of the Responses input items LangFn replays, as documented by the OpenAI SDK
 * (openai/resources/responses/responses.d.ts: ResponseReasoningItem, ResponseOutputMessage,
 * ResponseFunctionToolCall). OpenRouter's stateless multi-turn history uses the same shape.
 */
function expectDocumentedReplayItem(item: Record<string, unknown>) {
  switch (item.type) {
    case "reasoning":
      expect(item).toMatchObject({ id: expect.any(String), summary: expect.any(Array) });
      break;
    case "message":
      expect(item).toMatchObject({
        id: expect.any(String),
        role: "assistant",
        status: expect.stringMatching(/^(in_progress|completed|incomplete)$/),
        content: expect.any(Array),
      });
      break;
    case "function_call":
      expect(item).toMatchObject({ call_id: expect.any(String), name: expect.any(String), arguments: expect.any(String) });
      break;
    default:
      throw new Error(`Unexpected replayed item type ${String(item.type)}`);
  }
}

const weatherTool = {
  name: "get_weather",
  description: "Current weather for a city",
  input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
};

const profiles = [
  {
    name: "openai",
    baseUrl: OPENAI_BASE_URL,
    model: "gpt-5.1",
    profile: (overrides?: CapabilityProfileOverrides) => openAIProfile(overrides),
    headers: undefined as Record<string, string> | undefined,
  },
  {
    name: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    model: "openai/gpt-5.1",
    profile: (overrides?: CapabilityProfileOverrides) => openRouterProfile(overrides),
    headers: openRouterHeaders({ referer: "https://example.test/app", title: "LangFn conformance" }),
  },
];

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("Network access is not allowed in Responses conformance tests");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(profiles)("ResponsesChatModel conformance: $name profile", (target) => {
  function model(fetchImpl: typeof fetch, profile: CapabilityProfile = target.profile()) {
    return new ResponsesChatModel({
      model: target.model,
      baseUrl: target.baseUrl,
      profile,
      apiKey: TEST_API_KEY,
      headers: target.headers,
      fetchImpl,
    });
  }

  it("maps a plain text exchange as a stateless request", async () => {
    const server = replay(target.name, ["text.json"]);
    const response = await model(server.fetchImpl).chat({
      messages: [
        { role: "system", content: "Answer briefly." },
        { role: "user", content: "What is the capital of France?" },
      ],
    });

    const [request] = server.requests;
    expect(request.url).toBe(`${target.baseUrl}/responses`);
    expect(request.headers.get("authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    expect(request.headers.get("accept")).toBe("application/json");
    if (target.name === "openrouter") {
      expect(request.headers.get("http-referer")).toBe("https://example.test/app");
      expect(request.headers.get("x-title")).toBe("LangFn conformance");
    }
    expect(request.body).toEqual({
      model: target.model,
      input: [
        { type: "message", role: "system", content: "Answer briefly." },
        { type: "message", role: "user", content: "What is the capital of France?" },
      ],
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    expect(request.body).not.toHaveProperty("previous_response_id");

    expect(response.message.content).toBe("Paris is the capital of France.");
    expect(response.message.role).toBe("assistant");
    expect(response.toolCalls).toBeUndefined();
    expect(response.finishReason).toBe("stop");
    expect(response.usage).toMatchObject({ prompt_tokens: 24, completion_tokens: 18, total_tokens: 42 });
    expect(response.responseId).toMatch(/text$/);
    expect(response.reasoning).toEqual([
      expect.objectContaining({ summary: [], content: [], encrypted: true }),
    ]);
    expect(response.message.responsesOutput?.map((item) => item.type)).toEqual(["reasoning", "message"]);
  });

  it("maps a tool call and replays reasoning and the call in the stateless continuation", async () => {
    const server = replay(target.name, ["tool-call.json", "tool-continuation.json"]);
    const chatModel = model(server.fetchImpl);
    const history: ResponsesMessage[] = [{ role: "user", content: "What is the weather in Paris?" }];

    const first = await chatModel.chat({ messages: history, tools: [weatherTool], tool_choice: "auto" });
    expect(server.requests[0].body.tools).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Current weather for a city",
        parameters: weatherTool.input_schema,
        strict: false,
      },
    ]);
    expect(server.requests[0].body.tool_choice).toBe("auto");
    expect(first.finishReason).toBe("tool_calls");
    expect(first.toolCalls).toEqual([{ id: "call_fixture_weather", name: "get_weather", arguments: { city: "Paris" } }]);
    expect(first.message.toolCalls).toEqual(first.toolCalls);
    expect(first.reasoning[0]).toMatchObject({
      summary: ["The user asks for the weather, so call get_weather."],
      encrypted: true,
    });

    const second = await chatModel.chat({
      messages: [
        ...history,
        first.message,
        { role: "tool", tool_call_id: "call_fixture_weather", content: "{\"temperature_c\":18,\"sky\":\"sunny\"}" },
      ],
      tools: [weatherTool],
    });

    const input = server.requests[1].body.input;
    expect(server.requests[1].body.store).toBe(false);
    // The provider items go back unchanged, with their ids and statuses.
    expect(input).toEqual([
      { type: "message", role: "user", content: "What is the weather in Paris?" },
      {
        id: `rs_fixture_${target.name}_tool`,
        type: "reasoning",
        summary: [{ type: "summary_text", text: "The user asks for the weather, so call get_weather." }],
        encrypted_content: `fixture-encrypted-reasoning-${target.name}_tool`,
      },
      {
        id: `fc_fixture_${target.name}_tool`,
        type: "function_call",
        status: "completed",
        call_id: "call_fixture_weather",
        name: "get_weather",
        arguments: "{\"city\":\"Paris\"}",
      },
      { type: "function_call_output", call_id: "call_fixture_weather", output: "{\"temperature_c\":18,\"sky\":\"sunny\"}" },
    ]);
    input.slice(1, 3).forEach(expectDocumentedReplayItem);
    expect(second.message.content).toBe("It is 18 C and sunny in Paris.");
    expect(second.finishReason).toBe("stop");
  });

  it("runs a LangFn tool agent loop through the stateless continuation", async () => {
    const server = replay(target.name, ["tool-call.json", "tool-continuation.json"]);
    const tool = new Tool({
      name: "get_weather",
      description: "Current weather for a city",
      schema: { parse: (data) => data as { city: string }, jsonSchema: weatherTool.input_schema },
      execute: ({ city }) => ({ city, temperature_c: 18 }),
    });
    const agent = new ToolAgent({ lang: new LangFn({ model: model(server.fetchImpl) }), tools: [tool] });

    const result = await agent.run("What is the weather in Paris?");

    expect(result.output).toBe("It is 18 C and sunny in Paris.");
    expect(server.requests[1].body.input.map((item: { type: string }) => item.type)).toEqual([
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
  });

  it("streams reasoning, text, usage, the replayable message and the end event", async () => {
    const server = replay(target.name, ["stream-reasoning.sse"]);
    const events = await collect(
      model(server.fetchImpl).streamChat({
        messages: [{ role: "user", content: "What is the capital of France?" }],
        reasoning: { effort: "low", summary: "auto" },
      }),
    );

    expect(server.requests[0].body).toMatchObject({
      stream: true,
      store: false,
      reasoning: { effort: "low", summary: "auto" },
      include: ["reasoning.encrypted_content"],
    });
    expect(server.requests[0].headers.get("accept")).toBe("text/event-stream");
    expect(events.map((event) => event.type)).toEqual([
      "reasoning",
      "reasoning",
      "content",
      "content",
      "token_usage",
      "message",
      "end",
    ]);
    expect(events.filter((event) => event.type === "reasoning").map((event) => (event as { thinking: string }).thinking).join(""))
      .toBe("Recall the capital of France.");
    expect(events.filter((event) => event.type === "content").map((event) => (event as { delta: string }).delta).join(""))
      .toBe("Paris is the capital.");
    expect(events[4]).toMatchObject({ prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 });
    const message = (events[5] as { message: ResponsesMessage }).message;
    expect(message.content).toBe("Paris is the capital.");
    expect(message.responsesOutput?.map((item) => item.type)).toEqual(["reasoning", "message"]);
    expect(events[6]).toEqual({ type: "end", finish_reason: "stop" });
  });

  it("streams a function call once, with parsed arguments", async () => {
    const server = replay(target.name, ["stream-tool-call.sse"]);
    const events = await collect(
      model(server.fetchImpl).streamChat({
        messages: [{ role: "user", content: "What is the weather in Paris?" }],
        tools: [weatherTool],
      }),
    );

    expect(events.filter((event) => event.type === "tool_call")).toEqual([
      { type: "tool_call", id: "call_fixture_weather", toolName: "get_weather", args: { city: "Paris" } },
    ]);
    expect(events.at(-1)).toEqual({ type: "end", finish_reason: "tool_calls" });
  });

  it("never executes a function call cut off by max_output_tokens and replays the rest of the turn", async () => {
    const server = replay(target.name, ["tool-call-incomplete.json", "text.json"]);
    const chatModel = model(server.fetchImpl);
    const history: ResponsesMessage[] = [{ role: "user", content: "What is the weather in Paris?" }];

    const first = await chatModel.chat({ messages: history, tools: [weatherTool] });
    expect(first.finishReason).toBe("length");
    expect(first.toolCalls).toBeUndefined();
    expect(first.message.toolCalls).toBeUndefined();
    expect(first.message.content).toBe("Checking the forecast.");
    // The cut call and the reasoning that led into it are not replayable.
    expect(first.message.responsesOutput?.map((item) => item.id)).toEqual([
      `rs_fixture_${target.name}_lead`,
      `msg_fixture_${target.name}_lead`,
    ]);

    const agent = new ToolAgent({
      lang: new LangFn({ model: model(replay(target.name, ["tool-call-incomplete.json"]).fetchImpl) }),
      tools: [
        new Tool({
          name: "get_weather",
          description: "Current weather for a city",
          schema: { parse: (data) => data as { city: string }, jsonSchema: weatherTool.input_schema },
          execute: () => {
            throw new Error("A truncated call must not run");
          },
        }),
      ],
    });
    await expect(agent.run("What is the weather in Paris?")).resolves.toMatchObject({ output: "Checking the forecast." });

    await chatModel.chat({ messages: [...history, first.message, { role: "user", content: "Go on." }] });
    const input = server.requests[1].body.input as Record<string, unknown>[];
    expect(input.map((item) => item.id ?? item.role)).toEqual([
      "user",
      `rs_fixture_${target.name}_lead`,
      `msg_fixture_${target.name}_lead`,
      "user",
    ]);
    input.slice(1, 3).forEach(expectDocumentedReplayItem);
  });

  it("streams no tool call for a function call cut off by max_output_tokens", async () => {
    const server = replay(target.name, ["stream-tool-call-incomplete.sse", "text.json"]);
    const chatModel = model(server.fetchImpl);
    const events = await collect(
      chatModel.streamChat({ messages: [{ role: "user", content: "What is the weather in Paris?" }], tools: [weatherTool] }),
    );

    expect(events.map((event) => event.type)).toEqual(["token_usage", "message", "end"]);
    expect(events.at(-1)).toEqual({ type: "end", finish_reason: "length" });
    const { message } = events[1] as { message: ResponsesMessage };
    expect(message).toMatchObject({ role: "assistant", content: "", responsesOutput: [] });
    expect(message.toolCalls).toBeUndefined();

    await chatModel.chat({ messages: [{ role: "user", content: "What is the weather in Paris?" }, message] });
    expect(server.requests[1].body.input).toEqual([
      { type: "message", role: "user", content: "What is the weather in Paris?" },
    ]);
  });

  it("maps a rate-limit response to RateLimitError with the retry delay", async () => {
    const server = replay(target.name, ["rate-limit.json"]);
    const error = await model(server.fetchImpl)
      .chat({ messages: [{ role: "user", content: "hi" }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({
      code: "PROVIDER_RATE_LIMIT",
      provider: `${target.name}-responses:${target.baseUrl}/responses`,
      retryAfter: target.name === "openai" ? 2 : 3,
      metadata: expect.objectContaining({ status: 429 }),
    });
  });

  it.each([
    ["context-length.json", ContextLengthError, "CONTEXT_LENGTH", 400],
    ["auth.json", ProviderAuthError, "PROVIDER_AUTH", 401],
    ["server-error.json", ProviderError, "PROVIDER_ERROR", target.name === "openai" ? 500 : 502],
  ] as const)("maps the %s error response to a typed error", async (fixture, ErrorType, code, status) => {
    const server = replay(target.name, [fixture]);
    const error = await model(server.fetchImpl)
      .chat({ messages: [{ role: "user", content: "hi" }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ErrorType);
    expect(error).toMatchObject({ code, provider: `${target.name}-responses:${target.baseUrl}/responses`, metadata: expect.objectContaining({ status }) });
  });

  it("surfaces a failure reported inside the stream as a typed error", async () => {
    const server = replay(target.name, ["stream-failed.sse"]);
    const seen: StreamEvent[] = [];
    const error = await (async () => {
      for await (const event of model(server.fetchImpl).streamChat({ messages: [{ role: "user", content: "hi" }] })) {
        seen.push(event);
      }
    })().catch((caught: unknown) => caught);

    expect(seen.map((event) => event.type)).toEqual(["content"]);
    if (target.name === "openai") {
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code: "PROVIDER_ERROR", metadata: expect.objectContaining({ providerCode: "server_error" }) });
    } else {
      expect(error).toBeInstanceOf(RateLimitError);
    }
  });

  it.each([
    [
      "vision",
      { vision: false },
      { messages: [{ role: "user", content: "Describe this", images: [{ url: "https://example.test/cat.png" }] }] },
    ],
    ["tools", { tools: false }, { messages: [{ role: "user", content: "hi" }], tools: [weatherTool] }],
    [
      "structuredOutput",
      { structuredOutput: false },
      {
        messages: [{ role: "user", content: "hi" }],
        responseFormat: { type: "json_schema", name: "answer", schema: { type: "object" } },
      },
    ],
    ["reasoning", { reasoning: false }, { messages: [{ role: "user", content: "hi" }], reasoning: { effort: "high" } }],
  ] as const)("rejects an unsupported %s request with a typed error before sending", async (capability, overrides, request) => {
    const server = replay(target.name, []);
    const error = await model(server.fetchImpl, target.profile(overrides))
      .chat(request as never)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnsupportedCapabilityError);
    expect(error).toMatchObject({ code: "UNSUPPORTED_CAPABILITY", capability, profileId: target.name });
    expect(server.requests).toHaveLength(0);
  });

  it("rejects streaming on a profile without streaming before sending", async () => {
    const server = replay(target.name, []);
    const error = await collect(
      model(server.fetchImpl, target.profile({ streaming: false })).stream({ prompt: "hi" }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UnsupportedCapabilityError);
    expect(error).toMatchObject({ capability: "streaming" });
    expect(server.requests).toHaveLength(0);
  });
});

describe("ResponsesChatModel conformance: OpenRouter canonical error_type", () => {
  const target = profiles[1];
  const model = (fetchImpl: typeof fetch) =>
    new ResponsesChatModel({
      model: target.model,
      baseUrl: target.baseUrl,
      profile: target.profile(),
      apiKey: TEST_API_KEY,
      headers: target.headers,
      fetchImpl,
    });

  it.each([
    ["failed-authentication.json", ProviderAuthError, "authentication"],
    ["failed-context-length.json", ContextLengthError, "context_length_exceeded"],
  ] as const)("classifies the JSON %s by its top-level error_type", async (fixture, ErrorType, errorType) => {
    const server = replay(target.name, [fixture]);
    const error = await model(server.fetchImpl)
      .chat({ messages: [{ role: "user", content: "hi" }] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ErrorType);
    expect(error).toMatchObject({ metadata: expect.objectContaining({ providerErrorType: errorType }) });
  });

  it.each([
    ["stream-failed-authentication.sse", ProviderAuthError, "authentication"],
    ["stream-failed-context-length.sse", ContextLengthError, "context_length_exceeded"],
  ] as const)("classifies the response.failed event in %s by its top-level error_type", async (fixture, ErrorType, errorType) => {
    const server = replay(target.name, [fixture]);
    const seen: StreamEvent[] = [];
    const error = await (async () => {
      for await (const event of model(server.fetchImpl).streamChat({ messages: [{ role: "user", content: "hi" }] })) {
        seen.push(event);
      }
    })().catch((caught: unknown) => caught);

    expect(seen).toEqual([]);
    expect(error).toBeInstanceOf(ErrorType);
    expect(error).toMatchObject({ metadata: expect.objectContaining({ providerErrorType: errorType }) });
  });

  it("keeps an authoritative HTTP 429 and 401 ahead of the error_type", async () => {
    const failed = (status: number, errorType: string) => async () =>
      new Response(
        JSON.stringify({ status: "failed", error: { code: "server_error", message: "upstream" }, error_type: errorType }),
        { status, headers: { "content-type": "application/json" } },
      );
    const rateLimited = await model(failed(429, "authentication"))
      .chat({ messages: [{ role: "user", content: "hi" }] })
      .catch((caught: unknown) => caught);
    const unauthorized = await model(failed(401, "rate_limit_exceeded"))
      .chat({ messages: [{ role: "user", content: "hi" }] })
      .catch((caught: unknown) => caught);

    expect(rateLimited).toBeInstanceOf(RateLimitError);
    expect(unauthorized).toBeInstanceOf(ProviderAuthError);
  });
});
