import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContextLengthError,
  NotConfiguredError,
  ProviderError,
  RateLimitError,
  ValidationError,
} from "../src/core/errors.js";
import type { StreamEvent } from "../src/core/types.js";
import {
  defineCapabilityProfile,
  openAIProfile,
  UnsupportedCapabilityError,
  type CapabilityProfile,
} from "../src/models/profiles/index.js";
import {
  buildResponsesPayload,
  mapResponsesStream,
  parseResponsesResponse,
  readServerSentEvents,
  ResponsesChatModel,
  type ResponsesMessage,
} from "../src/models/responses/index.js";

const customProfile = defineCapabilityProfile({
  id: "custom-gateway",
  tools: true,
  streaming: true,
  structuredOutput: false,
  vision: false,
  reasoning: false,
  contextWindow: 1_000,
  maxOutputTokens: 200,
});

function body(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

function payload(messages: ResponsesMessage[], profile: CapabilityProfile = openAIProfile(), extra = {}) {
  return buildResponsesPayload({ messages, ...extra }, { model: "fixture-model", profile, stream: false });
}

const completed = (output: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "resp_fixture_mapping",
  status: "completed",
  output,
  ...extra,
});

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("Network access is not allowed in Responses mapping tests");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("server-sent event parsing", () => {
  it("joins multi-line data, honours CRLF, skips comments and flushes an unterminated final event", async () => {
    const events = await collect(
      readServerSentEvents(body(": keep-alive\r\nevent: first\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\ndata:2\n\ndata: tail")),
    );
    expect(events).toEqual([
      { event: "first", data: "{\"a\":\n1}" },
      { data: "2" },
      { data: "tail" },
    ]);
  });

  it("uses the SSE event name when the JSON payload has no type", async () => {
    const response = completed([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }]);
    const frames = [{ event: "response.completed", data: JSON.stringify({ response }) }];
    const events = await collect(mapResponsesStream((async function* () { yield* frames; })(), "fixture"));
    expect(events.at(-1)).toEqual({ type: "end", finish_reason: "stop" });
  });
});

describe("stream mapping", () => {
  async function stream(frames: unknown[]): Promise<StreamEvent[]> {
    const text = frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join("");
    return await collect(mapResponsesStream(readServerSentEvents(body(text)), "fixture"));
  }

  it("rejects a stream that ends before a terminal response event", async () => {
    await expect(stream([{ type: "response.output_text.delta", delta: "partial" }])).rejects.toBeInstanceOf(ProviderError);
    await expect(stream([{ type: "response.output_text.delta", delta: "partial" }, "[DONE]"])).rejects.toThrow(
      "ended before a terminal response event",
    );
  });

  it("rebuilds the terminal output from completed items when the server omits it", async () => {
    const item = { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] };
    const events = await stream([
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: completed([]) },
    ]);
    const message = events.find((event) => event.type === "message") as { message: ResponsesMessage };
    expect(message.message.content).toBe("hello");
    expect(message.message.responsesOutput).toEqual([item]);
  });

  it("maps raw reasoning text deltas and an OpenAI-shaped error event", async () => {
    const events: StreamEvent[] = [];
    const error = await (async () => {
      for await (const event of mapResponsesStream(
        readServerSentEvents(
          body(
            `data: ${JSON.stringify({ type: "response.reasoning_text.delta", delta: "thinking" })}\n\n` +
              `data: ${JSON.stringify({ type: "error", code: "rate_limit_exceeded", message: "slow down" })}\n\n`,
          ),
        ),
        "fixture",
      )) events.push(event);
    })().catch((caught: unknown) => caught);
    expect(events).toEqual([{ type: "reasoning", step: "content", thinking: "thinking" }]);
    expect(error).toBeInstanceOf(RateLimitError);
  });

  it("rejects malformed JSON and malformed function call arguments", async () => {
    await expect(stream(["{not json"])).rejects.toBeInstanceOf(ProviderError);
    await expect(
      stream([
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call", call_id: "call_fixture", name: "lookup", arguments: "{\"city\":" },
        },
      ]),
    ).rejects.toThrow("not valid JSON");
  });
});

