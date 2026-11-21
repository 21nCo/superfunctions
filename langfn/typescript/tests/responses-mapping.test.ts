import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContextLengthError,
  LangFnError,
  NotConfiguredError,
  ProviderAuthError,
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
import { LangFn } from "../src/client.js";
import type { CompletionResponse } from "../src/core/types.js";
import { OpenAIChatModel } from "../src/models/openai.js";
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
  it("joins multi-line data, honours CRLF, skips comments and discards an unterminated final event", async () => {
    const events = await collect(
      readServerSentEvents(body(": keep-alive\r\nevent: first\r\ndata: {\"a\":\r\ndata: 1}\r\n\r\ndata:2\n\ndata: tail")),
    );
    expect(events).toEqual([
      { event: "first", data: "{\"a\":\n1}" },
      { data: "2" },
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
    // The rebuilt item is normalized like any other output: known required fields are filled.
    expect(message.message.responsesOutput).toEqual([
      { ...item, status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] },
    ]);
  });

  it("rejects a malformed terminal output before any tool call, as the JSON path does", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    // null is malformed too: only an absent or empty output falls back to the finished items.
    for (const output of ["not-an-array", { 0: call }, 7, null]) {
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

  /** Map raw SSE text, recording every event emitted before the outcome. */
  async function mapRaw(text: string): Promise<{ seen: StreamEvent[]; error?: unknown }> {
    const seen: StreamEvent[] = [];
    try {
      for await (const event of mapResponsesStream(readServerSentEvents(body(text)), "fixture")) seen.push(event);
      return { seen };
    } catch (error) {
      return { seen, error };
    }
  }

  const frame = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;

  it("exposes a terminal outcome only when it is unambiguous and matches the JSON path", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const done = (index?: number, item: unknown = call) => ({ type: "response.output_item.done", ...(index === undefined ? {} : { output_index: index }), item });

    // An SSE event name that names a different terminal event than the JSON type.
    for (const [event, type] of [["response.incomplete", "response.completed"], ["response.completed", "response.incomplete"], ["response.completed", "response.failed"]]) {
      const outcome = await mapRaw(frame(done(0)) + frame({ type, response: completed([call]) }, event));
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(`event ${event} conflicts with its type ${type}`);
      expect(outcome.seen).toEqual([]);
    }
    // Agreeing names, or a discriminator in only one place, still work.
    for (const text of [
      frame({ type: "response.completed", response: completed([call]) }, "response.completed"),
      frame({ response: completed([call]) }, "response.completed"),
      frame({ type: "response.completed", response: completed([call]) }),
    ]) {
      expect((await mapRaw(text)).seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
    }

    // A populated error object is never a success, whatever the status says.
    for (const status of ["completed", "incomplete"]) {
      const terminal = completed([call], { status, error: { code: "server_error", message: "upstream failed" } });
      expect(() => parseResponsesResponse(terminal, "fixture")).toThrow("upstream failed");
      const outcome = await mapRaw(frame({ type: `response.${status}`, response: terminal }));
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain("upstream failed");
      expect(outcome.seen).toEqual([]);
    }
    expect(parseResponsesResponse(completed([call], { error: null }), "fixture").toolCalls).toHaveLength(1);

    // Two finished items on one output index would silently drop one of them.
    const other = { ...call, call_id: "call_fixture_other" };
    for (const frames of [[done(0), done(0, other)], [done(1), done(undefined, other)]]) {
      const outcome = await mapRaw(frames.map((item) => frame(item)).join("") + frame({ type: "response.completed", response: completed([]) }));
      expect(String(outcome.error)).toContain("repeats output_index");
      expect(outcome.seen).toEqual([]);
    }
    expect(String((await mapRaw(frame(done(-1)))).error)).toContain("non-negative integer");

    // A terminal event without its blank-line terminator is discarded at EOF.
    const unframed = await mapRaw(frame(done(0)) + `data: ${JSON.stringify({ type: "response.completed", response: completed([call]) })}`);
    expect(String(unframed.error)).toContain("ended before a terminal response event");
    expect(unframed.seen).toEqual([]);
  });

  it("rejects a terminal output that disagrees with what the stream already finished", async () => {
    const call = { id: "fc_fixture", type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{\"q\":1}" };
    const done = (item: unknown = call, index = 0) => frame({ type: "response.output_item.done", output_index: index, item });
    const argsDone = (args: string) => frame({ type: "response.function_call_arguments.done", item_id: "fc_fixture", output_index: 0, arguments: args });
    const created = (id: string) => frame({ type: "response.created", response: { id, status: "in_progress", output: [] } });
    const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] };
    const terminal = (output: unknown[]) => frame({ type: "response.completed", response: completed(output) });

    const rejected: Array<[string, string]> = [
      // The finished call vanished: the turn would end with stop and the call would be lost.
      [done() + terminal([message]), "does not have the finished function_call item call_fixture at output_index 0"],
      // The call changed its call_id, name or arguments.
      [done() + terminal([{ ...call, call_id: "call_fixture_other" }]), "changed the finished function_call call_fixture"],
      [done() + terminal([{ ...call, name: "delete_everything" }]), "changed the finished function_call call_fixture"],
      [done() + terminal([{ ...call, arguments: "{\"q\":2}" }]), "changed the finished function_call call_fixture"],
      // Final arguments that differ from the item's, with an explicit or an omitted terminal output.
      [argsDone("{\"q\":2}") + done() + terminal([call]), "arguments differ from item fc_fixture"],
      [argsDone("{\"q\":2}") + done() + terminal([]), "arguments differ from item fc_fixture"],
      [argsDone("{\"q\":2}") + terminal([call]), "arguments differ from item fc_fixture"],
      // Final arguments for an item that is not a call, or for no item at all.
      [argsDone("{}") + terminal([message]), "unknown item fc_fixture"],
      [argsDone("{}") + terminal([]), "unknown item fc_fixture"],
      // A terminal response for another response id.
      [created("resp_fixture_other") + terminal([call]), "is for response resp_fixture_mapping, not resp_fixture_other"],
      // A finished call that is malformed or unfinished in a completed stream.
      [done({ ...call, arguments: "" }) + terminal([call]), "not empty"],
      [done({ ...call, status: "in_progress" }) + terminal([call]), "finished an unfinished function_call"],
    ];
    for (const [text, error] of rejected) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(error);
      expect(outcome.seen).toEqual([]);
    }

    // A matching snapshot and the omitted or empty fallback still work.
    for (const text of [
      created("resp_fixture_mapping") + argsDone(call.arguments) + done() + terminal([call]),
      argsDone(call.arguments) + done() + terminal([]),
      argsDone(call.arguments) + done() + frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed" } }),
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      expect(outcome.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
    }
  });

  it("checks every finished item and every arguments locator against the terminal output", async () => {
    const call = { id: "fc_fixture", type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{\"q\":1}" };
    const note = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] };
    const done = (item: unknown, index?: number) => frame({ type: "response.output_item.done", ...(index === undefined ? {} : { output_index: index }), item });
    const argsDone = (locator: Record<string, unknown>, args = call.arguments) => frame({ type: "response.function_call_arguments.done", ...locator, arguments: args });
    const terminal = (output: unknown[], extra: Record<string, unknown> = {}) => frame({ type: "response.completed", response: completed(output, extra) });

    const rejected: Array<[string, string]> = [
      // A finished item of any type is replaced at its index, by another type or another id.
      [done(note, 0) + terminal([call]), "does not have the finished message item msg_fixture at output_index 0"],
      [done({ ...call, id: "fc_fixture_first" }, 0) + terminal([call]), "replaced the finished item fc_fixture_first at output_index 0"],
      [done({ ...note, id: "msg_fixture_first" }, 0) + done(call, 1) + terminal([note, call]), "replaced the finished item msg_fixture_first"],
      // A finished item whose index the terminal output does not reach.
      [done(note, 0) + done(call, 1) + terminal([note]), "does not have the finished function_call item call_fixture at output_index 1"],
      // An item_id that matches nothing does not fall back to the output_index.
      [done(call, 0) + argsDone({ item_id: "fc_fixture_missing", output_index: 0 }) + terminal([call]), "unknown item fc_fixture_missing"],
      // An output_index that is malformed or names nothing, and locators naming different items.
      [done(call, 0) + argsDone({ item_id: "fc_fixture", output_index: -1 }) + terminal([call]), "output_index must be a non-negative integer"],
      [done(call, 0) + argsDone({ item_id: "fc_fixture", output_index: "0" }) + terminal([call]), "output_index must be a non-negative integer"],
      [done(call, 0) + argsDone({ output_index: 5 }) + terminal([call]), "unknown output_index 5"],
      [done(call, 0) + argsDone({ item_id: 7 }) + terminal([call]), "item_id must be a string"],
      [done(note, 0) + done(call, 1) + argsDone({ item_id: "fc_fixture", output_index: 0 }) + terminal([note, call]), "item fc_fixture is not at output_index 0"],
      [done(call, 0) + argsDone({}) + terminal([call]), "names no item"],
      // Any populated error beside a success status is a failure, including a bare string.
      [done(call, 0) + terminal([call], { error: "upstream failed" }), "Responses request failed: upstream failed"],
      [done(call, 0) + terminal([call], { error: ["upstream failed"] }), "Responses request failed"],
    ];
    for (const [text, error] of rejected) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(error);
      expect(outcome.seen).toEqual([]);
    }
    // An error object keeps its typed error on the stream as well.
    const limited = await mapRaw(done(call, 0) + terminal([call], { error: { code: "rate_limit_exceeded", message: "slow down" } }));
    expect(limited.error).toBeInstanceOf(RateLimitError);
    expect(limited.seen).toEqual([]);

    // The JSON path applies the same error rule.
    expect(() => parseResponsesResponse(completed([call], { error: "upstream failed" }), "fixture")).toThrow("upstream failed");
    expect(() => parseResponsesResponse(completed([call], { error: 0 }), "fixture")).toThrow(ProviderError);
    for (const error of [null, {}]) {
      expect(parseResponsesResponse(completed([call], { error }), "fixture").toolCalls).toHaveLength(1);
    }

    // Matching snapshots, unindexed items and the omitted or empty fallback still work.
    for (const text of [
      done(note, 0) + done(call, 1) + argsDone({ item_id: "fc_fixture", output_index: 1 }) + terminal([note, call], { error: null }),
      done({ ...note, id: undefined }, 0) + done(call, 1) + terminal([note, call], { error: {} }),
      done(note) + done(call) + argsDone({ item_id: "fc_fixture" }) + terminal([call, note]),
      done(note, 0) + done(call, 1) + argsDone({ output_index: 1 }) + terminal([]),
      done(note, 0) + done(call, 1) + frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed" } }),
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      expect(outcome.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
    }
  });

  it("rejects empty or whitespace arguments on an executable call on the JSON and SSE paths", async () => {
    for (const args of ["", "  \n"]) {
      for (const status of [{ status: "completed" }, {}, { status: null }]) {
        const call = { type: "function_call", ...status, call_id: "call_fixture", name: "lookup", arguments: args };
        expect(() => parseResponsesResponse(completed([call]), "fixture")).toThrow("not empty");
        // With the terminal output present, and omitted so it is rebuilt from the finished items.
        for (const response of [completed([call]), { id: "resp_fixture_mapping", status: "completed" }]) {
          const outcome = await mapRaw(
            frame({ type: "response.output_item.done", output_index: 0, item: call }) + frame({ type: "response.completed", response }),
          );
          expect(outcome.error).toBeInstanceOf(ProviderError);
          expect(String(outcome.error)).toContain("not empty");
          expect(outcome.seen).toEqual([]);
        }
      }
    }
    // "{}" is the zero-argument form.
    const zero = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    expect(parseResponsesResponse(completed([zero]), "fixture").toolCalls).toEqual([{ id: "call_fixture", name: "lookup", arguments: {} }]);
    // An explicitly unfinished call in an incomplete response stays non-executable and is not replayed.
    const cut = parseResponsesResponse({ status: "incomplete", output: [{ ...zero, status: "incomplete", arguments: "" }] }, "fixture");
    expect(cut.toolCalls).toBeUndefined();
    expect(cut.message.responsesOutput).toEqual([]);
  });

  it("lets the terminal event fill only an absent status", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    // An explicit failed status raises the typed error whatever the event says.
    for (const type of ["response.incomplete", "response.completed"]) {
      const failed = await mapRaw(frame({ type, response: { id: "resp_fixture_mapping", status: "failed", error: null, output: [call] } }));
      expect(failed.error).toBeInstanceOf(ProviderError);
      expect(String(failed.error)).toContain("Responses request failed");
      expect(failed.seen).toEqual([]);
    }
    const limited = await mapRaw(frame({
      type: "response.incomplete",
      response: { status: "failed", error: { code: "rate_limit_exceeded", message: "slow down" }, output: [] },
    }));
    expect(limited.error).toBeInstanceOf(RateLimitError);
    expect(limited.seen).toEqual([]);
    // Any other explicit status that disagrees with the event is not replaced.
    for (const [type, status] of [["response.incomplete", "completed"], ["response.completed", "incomplete"], ["response.completed", "in_progress"]]) {
      const outcome = await mapRaw(frame({ type, response: { status, output: [call] } }));
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(`${type} event conflicts with its response status ${status}`);
      expect(outcome.seen).toEqual([]);
    }
    // An absent or null status is filled by the event.
    for (const status of [{}, { status: null }]) {
      const cut = await mapRaw(frame({ type: "response.incomplete", response: { ...status, output: [call] } }));
      expect(cut.seen.map((event) => event.type)).toEqual(["message", "end"]);
      expect(cut.seen.at(-1)).toEqual({ type: "end", finish_reason: "incomplete" });
      const finished = await mapRaw(frame({ type: "response.completed", response: { ...status, output: [call] } }));
      expect(finished.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
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

    // An unfinished call inside an otherwise completed response is contradictory: neither a
    // normal stop nor a partial set of calls, but a typed provider error.
    const done = { type: "function_call", status: "completed", call_id: "call_fixture_done", name: "lookup", arguments: "{}" };
    for (const output of [[{ ...cut, status: "in_progress" }], [done, { ...cut, status: "in_progress" }]]) {
      expect(() => parseResponsesResponse(completed(output), "fixture")).toThrow(/unfinished function_call/);
    }

    // An incomplete response cut off while reasoning leaves the trailing reasoning out.
    const message = { id: "msg_fixture", type: "message", status: "incomplete", role: "assistant", content: [{ type: "output_text", text: "Part" }] };
    expect(
      parseResponsesResponse({ status: "incomplete", output: [message, reasoning] }, "fixture").message.responsesOutput,
    ).toEqual([{ ...message, content: [{ type: "output_text", text: "Part", annotations: [] }] }]);
  });

  it("rejects repeated call ids and input-only items in provider output", () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    expect(() => parseResponsesResponse(completed([call, { ...call, arguments: "{\"q\":1}" }]), "fixture")).toThrow(
      "repeats function_call call_id call_fixture",
    );
    for (const type of ["item_reference", "function_call_output"]) {
      expect(() => parseResponsesResponse(completed([{ type, id: "item_fixture", call_id: "call_fixture", output: "x" }]), "fixture"))
        .toThrow(`must not contain ${type} items`);
    }
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

  it("rejects assistant tool calls that repeat an id before sending", () => {
    const call = { id: "call_fixture", name: "lookup", arguments: {} };
    expect(() => payload([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [call, { ...call, arguments: { city: "Paris" } }] },
    ])).toThrow("repeat id call_fixture");
  });

  it("replays provider items unchanged, with ids and statuses, and drops unreplayable reasoning", () => {
    const input = payload([{ role: "user", content: "go" }, replayed]).input as Record<string, unknown>[];
    expect(input.slice(1)).toEqual(replayed.responsesOutput.slice(1));
    expect(input[1]).not.toBe(replayed.responsesOutput[1]);
  });

  it("fills only the known required fields a compatible server omits, on the JSON, SSE and replay paths", async () => {
    const sparse = [
      { id: "rs_fixture_sparse", type: "reasoning", summary: null, encrypted_content: "fixture-encrypted-reasoning" },
      { type: "message", status: null, content: [{ type: "output_text", text: "Hi." }] },
      { id: "fc_fixture_sparse", type: "function_call", status: null, call_id: "call_fixture", name: "lookup", arguments: "{}" },
    ];
    // No id is invented for the message that has none.
    const normalized = [
      { ...sparse[0], summary: [] },
      { type: "message", status: "completed", content: [{ type: "output_text", text: "Hi.", annotations: [] }], role: "assistant" },
      { ...sparse[2], status: "completed" },
    ];
    const fromJson = parseResponsesResponse(completed(sparse), "fixture").message.responsesOutput;
    expect(fromJson).toEqual(normalized);
    expect(fromJson?.[1]).not.toHaveProperty("id");
    const text = `data: ${JSON.stringify({ type: "response.completed", response: completed(sparse) })}\n\n`;
    const events = await collect(mapResponsesStream(readServerSentEvents(body(text)), "fixture"));
    expect((events.find((event) => event.type === "message") as { message: ResponsesMessage }).message.responsesOutput).toEqual(normalized);

    // Caller-built history with the sparse items is replayed in the same normalized shape.
    const assistant = {
      role: "assistant",
      content: "Hi.",
      toolCalls: [{ id: "call_fixture", name: "lookup", arguments: {} }],
      responsesOutput: sparse,
    } satisfies ResponsesMessage;
    const reasoningProfile = defineCapabilityProfile({ ...customProfile, reasoning: true });
    const input = payload([{ role: "user", content: "go" }, assistant], reasoningProfile).input as Record<string, unknown>[];
    expect(input.slice(1)).toEqual(normalized);

    // Complete items come back exactly as they were sent.
    expect(parseResponsesResponse(completed(replayed.responsesOutput), "fixture").message.responsesOutput).toEqual(replayed.responsesOutput);
  });

  it("normalizes null annotations and rejects malformed output shapes on parse and on replay", () => {
    const text = (part: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Hi.", ...part }], ...extra,
    });
    expect(parseResponsesResponse(completed([text({ annotations: null })]), "fixture").message.responsesOutput)
      .toEqual([text({ annotations: [] })]);
    // A null id is no id and is not sent back as null.
    expect(parseResponsesResponse(completed([text({}, { id: null })]), "fixture").message.responsesOutput?.[0]).not.toHaveProperty("id");
    const reasoning = (summary: unknown[]) => ({ id: "rs_fixture", type: "reasoning", summary, encrypted_content: "fixture-encrypted-reasoning" });
    expect(parseResponsesResponse(completed([reasoning([{ text: "think" }]), text({})]), "fixture").message.responsesOutput?.[0])
      .toEqual(reasoning([{ text: "think", type: "summary_text" }]));

    const malformed: Array<[unknown, string]> = [
      [text({ annotations: "none" }), "annotations must be an array"],
      [text({}, { id: 7 }), "item id must be a string"],
      [text({}, { status: "done" }), "unexpected status done"],
      [reasoning([{ type: "reasoning_text", text: "think" }]), "unexpected type reasoning_text"],
      [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "Hi." }] }, "must not contain input_text parts"],
      [{ type: "message", role: "assistant", content: [{ type: "input_image", image_url: "https://example.test/a.png" }] }, "input_image"],
    ];
    const reasoningProfile = defineCapabilityProfile({ ...customProfile, reasoning: true });
    for (const [item, error] of malformed) {
      expect(() => parseResponsesResponse(completed([item]), "fixture")).toThrow(error);
      const message = { role: "assistant", content: "", responsesOutput: [item] } as unknown as ResponsesMessage;
      expect(() => payload([{ role: "user", content: "go" }, message], reasoningProfile)).toThrow(ValidationError);
    }
  });

  it("validates the call ledger across the whole stateless history before sending", () => {
    const call = (id: string) => ({ id, name: "lookup", arguments: {} });
    const result = (id: string) => ({ role: "tool" as const, content: "ok", tool_call_id: id });
    const providerCall = (id: string) => ({ type: "function_call", status: "completed", call_id: id, name: "lookup", arguments: "{}" });
    const user = { role: "user" as const, content: "go" };

    // Distinct parallel calls answered out of order pass.
    expect(() => payload([user, { role: "assistant", content: "", toolCalls: [call("call_a"), call("call_b")] }, result("call_b"), result("call_a")]))
      .not.toThrow();
    // A call id reused by a later assistant turn, from caller toolCalls or replayed provider items.
    expect(() => payload([user, { role: "assistant", content: "", toolCalls: [call("call_a")] }, result("call_a"),
      { role: "assistant", content: "", toolCalls: [call("call_a")] }])).toThrow("call_a is already used earlier");
    expect(() => payload([user, { role: "assistant", content: "", toolCalls: [call("call_a")] }, result("call_a"),
      { role: "assistant", content: "", toolCalls: [call("call_a")], responsesOutput: [providerCall("call_a")] }])).toThrow(ValidationError);
    // A repeated result, and a result with no earlier call.
    expect(() => payload([user, { role: "assistant", content: "", toolCalls: [call("call_a")] }, result("call_a"), result("call_a")]))
      .toThrow("call_a already has a result");
    expect(() => payload([user, result("call_a")])).toThrow("has no earlier matching tool call");
    expect(() => payload([user, result("call_b"), { role: "assistant", content: "", toolCalls: [call("call_b")] }]))
      .toThrow("has no earlier matching tool call");
    // Tool calls on a message that is not from the assistant are refused, not dropped.
    expect(() => payload([{ ...user, toolCalls: [call("call_a")] }])).toThrow("only accepted on assistant messages");
    // So is a tool_call_id on a message that is not a tool result.
    for (const role of ["system", "user", "assistant"] as const) {
      expect(() => payload([{ role, content: "go", tool_call_id: "call_a" }])).toThrow("tool_call_id is only accepted on tool messages");
    }
  });

  it("rejects item_reference history, which needs server-side state", () => {
    const message = {
      role: "assistant",
      content: "",
      responsesOutput: [{ type: "item_reference", id: "msg_fixture" }],
    } as unknown as ResponsesMessage;
    expect(() => payload([{ role: "user", content: "go" }, message])).toThrow(ValidationError);
    expect(() => payload([{ role: "user", content: "go" }, message])).toThrow("item_reference");

    // Input-only items are not provider output either, so they cannot ride along as replay.
    const output = {
      role: "assistant",
      content: "",
      responsesOutput: [{ type: "function_call_output", call_id: "call_fixture", output: "x" }],
    } as unknown as ResponsesMessage;
    expect(() => payload([{ role: "user", content: "go" }, output], customProfile)).toThrow(ValidationError);
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

  it("keeps a default cache identity per endpoint, apart from OpenAIChatModel", async () => {
    const entries = new Map<string, CompletionResponse>();
    const cache = {
      get: async (prompt: string, model: string, provider: string) => entries.get(JSON.stringify([prompt, model, provider])),
      set: async (prompt: string, model: string, provider: string, response: CompletionResponse) => {
        entries.set(JSON.stringify([prompt, model, provider]), response);
      },
    };
    const answer = (text: string): typeof fetch => async () => new Response(
      JSON.stringify(text.startsWith("chat:")
        ? { choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }] }
        : completed([{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }])),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const responses = (baseUrl: string, text: string, extra: Record<string, unknown> = {}) => new ResponsesChatModel({
      model: "gpt-fixture", baseUrl, profile: openAIProfile(), apiKey: "test-api-key", fetchImpl: answer(text), ...extra,
    });
    const run = async (model: OpenAIChatModel | ResponsesChatModel) => (await new LangFn({ model, cache }).complete("hi")).content;

    // OpenAIChatModel answers first; a Responses model on the same profile does not reuse it.
    expect(await run(new OpenAIChatModel({ model: "gpt-fixture", apiKey: "test-api-key", fetchImpl: answer("chat:openai") }))).toBe("chat:openai");
    expect(await run(responses("https://api.openai.com/v1", "responses:openai"))).toBe("responses:openai");
    // Two endpoints, or two paths on one host, do not share entries; the same endpoint does.
    expect(await run(responses("https://gateway-a.example.test/v1", "endpoint:a"))).toBe("endpoint:a");
    expect(await run(responses("https://gateway-b.example.test/v1", "endpoint:b"))).toBe("endpoint:b");
    expect(await run(responses("https://gateway-a.example.test/v1", "endpoint:a2", { path: "/alt/responses" }))).toBe("endpoint:a2");
    expect(await run(responses("https://gateway-a.example.test/v1", "endpoint:again"))).toBe("endpoint:a");
    // An explicit provider is the caller's chosen scope.
    expect(await run(responses("https://gateway-c.example.test/v1", "explicit", { provider: "openai" }))).toBe("chat:openai");
    expect(() => responses("https://gateway-c.example.test/v1", "x", { provider: " " })).toThrow(ValidationError);
  });

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
    expect(model.provider).toBe("custom-gateway-responses:https://gateway.example.test/v2/openai/responses");
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
    for (const baseUrl of [" https://gateway.example.test", "https://gateway.example.test/v1 ", "https://gateway.example.test\n"]) {
      expect(() => new ResponsesChatModel({ ...base, baseUrl })).toThrow("whitespace");
    }
    for (const baseUrl of ["https://gateway.example.test/v1?", "https://gateway.example.test/v1#", "https://gateway.example.test/v1?a=1"]) {
      expect(() => new ResponsesChatModel({ ...base, baseUrl })).toThrow("must not have a query or fragment");
    }
    // The endpoint is built from the parsed URL, so a trailing backslash cannot yield "//responses".
    for (const baseUrl of ["https://gateway.example.test/v1\\", "https://gateway.example.test/v1/", "https://gateway.example.test/x/../v1"]) {
      expect(new ResponsesChatModel({ ...base, baseUrl }).baseUrl).toBe("https://gateway.example.test/v1");
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

    // A redirect body whose cancel never settles does not hold the error back.
    const hanging = () => new Response(new ReadableStream<Uint8Array>({ cancel: () => new Promise<void>(() => {}) }), { status: 308 });
    await expect(gateway(async () => hanging()).chat({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow("redirect");
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

  it("delivers nothing more after the caller aborts, even when events are already buffered", async () => {
    const calls = [1, 2].map((n) => ({ type: "function_call", status: "completed", call_id: `call_fixture_${n}`, name: "lookup", arguments: "{}" }));
    // The whole body, a delta and a terminal response with two calls, arrives in one chunk.
    const text = [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.completed", response: completed(calls) },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    for (const abortOn of ["content", "tool_call"] as const) {
      const controller = new AbortController();
      const reason = new Error(`caller cancelled on ${abortOn}`);
      const model = gateway(async () => new Response(text, { status: 200 }), { timeout: 0 });
      const seen: StreamEvent[] = [];
      const outcome = await (async () => {
        for await (const event of model.streamChat({ messages: [{ role: "user", content: "x" }], signal: controller.signal })) {
          seen.push(event);
          if (event.type === abortOn) controller.abort(reason);
        }
      })().catch((caught: unknown) => caught);
      expect(outcome).toBe(reason);
      expect(seen.map((event) => event.type)).toEqual(abortOn === "content" ? ["content"] : ["content", "tool_call"]);
    }
  });

  it("rejects with the abort reason when the next buffered frame would fail", async () => {
    const delta = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`;
    for (const failing of [
      "data: {not json\n\n",
      `data: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "upstream failed" } } })}\n\n`,
    ]) {
      const controller = new AbortController();
      const reason = new Error("caller cancelled");
      const model = gateway(async () => new Response(delta + failing, { status: 200 }), { timeout: 0 });
      const seen: StreamEvent[] = [];
      const outcome = await (async () => {
        for await (const event of model.streamChat({ messages: [{ role: "user", content: "x" }], signal: controller.signal })) {
          seen.push(event);
          controller.abort(reason);
        }
      })().catch((caught: unknown) => caught);
      expect(outcome).toBe(reason);
      expect(seen.map((event) => event.type)).toEqual(["content"]);
    }
  });

  it("lets an HTTP status that names the error class win over a nested provider code", async () => {
    const failing = (status: number, code: string, headers: Record<string, string> = {}) =>
      gateway(async () => new Response(JSON.stringify({ error: { code, message: "fixture" } }), { status, headers }))
        .chat({ messages: [{ role: "user", content: "x" }] })
        .catch((caught: unknown) => caught);
    const limited = await failing(429, "invalid_api_key", { "retry-after": "7" });
    expect(limited).toBeInstanceOf(RateLimitError);
    expect(limited).toMatchObject({ retryAfter: 7 });
    expect(await failing(401, "rate_limit_exceeded")).toBeInstanceOf(ProviderAuthError);
    // A status that does not name the class leaves it to the nested code.
    expect(await failing(400, "rate_limit_exceeded")).toBeInstanceOf(RateLimitError);
    expect(await failing(403, "invalid_api_key")).toBeInstanceOf(ProviderAuthError);
  });

  it("completes after the terminal event although the body stays open and its cancel never settles", async () => {
    const terminal = { type: "response.completed", response: completed([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]) };
    const open = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`));
      },
      cancel: () => new Promise<void>(() => {}),
    }), { status: 200 });
    const events = await collect(gateway(async () => open(), { timeout: 0 }).streamChat({ messages: [{ role: "user", content: "x" }] }));
    expect(events.at(-1)).toEqual({ type: "end", finish_reason: "stop" });
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
