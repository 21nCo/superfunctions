import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContextLengthError,
  LangFnError,
  NotConfiguredError,
  ProviderError,
  RateLimitError,
  TimeoutError,
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
  vi.restoreAllMocks();
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

  it("frames events separated by bare CR line endings", async () => {
    const events = await collect(readServerSentEvents(body("event: a\rdata: one\rdata: two\r\rdata: three\r\r")));
    expect(events).toEqual([{ event: "a", data: "one\ntwo" }, { data: "three" }]);
  });

  /** A body that delivers `chunks` and stays open. */
  function open(chunks: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
  }

  it("delivers a bare-CR event while the stream is still open", async () => {
    const iterator = readServerSentEvents(open(["data: fir", "st\r\r"]))[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: { data: "first" } });
    await iterator.return?.();
  });

  it("treats a CRLF split across chunks as one line end, not an empty line", async () => {
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of ["data: a\r", "\ndata: b\r", "\n\r", "\n"]) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    expect(await collect(readServerSentEvents(chunked))).toEqual([{ data: "a\nb" }]);
  });

  it("applies the line limit to each CR-separated line, not to the whole event", async () => {
    const line = `data: ${"x".repeat(20)}\r`;
    const events = await collect(readServerSentEvents(body(`${line.repeat(4)}\r`), 40));
    expect(events).toEqual([{ data: Array(4).fill("x".repeat(20)).join("\n") }]);
    await expect(collect(readServerSentEvents(body(`data: ${"x".repeat(50)}\r\r`), 40))).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
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

  it("rejects a malformed terminal output before any tool call, as the JSON path does", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    for (const output of ["not-an-array", { 0: call }, 7]) {
      const terminal = { ...completed([]), output };
      expect(() => parseResponsesResponse(terminal, "fixture")).toThrow(ProviderError);
      const seen: StreamEvent[] = [];
      const text = [
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.completed", response: terminal },
      ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
      await expect((async () => {
        for await (const event of mapResponsesStream(readServerSentEvents(body(text)), "fixture")) seen.push(event);
      })()).rejects.toThrow("Responses output must be an array");
      expect(seen).toEqual([]);
    }
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

  it("rejects malformed JSON and malformed arguments on a completed function call", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{\"city\":" };
    await expect(stream(["{not json"])).rejects.toBeInstanceOf(ProviderError);
    await expect(
      stream([
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.completed", response: completed([call]) },
      ]),
    ).rejects.toThrow("not valid JSON");
  });

  it("emits tool calls only from the terminal event, and none from a response.incomplete event", async () => {
    const call = { type: "function_call", call_id: "call_fixture", name: "lookup", arguments: "{\"city\":\"Paris\"}" };
    const done = { type: "response.output_item.done", output_index: 0, item: call };

    const finished = await stream([done, { type: "response.completed", response: completed([]) }]);
    expect(finished.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);

    // A server that leaves the status out of an incomplete terminal response.
    const cut = await stream([done, { type: "response.incomplete", response: { output: [] } }]);
    expect(cut.map((event) => event.type)).toEqual(["message", "end"]);
    expect(cut.at(-1)).toEqual({ type: "end", finish_reason: "incomplete" });
  });

  it("returns a replayable message for an incomplete stream with no output", async () => {
    const events = await stream([
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } },
    ]);
    const { message } = events.find((event) => event.type === "message") as { message: ResponsesMessage };
    expect(events.at(-1)).toEqual({ type: "end", finish_reason: "length" });
    expect(payload([{ role: "user", content: "go" }, message]).input).toEqual([{ type: "message", role: "user", content: "go" }]);
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

  it("returns a replayable message for an incomplete response with no output", () => {
    const response = parseResponsesResponse(
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] },
      "fixture",
    );
    expect(response.message).toEqual({ role: "assistant", content: "", responsesOutput: [] });
    expect(payload([{ role: "user", content: "go" }, response.message, { role: "user", content: "again" }]).input).toEqual([
      { type: "message", role: "user", content: "go" },
      { type: "message", role: "user", content: "again" },
    ]);
  });

  it("keeps truncated function call arguments as an incomplete outcome instead of a parse error", () => {
    const cut = { type: "function_call", status: "incomplete", call_id: "call_fixture", name: "lookup", arguments: "{\"city\":" };
    const reasoning = { id: "rs_fixture_cut", type: "reasoning", summary: [], encrypted_content: "fixture-encrypted-reasoning" };
    const incomplete = parseResponsesResponse(
      { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [reasoning, cut] },
      "fixture",
    );
    expect(incomplete).toMatchObject({ finishReason: "length", message: { content: "", responsesOutput: [] } });
    expect(incomplete.toolCalls).toBeUndefined();

    // An unfinished call inside an otherwise completed response is not executable either.
    const unfinished = parseResponsesResponse(completed([{ ...cut, status: "in_progress" }]), "fixture");
    expect(unfinished).toMatchObject({ finishReason: "stop", message: { responsesOutput: [] } });
    expect(unfinished.toolCalls).toBeUndefined();

    // An incomplete response cut off while reasoning leaves the trailing reasoning out.
    const message = { id: "msg_fixture", type: "message", status: "incomplete", role: "assistant", content: [{ type: "output_text", text: "Part" }] };
    expect(
      parseResponsesResponse({ status: "incomplete", output: [message, reasoning] }, "fixture").message.responsesOutput,
    ).toEqual([message]);
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

  it("replays provider items unchanged, with ids and statuses, and drops unreplayable reasoning", () => {
    const input = payload([{ role: "user", content: "go" }, replayed]).input as Record<string, unknown>[];
    expect(input.slice(1)).toEqual(replayed.responsesOutput.slice(1));
    expect(input[1]).not.toBe(replayed.responsesOutput[1]);
  });

  it("replays a provider message without a role as an assistant message", () => {
    const item = { id: "msg_fixture", type: "message", status: "completed", content: [{ type: "output_text", text: "Hi." }] };
    const input = payload([{ role: "user", content: "go" }, { role: "assistant", content: "Hi.", responsesOutput: [item] }])
      .input as Record<string, unknown>[];
    expect(input[1]).toEqual({ ...item, role: "assistant" });
  });

  it("rejects item_reference history, which needs server-side state", () => {
    const message = {
      role: "assistant",
      content: "",
      responsesOutput: [{ type: "item_reference", id: "msg_fixture" }],
    } as unknown as ResponsesMessage;
    expect(() => payload([{ role: "user", content: "go" }, message])).toThrow(ValidationError);
    expect(() => payload([{ role: "user", content: "go" }, message])).toThrow("item_reference");
  });

  it("rejects a default reasoning configuration on a profile without reasoning", () => {
    expect(() =>
      buildResponsesPayload(
        { messages: [{ role: "user", content: "go" }] },
        { model: "fixture-model", profile: openAIProfile({ reasoning: false }), stream: false, reasoning: { effort: "low" } },
      ),
    ).toThrow(UnsupportedCapabilityError);
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
    for (const baseUrl of ["https://gateway.example.test/v1?", "https://gateway.example.test/v1#", "https://gateway.example.test/v1?a=1"]) {
      expect(() => new ResponsesChatModel({ ...base, baseUrl })).toThrow("must not have a query or fragment");
    }
    expect(() => new ResponsesChatModel({ ...base, headers: { "x-test": "a\r\nb" } })).toThrow(ValidationError);
    expect(() => new ResponsesChatModel({ ...base, reasoning: { effort: "low" } })).toThrow(UnsupportedCapabilityError);
    expect(() => defineCapabilityProfile({ ...customProfile, vision: "yes" as never })).toThrow(ValidationError);
    expect(() => defineCapabilityProfile({ ...customProfile, contextWindow: 10, maxOutputTokens: 20 })).toThrow(ValidationError);
  });

  function gateway(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof ResponsesChatModel>[0]> = {}) {
    return new ResponsesChatModel({
      model: "local-model",
      baseUrl: "https://gateway.example.test",
      profile: customProfile,
      headers: { "x-gateway-key": "test-gateway-key" },
      fetchImpl,
      ...extra,
    });
  }

  /** A body that sends `first` and then never finishes. */
  function stalled(first = ""): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (first) controller.enqueue(new TextEncoder().encode(first));
      },
    });
  }

  it("never follows a redirect, so headers and history stay on the configured origin", async () => {
    const inits: RequestInit[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      inits.push(init ?? {});
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.example.test/responses" } });
    };
    const model = gateway(fetchImpl);

    const chatError = await model.chat({ messages: [{ role: "user", content: "secret history" }] }).catch((caught: unknown) => caught);
    expect(chatError).toBeInstanceOf(ProviderError);
    expect(chatError).toMatchObject({ metadata: expect.objectContaining({ status: 307, redirect: true }) });
    await expect(collect(model.streamChat({ messages: [{ role: "user", content: "x" }] }))).rejects.toThrow("redirect");
    expect(inits.map((init) => init.redirect)).toEqual(["manual", "manual"]);

    // Runtimes that hide manual redirects return an opaque redirect response.
    const opaque = new Response(null, { status: 200 });
    Object.defineProperty(opaque, "type", { value: "opaqueredirect" });
    await expect(gateway(async () => opaque).chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow("redirect");
  });

  it("keeps the transport timeout and size errors of a response body", async () => {
    const message = completed([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(200) }] }]);
    for (const status of [200, 500]) {
      const slow = gateway(async () => new Response(stalled("{"), { status }), { timeout: 30 });
      const timeout = await slow.chat({ messages: [{ role: "user", content: "x" }] }).catch((caught: unknown) => caught);
      expect(timeout).toBeInstanceOf(TimeoutError);
      expect(timeout).toMatchObject({ code: "PROVIDER_TIMEOUT" });

      const large = gateway(async () => new Response(JSON.stringify(message), { status }), { maxResponseBytes: 64 });
      const tooLarge = await large.chat({ messages: [{ role: "user", content: "x" }] }).catch((caught: unknown) => caught);
      expect(tooLarge).toBeInstanceOf(LangFnError);
      expect(tooLarge).toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    }
    await expect(gateway(async () => new Response("<html>", { status: 200 })).chat({ messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow("not valid JSON");
  });

  it("surfaces a timeout or an abort in the middle of a stream", async () => {
    const delta = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`;
    const seen: StreamEvent[] = [];
    const timeout = await (async () => {
      const model = gateway(async () => new Response(stalled(delta), { status: 200 }), { timeout: 30 });
      for await (const event of model.streamChat({ messages: [{ role: "user", content: "x" }] })) seen.push(event);
    })().catch((caught: unknown) => caught);
    expect(seen).toEqual([{ type: "content", content: "partial", delta: "partial" }]);
    expect(timeout).toBeInstanceOf(TimeoutError);

    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const aborted = await (async () => {
      const model = gateway(async () => new Response(stalled(delta), { status: 200 }), { timeout: 0 });
      for await (const event of model.streamChat({ messages: [{ role: "user", content: "x" }], signal: controller.signal })) {
        if (event.type === "content") controller.abort(reason);
      }
    })().catch((caught: unknown) => caught);
    expect(aborted).toBe(reason);
  });

  it("reads a terminal event longer than 1 MiB by default and honours maxStreamLineBytes", async () => {
    const text = "x".repeat(1_100_000);
    const terminal = {
      type: "response.completed",
      response: completed([{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }]),
    };
    const sse = () => new Response(`data: ${JSON.stringify(terminal)}\n\n`, { status: 200 });
    const events = await collect(gateway(async () => sse()).streamChat({ messages: [{ role: "user", content: "x" }] }));
    expect(events.at(-1)).toEqual({ type: "end", finish_reason: "stop" });

    const limited = gateway(async () => sse(), { maxStreamLineBytes: 1_024 });
    await expect(collect(limited.streamChat({ messages: [{ role: "user", content: "x" }] }))).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    expect(() => gateway(async () => sse(), { maxStreamLineBytes: 0 })).toThrow(ValidationError);
  });

  it("reads Retry-After from retry-after-ms and from an HTTP date", async () => {
    const limited = (headers: Record<string, string>) =>
      gateway(async () => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429, headers }))
        .chat({ messages: [{ role: "user", content: "x" }] })
        .catch((caught: unknown) => caught);

    expect(await limited({ "retry-after-ms": "1500", "retry-after": "9" })).toMatchObject({ retryAfter: 1.5 });
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-21T00:00:00Z"));
    const dated = await limited({ "retry-after": "Sat, 21 Nov 2026 00:00:30 GMT" });
    expect(dated).toBeInstanceOf(RateLimitError);
    expect(dated).toMatchObject({ retryAfter: 30 });
    expect(await limited({ "retry-after": "Fri, 20 Nov 2026 23:59:00 GMT" })).toMatchObject({ retryAfter: 0 });
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