describe("response mapping", () => {
  it("maps incomplete, refusal and failed responses", () => {
    expect(
      parseResponsesResponse(
        { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
        "fixture",
      ).finishReason,
    ).toBe("length");

    const refusal = parseResponsesResponse(
      completed([{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "I can't help with that." }] }]),
      "fixture",
    );
    expect(refusal.finishReason).toBe("refusal");
    expect(refusal.message).toMatchObject({ content: "", refusal: "I can't help with that." });

    expect(() =>
      parseResponsesResponse(
        { status: "failed", output: [], error: { code: "context_length_exceeded", message: "too long" } },
        "fixture",
      ),
    ).toThrow(ContextLengthError);
    expect(() => parseResponsesResponse({ status: "in_progress", output: [] }, "fixture")).toThrow(ProviderError);
  });

  it("rejects malformed output items and invalid usage", () => {
    expect(() => parseResponsesResponse(completed([{ type: "message", content: "flat" }]), "fixture")).toThrow(ProviderError);
    expect(() =>
      parseResponsesResponse(
        completed([{ type: "function_call", call_id: "call_fixture", name: "lookup", arguments: "[1]" }]),
        "fixture",
      ),
    ).toThrow("must be a JSON object");
    expect(() =>
      parseResponsesResponse(completed([], { usage: { input_tokens: -1, output_tokens: 2 } }), "fixture"),
    ).toThrow("invalid token usage");
  });
});

describe("request mapping", () => {
  const replayed = {
    role: "assistant",
    content: "Checking.",
    toolCalls: [{ id: "call_fixture", name: "lookup", arguments: { q: "x" } }],
    responsesOutput: [
      { id: "rs_fixture_plain", type: "reasoning", summary: [] },
      { id: "rs_fixture_sealed", type: "reasoning", summary: [], encrypted_content: "fixture-encrypted-reasoning" },
      { id: "msg_fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Checking.", annotations: [] }] },
      { id: "fc_fixture", type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{\"q\":\"x\"}" },
    ],
  } satisfies ResponsesMessage;

  it("replays provider items without ids or statuses and drops unreplayable reasoning", () => {
    const input = payload([{ role: "user", content: "go" }, replayed]).input as Record<string, unknown>[];
    expect(input.slice(1)).toEqual([
      { type: "reasoning", summary: [], encrypted_content: "fixture-encrypted-reasoning" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking.", annotations: [] }] },
      { type: "function_call", call_id: "call_fixture", name: "lookup", arguments: "{\"q\":\"x\"}" },
    ]);
  });

  it("rejects an assistant message edited away from its provider items", () => {
    expect(() => payload([{ ...replayed, content: "Edited." }])).toThrow(ValidationError);
    expect(() =>
      payload([{ ...replayed, toolCalls: [{ id: "call_fixture", name: "lookup", arguments: { q: "y" } }] }]),
    ).toThrow("do not match its responsesOutput");
  });

  it("rejects encrypted reasoning history on a profile without reasoning", () => {
    expect(() => payload([replayed], openAIProfile({ reasoning: false }))).toThrow(UnsupportedCapabilityError);
  });

  it("maps tool history without provider items, images, structured output and tool choice", () => {
    const result = payload(
      [
        { role: "user", content: "Look", images: [{ url: "data:image/png;base64,AAAA", detail: "low" }] },
        { role: "assistant", content: "", tool_calls: [{ id: "call_fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_fixture", content: "found" },
      ],
      openAIProfile({ reasoning: false }),
      {
        tools: [{ name: "lookup" }],
        tool_choice: { type: "function", function: { name: "lookup" } },
        responseFormat: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true },
        maxOutputTokens: 64,
      },
    );
    expect(result).toEqual({
      model: "fixture-model",
      store: false,
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Look" },
            { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "low" },
          ],
        },
        { type: "function_call", call_id: "call_fixture", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_fixture", output: "found" },
      ],
      tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} }, strict: false }],
      tool_choice: { type: "function", name: "lookup" },
      text: { format: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: true } },
      max_output_tokens: 64,
    });
    expect(payload([{ role: "user", content: "x" }], openAIProfile(), { tool_choice: "lookup" }).tool_choice).toEqual({
      type: "function",
      name: "lookup",
    });
  });

  it("rejects tool history on a profile without tools and malformed messages", () => {
    expect(() => payload([{ role: "tool", tool_call_id: "call_fixture", content: "x" }], openAIProfile({ tools: false })))
      .toThrow(UnsupportedCapabilityError);
    expect(() => payload([{ role: "tool", content: "x" }])).toThrow(ValidationError);
    expect(() => payload([])).toThrow(ValidationError);
    expect(() => payload([{ role: "assistant", content: "x", images: [{ url: "https://example.test/a.png" }] }])).toThrow(ValidationError);
    expect(() => payload([{ role: "user", content: "x", images: [{ url: "file:///etc/passwd" }] }])).toThrow(ValidationError);
  });

  it("enforces the profile output limit and context window", () => {
    expect(() => payload([{ role: "user", content: "x" }], customProfile, { maxOutputTokens: 201 })).toThrow(ValidationError);
    expect(() =>
      payload([{ role: "user", content: "x" }], defineCapabilityProfile({ ...customProfile, maxOutputTokens: undefined }), {
        maxOutputTokens: 1_001,
      }),
    ).toThrow(ContextLengthError);
  });
});

describe("ResponsesChatModel configuration", () => {
  function okFetch(seen: Headers[]): typeof fetch {
    return async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response(
        JSON.stringify(completed([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }])),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
  }

  it("talks to a custom endpoint authenticated by headers on its own path", async () => {
    const seen: Headers[] = [];
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      urls.push(String(input));
      return await okFetch(seen)(input, init);
    };
    const model = new ResponsesChatModel({
      model: "local-model",
      baseUrl: "https://gateway.example.test/v2/",
      path: "/openai/responses",
      profile: customProfile,
      headers: { "x-gateway-key": "test-gateway-key" },
      fetchImpl,
    });

    await expect(model.complete({ prompt: "hi" })).resolves.toMatchObject({ content: "ok" });
    expect(urls).toEqual(["https://gateway.example.test/v2/openai/responses"]);
    expect(seen[0].get("x-gateway-key")).toBe("test-gateway-key");
    expect(seen[0].has("authorization")).toBe(false);
    expect(model.provider).toBe("custom-gateway");
  });

  it("applies the token estimator against the context window before sending", async () => {
    const seen: Headers[] = [];
    const model = new ResponsesChatModel({
      model: "local-model",
      baseUrl: "https://gateway.example.test",
      profile: customProfile,
      maxOutputTokens: 100,
      estimateInputTokens: (input) => JSON.stringify(input).length,
      fetchImpl: okFetch(seen),
    });

    await expect(model.chat({ messages: [{ role: "user", content: "x".repeat(950) }] })).rejects.toBeInstanceOf(ContextLengthError);
    expect(seen).toHaveLength(0);
    await expect(model.chat({ messages: [{ role: "user", content: "short" }] })).resolves.toMatchObject({ finishReason: "stop" });
  });

  it("rejects unsafe or ambiguous configuration", () => {
    const base = { model: "m", baseUrl: "https://gateway.example.test", profile: customProfile };
    expect(() => new ResponsesChatModel({ ...base, apiKey: "test-api-key", headers: { Authorization: "Bearer test-other" } }))
      .toThrow(ValidationError);
    expect(() => new ResponsesChatModel({ ...base, baseUrl: `https://${["test-user", "test-password"].join(":")}@gateway.example.test` })).toThrow(ValidationError);
    expect(() => new ResponsesChatModel({ ...base, baseUrl: "ftp://gateway.example.test" })).toThrow(ValidationError);
    expect(() => new ResponsesChatModel({ ...base, headers: { "x-test": "a\r\nb" } })).toThrow(ValidationError);
    expect(() => new ResponsesChatModel({ ...base, reasoning: { effort: "low" } })).toThrow(UnsupportedCapabilityError);
    expect(() => defineCapabilityProfile({ ...customProfile, vision: "yes" as never })).toThrow(ValidationError);
    expect(() => defineCapabilityProfile({ ...customProfile, contextWindow: 10, maxOutputTokens: 20 })).toThrow(ValidationError);
  });

  it("fails with NotConfiguredError when a configured key reference does not resolve", async () => {
    const model = new ResponsesChatModel({
      model: "m",
      baseUrl: "https://gateway.example.test",
      profile: customProfile,
      apiKeyRef: "MISSING_FIXTURE_KEY",
      secretProvider: () => undefined,
      fetchImpl: okFetch([]),
    });
    await expect(model.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(NotConfiguredError);
  });
});
