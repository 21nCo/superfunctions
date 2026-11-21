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
  openRouterHeaders,
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
import { outputItemIdentities, parseOutputItems } from "../src/models/responses/response.js";

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

/** An assistant message output item with one text part. */
const said = (text: string) => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations: [] }],
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

  it("applies the byte limit to each CR-separated line and to each event's accumulated data", async () => {
    const line = `data: ${"x".repeat(15)}\r`;
    // Two 21-byte lines fit a 40-byte line limit, and their 31 bytes of data (15 + LF + 15) fit
    // the same event budget.
    const events = await collect(readServerSentEvents(body(`${line.repeat(2)}\r`), 40));
    expect(events).toEqual([{ data: Array(2).fill("x".repeat(15)).join("\n") }]);
    await expect(collect(readServerSentEvents(body(`data: ${"x".repeat(50)}\r\r`), 40))).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    // Each line fits, but an event of many data lines crosses the budget: 47 bytes > 40.
    await expect(collect(readServerSentEvents(body(`${line.repeat(3)}\r`), 40))).rejects.toMatchObject({
      code: "RESPONSE_TOO_LARGE",
    });
    // Multi-byte data counts its UTF-8 bytes: 14 three-byte characters are 42 bytes.
    await expect(collect(readServerSentEvents(body(`data: ${"\u20ac".repeat(14)}\n\n`), 60))).resolves.toHaveLength(1);
    await expect(collect(readServerSentEvents(body(`data: ${"\u20ac".repeat(7)}\ndata: ${"\u20ac".repeat(7)}\n\n`), 40)))
      .rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
  });

  it("stops and cancels an endless event of short data lines at the event budget", async () => {
    let cancelled = false;
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("data: x\n".repeat(64)));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(collect(readServerSentEvents(endless, 1024))).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(cancelled).toBe(true);
    // About 1 KiB of "x" lines (2 bytes each with the LF) is read, not the whole body.
    expect(pulls).toBeLessThan(20);
  });

  it("does not dispatch an event whose data is empty", async () => {
    expect(await collect(readServerSentEvents(body("data:\n\nevent: ping\ndata:\n\ndata: real\n\n")))).toEqual([{ data: "real" }]);
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
      // A reported error, on the event or its response, decides the typed failure before the conflict.
      const rateLimit = { code: "rate_limit_exceeded", message: "slow down" };
      for (const data of [
        { type, error: rateLimit, response: completed([call]) },
        { type, response: { ...completed([call]), error: rateLimit } },
      ]) {
        const reported = await mapRaw(frame(done(0)) + frame(data, event));
        expect(reported.error).toBeInstanceOf(RateLimitError);
        expect(reported.seen).toEqual([]);
      }
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

    // Two finished items on one output index, or one call finished twice, would silently drop
    // or duplicate a call. An unindexed item never takes an arrival position as its index.
    const other = { ...call, call_id: "call_fixture_other" };
    for (const [frames, error] of [
      [[done(0), done(0, other)], "output_item.done states call_id call_fixture_other for function_call item call_fixture"],
      [[done(1), done(undefined, call)], "output_item.done finishes function_call item call_fixture twice"],
    ] as const) {
      const outcome = await mapRaw(frames.map((item) => frame(item)).join("") + frame({ type: "response.completed", response: completed([]) }));
      expect(String(outcome.error)).toContain(error);
      expect(outcome.seen).toEqual([]);
    }
    expect(String((await mapRaw(frame(done(-1)))).error)).toContain("non-negative integer");

    // A terminal event without its blank-line terminator is discarded at EOF.
    const unframed = await mapRaw(frame(done(0)) + `data: ${JSON.stringify({ type: "response.completed", response: completed([call]) })}`);
    expect(String(unframed.error)).toContain("ended before a terminal response event");
    expect(unframed.seen).toEqual([]);
  });

  it("treats the default SSE event names as absent and requires a non-empty JSON type", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const json = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`;
    const terminal = { type: "response.completed", response: completed([said("Hi"), call]) };
    // "event: message" and an empty event field are the WHATWG default type: the JSON type decides.
    for (const prefix of ["event: message\n", "event:\n", "event: \n"]) {
      const outcome = await mapRaw(`${prefix}${json({ type: "response.output_text.delta", delta: "Hi" })}${prefix}${json(terminal)}`);
      expect(outcome.error).toBeUndefined();
      expect(outcome.seen.map((event) => event.type)).toEqual(["content", "tool_call", "message", "end"]);
    }
    // A JSON type that is present but not a non-empty string is malformed, whatever the event name.
    for (const type of [false, 7, "", null, { name: "response.completed" }]) {
      for (const event of ["response.completed", undefined]) {
        const outcome = await mapRaw(frame({ ...terminal, type }, event));
        expect(outcome.error).toBeInstanceOf(ProviderError);
        expect(String(outcome.error)).toContain("event type must be a non-empty string");
        expect(outcome.seen).toEqual([]);
      }
    }
  });

  it("judges a reported provider error before the discriminator conflict and the response shape", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const rateLimit = { code: "rate_limit_exceeded", message: "slow down" };
    const cases: Array<[string, new (...args: never[]) => Error]> = [
      // The flat error shape under a conflicting terminal name, in either position.
      [frame({ type: "error", ...rateLimit }, "response.completed"), RateLimitError],
      [frame({ type: "response.completed", ...rateLimit, response: completed([call]) }, "error"), RateLimitError],
      [frame({ type: "error", code: "invalid_api_key", message: "bad key" }, "response.incomplete"), ProviderAuthError],
      [frame({ type: "error", code: "context_length_exceeded", message: "too long" }, "response.completed"), ContextLengthError],
      // A terminal frame with an error but a missing or malformed response.
      [frame({ type: "response.completed", error: rateLimit }), RateLimitError],
      [frame({ type: "response.incomplete", error: rateLimit, response: "gone" }), RateLimitError],
      [frame({ type: "response.completed", error: rateLimit }, "response.incomplete"), RateLimitError],
    ];
    for (const [text, expected] of cases) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(expected);
      expect(outcome.seen).toEqual([]);
    }
    // A conflict with no error still fails as a conflict, and a missing response without an error.
    for (const [text, error] of [
      [frame({ type: "error" }, "response.completed"), "event response.completed conflicts with its type error"],
      [frame({ type: "response.completed", response: completed([call]) }, "error"), "event error conflicts with its type response.completed"],
      [frame({ type: "response.completed" }), "response.completed event requires a response"],
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(outcome.error).not.toBeInstanceOf(RateLimitError);
      expect(String(outcome.error)).toContain(error);
      expect(outcome.seen).toEqual([]);
    }
  });

  it("requires every supplied response id to be a non-empty string and the same across the stream", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const lifecycle = (type: string, id: unknown) => frame({ type, response: { id, status: "in_progress", output: [] } });
    const terminal = (id: unknown) => frame({ type: "response.completed", response: { ...completed([call]), id } });
    for (const [text, error] of [
      [lifecycle("response.created", "resp_current") + terminal(7), "response id must be a non-empty string"],
      [lifecycle("response.created", "resp_current") + terminal(""), "response id must be a non-empty string"],
      [terminal(7), "response id must be a non-empty string"],
      [lifecycle("response.created", 7) + terminal("resp_current"), "response id must be a non-empty string"],
      [lifecycle("response.in_progress", "") + terminal("resp_current"), "response id must be a non-empty string"],
      [lifecycle("response.created", "resp_current") + lifecycle("response.in_progress", "resp_other") + terminal("resp_current"), "changed its response id"],
      [lifecycle("response.created", "resp_current") + terminal("resp_other"), "is for response resp_other, not resp_current"],
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(error);
      expect(outcome.seen).toEqual([]);
    }
    // Matching ids, and omitted or null ids on either side, keep working.
    for (const text of [
      lifecycle("response.created", "resp_current") + lifecycle("response.in_progress", "resp_current") + terminal("resp_current"),
      lifecycle("response.created", "resp_current") + terminal(undefined),
      lifecycle("response.created", null) + terminal("resp_current"),
      terminal(null),
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      expect(outcome.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
    }
    // The JSON path applies the same rule.
    for (const id of [7, "", {}]) {
      expect(() => parseResponsesResponse(completed([call], { id }), "fixture")).toThrow("response id must be a non-empty string");
    }
    expect(parseResponsesResponse(completed([call], { id: null }), "fixture").responseId).toBeUndefined();
    expect(parseResponsesResponse(completed([call]), "fixture").responseId).toBe("resp_fixture_mapping");
  });

  it("rejects any frame whose SSE event name and JSON type differ, before any tool call or end", async () => {
    const call = { id: "fc_fixture", type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{\"q\":1}" };
    const changed = { ...call, arguments: "{\"q\":2}" };
    const lifecycle = (id: string) => ({ response: { id, status: "in_progress", output: [] } });
    for (const [data, event] of [
      // A finished call under a non-done JSON type would be hidden from the ledger.
      [{ type: "response.output_item.added", output_index: 0, item: call }, "response.output_item.done"],
      [{ type: "response.output_item.done", output_index: 0, item: call }, "response.output_item.added"],
      // A conflicting lifecycle frame would skip the response id check.
      [{ type: "response.in_progress", ...lifecycle("resp_other") }, "response.created"],
      // A delta whose names differ.
      [{ type: "response.output_text.delta", delta: "Hi" }, "response.reasoning_text.delta"],
    ] as Array<[Record<string, unknown>, string]>) {
      const outcome = await mapRaw(frame(data, event) + frame({ type: "response.completed", response: completed([changed]) }));
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(`event ${event} conflicts with its type ${String(data.type)}`);
      expect(outcome.seen).toEqual([]);
    }
    // Matching names, a default event name, or one discriminator still pass.
    for (const text of [
      frame({ type: "response.created", ...lifecycle("resp_fixture_mapping") }, "response.created"),
      frame({ type: "response.output_text.delta", delta: "Hi" }, "message"),
      frame({ delta: "Hi" }, "response.output_text.delta"),
      frame({ type: "response.output_item.done", output_index: 0, item: call }),
    ]) {
      const outcome = await mapRaw(text + frame({ type: "response.completed", response: completed([call, said("Hi")]) }));
      expect(outcome.error).toBeUndefined();
      expect(outcome.seen.map((event) => event.type).filter((type) => type !== "content")).toEqual(["tool_call", "message", "end"]);
    }
  });

  it("validates every finished item with the output shape rules and judges the populated error envelope", async () => {
    const done = (item: unknown) => frame({ type: "response.output_item.done", item });
    const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi.", annotations: [] }] };
    for (const [finished, error] of [
      [{ ...message, role: "user" }, "must be from the assistant"],
      [{ ...message, content: "Hi." }, "content must be an array"],
      [{ type: "function_call_output", output: "ok" }, "must not contain function_call_output"],
    ] as Array<[unknown, string]>) {
      // With the terminal output present (matching nothing unidentified) and with it omitted.
      for (const output of [[message], []]) {
        const outcome = await mapRaw(done(finished) + frame({ type: "response.completed", response: completed(output) }));
        expect(outcome.error).toBeInstanceOf(ProviderError);
        expect(String(outcome.error)).toContain(error);
        expect(outcome.seen).toEqual([]);
      }
    }
    // An empty error object reports nothing, so the populated one decides the typed class.
    const rateLimit = { code: "rate_limit_exceeded", message: "slow down" };
    for (const text of [
      frame({ type: "response.failed", error: rateLimit, response: { id: "resp_fixture_mapping", status: "failed", error: {} } }),
      frame({ type: "error", error: {}, code: "rate_limit_exceeded", message: "slow down" }),
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(RateLimitError);
      expect(outcome.seen).toEqual([]);
    }
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
      [done() + terminal([message]), "terminal output states type message for function_call item call_fixture"],
      // The call changed its call_id, name or arguments.
      [done() + terminal([{ ...call, call_id: "call_fixture_other" }]), "terminal output states call_id call_fixture_other for function_call item call_fixture"],
      [done() + terminal([{ ...call, name: "delete_everything" }]), "terminal output states name delete_everything for function_call item call_fixture"],
      [done() + terminal([{ ...call, arguments: "{\"q\":2}" }]), "terminal output changes the arguments of function_call item call_fixture"],
      // Final arguments that differ from the item's, with an explicit or an omitted terminal output.
      [argsDone("{\"q\":2}") + done() + terminal([call]), "arguments differ from function_call item call_fixture"],
      [argsDone("{\"q\":2}") + done() + terminal([]), "arguments differ from function_call item call_fixture"],
      [argsDone("{\"q\":2}") + terminal([call]), "arguments differ from function_call item call_fixture"],
      // Final arguments for an item that is not a call, or for no item at all.
      [argsDone("{}") + terminal([message]), "terminal output states type message for function_call item fc_fixture"],
      [argsDone("{}") + terminal([]), "arguments name an unknown function_call item fc_fixture"],
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
      [done(note, 0) + terminal([call]), "terminal output states type function_call for message item msg_fixture"],
      [done({ ...call, id: "fc_fixture_first" }, 0) + terminal([call]), "terminal output states id fc_fixture for function_call item call_fixture"],
      [done({ ...note, id: "msg_fixture_first" }, 0) + done(call, 1) + terminal([note, call]), "terminal output states id msg_fixture for message item msg_fixture_first"],
      // A finished item whose index the terminal output does not reach.
      [done(note, 0) + done(call, 1) + terminal([note]), "terminal output does not have the finished function_call item call_fixture"],
      // An item_id that matches nothing does not fall back to the output_index.
      [done(call, 0) + argsDone({ item_id: "fc_fixture_missing", output_index: 0 }) + terminal([call]), "function_call_arguments.done states id fc_fixture_missing for function_call item call_fixture"],
      // An output_index that is malformed or names nothing, and locators naming different items.
      [done(call, 0) + argsDone({ item_id: "fc_fixture", output_index: -1 }) + terminal([call]), "output_index must be a non-negative integer"],
      [done(call, 0) + argsDone({ item_id: "fc_fixture", output_index: "0" }) + terminal([call]), "output_index must be a non-negative integer"],
      [done(call, 0) + argsDone({ output_index: 5 }) + terminal([call]), "arguments name an unknown function_call item at output_index 5"],
      [done(call, 0) + argsDone({ item_id: 7 }) + terminal([call]), "item_id must be a non-empty string"],
      [done(note, 0) + done(call, 1) + argsDone({ item_id: "fc_fixture", output_index: 0 }) + terminal([note, call]), "function_call_arguments.done states type function_call for message item msg_fixture"],
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
      expect(outcome.seen.map((event) => event.type)).toEqual(["content", "tool_call", "message", "end"]);
    }
  });

  it("reconciles finished items with the terminal output as one ledger", async () => {
    const call = { id: "fc_fixture", type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{\"q\":1}" };
    const note = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Done.", annotations: [] }] };
    const done = (item: unknown, index?: number) => frame({ type: "response.output_item.done", ...(index === undefined ? {} : { output_index: index }), item });
    const argsDone = (locator: Record<string, unknown>, args = call.arguments) => frame({ type: "response.function_call_arguments.done", ...locator, arguments: args });
    const terminal = (output: unknown[], envelope: Record<string, unknown> = {}) => frame({ type: "response.completed", response: completed(output), ...envelope });

    const rejected: Array<[string, string, typeof ProviderError]> = [
      // An unindexed finished item of any type that has an id must be in the terminal output.
      [done(note) + terminal([call]), "does not have the finished message item msg_fixture", ProviderError],
      // An unindexed call found by its call_id keeps its id, so a changed id is not hidden.
      [done({ ...call, id: "fc_fixture_first" }) + terminal([call]), "terminal output states id fc_fixture for function_call item call_fixture", ProviderError],
      // An unindexed call without an id is found by call_id and must be unchanged.
      [done({ ...call, id: undefined }) + terminal([{ ...call, arguments: "{\"q\":2}" }]), "terminal output changes the arguments of function_call item call_fixture", ProviderError],
      // A terminal output that names one item id, or one call_id, twice is ambiguous.
      [done(call, 0) + terminal([call, { ...call, call_id: "call_fixture_other" }]), "terminal output repeats item id fc_fixture", ProviderError],
      [done(call, 0) + terminal([call, { ...call, id: "fc_fixture_other" }]), "terminal output repeats function_call call_id call_fixture", ProviderError],
      [done(call, 0) + argsDone({ item_id: "fc_fixture" }) + terminal([call, { ...call, call_id: "call_fixture_other" }]), "repeats item id fc_fixture", ProviderError],
      // Two finished items cannot both be one terminal item.
      [done({ ...note, id: undefined }, 0) + done(note) + terminal([note, call]), "terminal output names two different items as message item msg_fixture", ProviderError],
      // An arrival position is never an output_index, with an omitted output either.
      [done(call) + argsDone({ output_index: 0 }) + terminal([]), "arguments name an unknown function_call item at output_index 0", ProviderError],
      // A populated error on the terminal event itself fails like one on its response.
      [done(call, 0) + terminal([call], { error: "upstream failed" }), "Responses request failed: upstream failed", ProviderError],
      [done(call, 0) + terminal([call], { error: { code: "rate_limit_exceeded", message: "slow down" } }), "", RateLimitError],
      [done(call, 0) + terminal([call], { error: { code: 429, message: "slow down" } }), "", RateLimitError],
      // Finished items go through the same identity validator as the terminal output, with a
      // present or omitted terminal output.
      [done({ ...call, id: 7 }, 0) + terminal([call]), "item id must be a string", ProviderError],
      [done({ ...call, id: 7 }) + terminal([call]), "item id must be a string", ProviderError],
      [done({ ...call, id: 7 }, 0) + terminal([]), "item id must be a string", ProviderError],
      [done({ ...note, id: "" }) + terminal([note]), "item id must not be empty", ProviderError],
      [done({ ...call, call_id: 7 }, 0) + terminal([call]), "item call_id must be a string", ProviderError],
      [done(call, 0) + terminal([{ ...call, id: 7 }]), "item id must be a string", ProviderError],
      // No other terminal item may share an identity of a finished item.
      [done(call, 1) + terminal([call, { ...call, id: undefined, call_id: "call_fixture_other" }]), "terminal output states output_index 0 for function_call item call_fixture", ProviderError],
      [done(call) + terminal([{ ...call, call_id: "call_fixture_other" }, { ...call, id: undefined }]), "terminal output states call_id call_fixture_other for function_call item call_fixture", ProviderError],
    ];
    for (const [text, error, type] of rejected) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(type);
      expect(String(outcome.error)).toContain(error);
      expect(outcome.seen).toEqual([]);
    }

    for (const text of [
      // An unindexed message and a call reordered to terminal index 0, with both locators.
      done(note) + done(call, 0) + argsDone({ item_id: "fc_fixture", output_index: 0 }) + terminal([call, note]),
      done(note) + done(call) + argsDone({ item_id: "fc_fixture", output_index: 0 }) + terminal([call, note]),
      // An unindexed call without an id matched by call_id; an item with neither is exempt.
      done({ ...call, id: undefined }) + terminal([call]),
      done({ ...note, id: undefined }) + done(call) + terminal([call]),
      // An id only the finished item carries is accepted on a unique match, and an
      // arguments.done item_id resolves through it.
      done(call, 0) + argsDone({ item_id: "fc_fixture" }) + terminal([{ ...call, id: undefined }]),
      done(call) + argsDone({ item_id: "fc_fixture" }) + terminal([{ ...call, id: undefined }]),
      done({ ...call, id: undefined }, 0) + argsDone({ item_id: "fc_fixture" }) + terminal([call]),
      // Matching snapshots and the omitted or empty fallback.
      done(note, 0) + done(call, 1) + argsDone({ item_id: "fc_fixture", output_index: 1 }) + terminal([note, call], { error: null }),
      done(call, 1) + done(note, 0) + argsDone({ output_index: 1 }) + terminal([]),
      done(note) + done(call) + argsDone({ item_id: "fc_fixture" }) + terminal([]),
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      // The note text, never streamed as deltas, arrives as one content event.
      expect(outcome.seen.map((event) => event.type).filter((type) => type !== "content")).toEqual(["tool_call", "message", "end"]);
    }
    // The omitted output follows the stated indexes, not arrival order.
    const rebuilt = await mapRaw(done(call, 1) + done(note, 0) + terminal([]));
    const message = rebuilt.seen.find((event) => event.type === "message");
    expect(message && message.type === "message" ? message.message.responsesOutput?.map((item) => item.type) : undefined).toEqual(["message", "function_call"]);
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
    // A reported error decides the outcome before a conflicting status is judged.
    const conflictingError = await mapRaw(frame({
      type: "response.completed",
      response: { status: "incomplete", error: { code: "rate_limit_exceeded", message: "slow down" }, output: [call] },
    }));
    expect(conflictingError.error).toBeInstanceOf(RateLimitError);
    expect(conflictingError.seen).toEqual([]);
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

  it("judges a reported provider error on every frame, before anything that frame or a later one yields", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const rateLimit = { code: "rate_limit_exceeded", message: "slow down" };
    const terminal = frame({ type: "response.completed", response: completed([call]) });
    for (const text of [
      // A data-only gateway error frame, alone and before a terminal response with a call.
      frame({ error: rateLimit }),
      frame({ error: rateLimit }) + terminal,
      // A lifecycle event whose response reports an error, before a terminal response with a call.
      frame({ type: "response.in_progress", response: { id: "resp_fixture_mapping", status: "in_progress", error: rateLimit } }) + terminal,
      // A delta that carries an error is not delivered.
      frame({ type: "response.output_text.delta", delta: "Hi.", error: rateLimit }) + terminal,
      // An empty event error defers to the populated response error.
      frame({ type: "error", error: {}, response: { error: rateLimit } }),
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(RateLimitError);
      expect(outcome.seen).toEqual([]);
    }
    // A null or empty error on a lifecycle frame is the normal shape and reports nothing.
    const normal = await mapRaw(
      frame({ type: "response.created", error: null, response: { id: "resp_fixture_mapping", status: "in_progress", error: null } })
      + frame({ type: "response.in_progress", response: { id: "resp_fixture_mapping", status: "in_progress", error: {} } })
      + terminal,
    );
    expect(normal.error).toBeUndefined();
    expect(normal.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
  });

  it("judges incomplete_details by one status rule shared with the JSON path", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const truncated = { incomplete_details: { reason: "max_output_tokens" } };
    // Truncation reported beside a completed status is a contradiction; with no status the turn
    // is incomplete, which a response.completed event contradicts as an explicit one would.
    for (const [response, error] of [
      [completed([call], truncated), "completed response reports incomplete_details"],
      [completed([call], { ...truncated, status: undefined }), "response.completed event conflicts with its response status incomplete"],
      [completed([call], { ...truncated, status: null }), "response.completed event conflicts with its response status incomplete"],
    ] as Array<[unknown, string]>) {
      const outcome = await mapRaw(frame({ type: "response.completed", response }));
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(error);
      expect(outcome.seen).toEqual([]);
    }
    const contradiction = await mapRaw(frame({ type: "response.incomplete", response: completed([call], truncated) }));
    expect(String(contradiction.error)).toContain("completed response reports incomplete_details");
    // A response.incomplete event with no status keeps its reason and executes nothing.
    const cut = await mapRaw(frame({ type: "response.incomplete", response: completed([call], { ...truncated, status: undefined }) }));
    expect(cut.seen.map((event) => event.type)).toEqual(["message", "end"]);
    expect(cut.seen.at(-1)).toEqual({ type: "end", finish_reason: "length" });
    // The JSON path: completed beside truncation fails; no or a null status is incomplete.
    expect(() => parseResponsesResponse(completed([call], truncated), "fixture")).toThrow("completed response reports incomplete_details");
    for (const status of [undefined, null]) {
      const parsed = parseResponsesResponse(completed([call], { ...truncated, status }), "fixture");
      expect(parsed.finishReason).toBe("length");
      expect(parsed.toolCalls).toBeUndefined();
    }
    // Null or empty incomplete_details report nothing; any other non-object is malformed.
    for (const details of [null, {}]) {
      expect(parseResponsesResponse(completed([call], { incomplete_details: details }), "fixture").finishReason).toBe("tool_calls");
      const streamed = await mapRaw(frame({ type: "response.completed", response: completed([call], { incomplete_details: details, status: undefined }) }));
      expect(streamed.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
    }
    expect(() => parseResponsesResponse(completed([call], { incomplete_details: "max_output_tokens" }), "fixture"))
      .toThrow("incomplete_details must be an object");
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

  it("fails a completed turn that never finished an announced item, before any tool call or end", async () => {
    const call = { id: "fc_fixture_1", type: "function_call", status: "completed", call_id: "call_fixture_1", name: "lookup", arguments: "{\"q\":1}" };
    const second = { id: "fc_fixture_2", type: "function_call", status: "completed", call_id: "call_fixture_2", name: "lookup", arguments: "{\"q\":2}" };
    const added = (item: Record<string, unknown>, index?: number) => frame({
      type: "response.output_item.added", ...(index === undefined ? {} : { output_index: index }), item: { ...item, status: "in_progress", arguments: "" },
    });
    const done = (item: unknown, index?: number) => frame({ type: "response.output_item.done", ...(index === undefined ? {} : { output_index: index }), item });
    const partial = frame({ type: "response.function_call_arguments.delta", output_index: 1, item_id: "fc_fixture_2", delta: "{\"q\"" });
    const terminal = (output: unknown[], status = "completed") => frame({ type: `response.${status}`, response: completed(output, { status }) });
    for (const text of [
      // The terminal output is omitted: rebuilt from the finished items, it would drop the second call.
      added(call, 0) + added(second, 1) + done(call, 0) + partial + terminal([]),
      // The supplied terminal output also leaves it out.
      added(call, 0) + added(second, 1) + done(call, 0) + partial + terminal([call]),
      // Even a supplied output that has it does not finish an announced item.
      added(call, 0) + added(second, 1) + done(call, 0) + terminal([call, second]),
      // Announced by id only.
      added(call) + added(second) + done(call) + terminal([call]),
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain("never finished the announced function_call item");
      expect(outcome.seen).toEqual([]);
    }
    // The item finished at an announced index must be the announced one.
    for (const text of [
      added(call, 0) + done(second, 0) + terminal([second]),
      added(call, 0) + done(said("Hi"), 0) + terminal([said("Hi")]),
    ]) {
      const outcome = await mapRaw(text);
      expect(String(outcome.error)).toMatch(/output_item\.done states (id fc_fixture_2|type message) for function_call item call_fixture_1/);
      expect(outcome.seen).toEqual([]);
    }
    expect(String((await mapRaw(added(call, 0) + added(second, 0))).error)).toContain("output_item.added states id fc_fixture_2 for function_call item call_fixture_1");
    expect(String((await mapRaw(added(call, -1))).error)).toContain("output_item.added output_index must be a non-negative integer");
    expect(String((await mapRaw(frame({ type: "response.output_item.added", item: "x" }))).error)).toContain("output_item.added requires an item");

    // Valid parallel calls, announced and finished, with the output supplied or omitted, still run.
    for (const output of [[call, second], []]) {
      const outcome = await mapRaw(added(call, 0) + added(second, 1) + done(call, 0) + done(second, 1) + terminal(output));
      expect(outcome.error).toBeUndefined();
      expect(outcome.seen.filter((event) => event.type === "tool_call").map((event) => (event as { id: string }).id))
        .toEqual(["call_fixture_1", "call_fixture_2"]);
    }
    // An incomplete turn may stop with an announced item unfinished: no tool calls, length.
    const incomplete = await mapRaw(added(call, 0) + added(second, 1) + done(call, 0) + partial
      + frame({ type: "response.incomplete", response: completed([call], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) }));
    expect(incomplete.error).toBeUndefined();
    expect(incomplete.seen.map((event) => event.type)).toEqual(["message", "end"]);
    expect(incomplete.seen.at(-1)).toEqual({ type: "end", finish_reason: "length" });
  });

  it("matches announced items to finished items one to one, by index, id or call_id", async () => {
    const call = { id: "fc_fixture_1", type: "function_call", status: "completed", call_id: "call_fixture_1", name: "lookup", arguments: "{}" };
    const second = { id: "fc_fixture_2", type: "function_call", status: "completed", call_id: "call_fixture_2", name: "lookup", arguments: "{}" };
    const added = (item: Record<string, unknown>, index?: number) => frame({
      type: "response.output_item.added", ...(index === undefined ? {} : { output_index: index }), item: { ...item, status: "in_progress", arguments: "" },
    });
    const done = (item: unknown, index?: number) => frame({ type: "response.output_item.done", ...(index === undefined ? {} : { output_index: index }), item });
    const terminal = (output: unknown[]) => frame({ type: "response.completed", response: completed(output) });
    const { id: _id, ...noId } = call;
    const replacement = { ...noId, call_id: "call_fixture_replacement" };
    for (const [text, message] of [
      // The call finished at the announced index is another call (no item id to compare).
      [added(noId, 0) + done(replacement, 0) + terminal([replacement]), "output_item.done states call_id call_fixture_replacement for function_call item call_fixture_1"],
      // Same call_id, different function name.
      [added(call, 0) + done({ ...call, name: "other" }, 0) + terminal([{ ...call, name: "other" }]), "output_item.done states name other for function_call item call_fixture_1"],
      // One finished call cannot answer two announcements.
      [added(call, 0) + added(call) + done(call, 0) + terminal([call]), "output_item.added announces function_call item call_fixture_1 twice"],
      // A call announced at one index and finished at another.
      [added(call, 0) + added(second, 1) + done(second, 0) + done(call, 1) + terminal([second, call]), "output_item.done states id fc_fixture_2 for function_call item call_fixture_1"],
      // Announced by call_id only and never finished.
      [added({ type: "function_call", call_id: "call_fixture_1", name: "lookup" }) + done(second, 0) + terminal([second]), "never finished the announced function_call item call_fixture_1"],
    ] as Array<[string, string]>) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(message);
      expect(outcome.seen).toEqual([]);
    }
    // Located by call_id (no index or id) or finished without a stated index, the call still runs.
    for (const text of [
      added({ type: "function_call", call_id: "call_fixture_1", name: "lookup" }) + done(call, 0) + terminal([call]),
      added(call, 0) + done(call) + terminal([call]),
      added(call, 0) + added(second, 1) + done(second, 1) + done(call, 0) + terminal([call, second]),
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      expect(outcome.seen.filter((event) => event.type === "tool_call").length).toBeGreaterThan(0);
    }
  });

  it("delivers exactly the rest of the answer after the content already yielded, or fails", async () => {
    const parts = (id: string, ...texts: string[]) => ({
      type: "message", id, role: "assistant", status: "completed",
      content: texts.map((text) => ({ type: "output_text", text, annotations: [] })),
    });
    const delta = (text: string, item_id?: string, output_index?: number, content_index = 0) =>
      frame({ type: "response.output_text.delta", ...(item_id ? { item_id } : {}), ...(output_index === undefined ? {} : { output_index }), content_index, delta: text });
    const done = (item: unknown, index?: number) => frame({ type: "response.output_item.done", ...(index === undefined ? {} : { output_index: index }), item });
    const contents = (seen: StreamEvent[]) => seen.filter((event) => event.type === "content").map((event) => (event as { delta: string }).delta);
    const messageOf = (seen: StreamEvent[]) => (seen.find((event) => event.type === "message") as { message: ResponsesMessage }).message;
    const truncated = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    const omitted = frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed" } });
    // The global delivery rule, or the rule that an item's streamed text is a prefix of its final text.
    const differs = /answer text differs from the streamed text|differs from the text the stream stated for it|differs from a text event that names no item/;
    for (const [text, expected, answer] of [
      // Streamed, then a completed turn that omits its output and finished no item: the streamed text stands.
      [delta("hel", "msg_1", 0) + delta("lo", "msg_1", 0) + omitted, ["hel", "lo"], "hello"],
      // A truncated turn that omits its output keeps the streamed text.
      [delta("hel", "msg_1", 0) + frame({ type: "response.incomplete", response: { id: "resp_fixture_mapping", ...truncated } }), ["hel"], "hel"],
      // Parts streamed in answer order: the rest is delivered once.
      [delta("Hello ", "msg_1", 0, 0) + delta("wo", "msg_1", 0, 1) + frame({ type: "response.completed", response: completed([parts("msg_1", "Hello ", "world")]) }),
        ["Hello ", "wo", "rld"], "Hello world"],
      // Items streamed in answer order, the second one only in part.
      [delta("Note. ", "msg_0", 0) + delta("Ans", "msg_1", 1) + frame({ type: "response.completed", response: completed([parts("msg_0", "Note. "), parts("msg_1", "Answer")]) }),
        ["Note. ", "Ans", "wer"], "Note. Answer"],
      // Only the first item streamed: the second is delivered whole after it.
      [delta("Note. ", "msg_0", 0) + frame({ type: "response.completed", response: completed([parts("msg_0", "Note. "), parts("msg_1", "Answer")]) }),
        ["Note. ", "Answer"], "Note. Answer"],
      // A delta that names no part may run across two parts of its item.
      [frame({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "Hello world" })
        + frame({ type: "response.completed", response: completed([parts("msg_1", "Hello ", "world")]) }), ["Hello world"], "Hello world"],
      // Streamed only at content_index 1 with the output omitted: the rebuilt message holds it.
      [delta("world", "msg_1", 0, 1) + omitted, ["world"], "world"],
    ] as Array<[string, string[], string]>) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      expect(contents(outcome.seen)).toEqual(expected);
      expect(contents(outcome.seen).join("")).toBe(answer);
      expect(messageOf(outcome.seen).content).toBe(answer);
    }
    for (const [text, message, streamed] of [
      // A later item streamed first: content Answer then "Note. " would not be the answer "Note. Answer".
      [delta("Answer", "msg_1", 1) + frame({ type: "response.completed", response: completed([parts("msg_0", "Note. "), parts("msg_1", "Answer")]) }),
        differs, ["Answer"]],
      // Deltas interleaved across two items.
      [delta("a", "msg_1", 0) + delta("b", "msg_2", 1) + delta("c", "msg_1", 0)
        + frame({ type: "response.completed", response: completed([parts("msg_1", "ac"), parts("msg_2", "b")]) }),
        differs, ["a", "b", "c"]],
      // Content parts streamed out of order, with the output supplied or omitted.
      [delta("world", "msg_1", 0, 1) + delta("Hello ", "msg_1", 0, 0) + frame({ type: "response.completed", response: completed([parts("msg_1", "Hello ", "world")]) }),
        differs, ["world", "Hello "]],
      [delta("world", "msg_1", 0, 1) + delta("Hello ", "msg_1", 0, 0) + omitted, differs, ["world", "Hello "]],
      // Text streamed to a named part must be a prefix of that part: not of a later part, nor
      // run on into the next part, even when the whole answer starts with it.
      [delta("hi", "msg_1", 0, 9) + frame({ type: "response.completed", response: completed([parts("msg_1", "hi")]) }),
        differs, ["hi"]],
      [delta("Hello world", "msg_1", 0, 0) + frame({ type: "response.completed", response: completed([parts("msg_1", "Hello ", "world")]) }),
        differs, ["Hello world"]],
      // A part's streamed text that the answer does not continue.
      [delta("world", "msg_1", 0, 0) + frame({ type: "response.completed", response: completed([parts("msg_1", "worl")]) }),
        differs, ["world"]],
      // A supplied output must have every item text was streamed to.
      [delta("gone", "msg_9", 3) + frame({ type: "response.completed", response: completed([parts("msg_1", "Hello")]) }),
        "terminal output does not have the streamed message item msg_9", ["gone"]],
      // A truncated turn with an explicit output that drops the streamed text.
      [delta("partial", "msg_1", 0) + frame({ type: "response.incomplete", response: completed([{ ...parts("msg_1"), status: "incomplete" }], truncated) }),
        differs, ["partial"]],
      [delta("partial") + frame({ type: "response.incomplete", response: completed([{ ...parts("msg_1", "Other"), status: "incomplete" }], truncated) }),
        differs, ["partial"]],
      // item_id and output_index name different items.
      [delta("Hi", "msg_2", 0) + frame({ type: "response.completed", response: completed([parts("msg_1", "Hi"), parts("msg_2", "There")]) }),
        "terminal output states id msg_1 for message item msg_2", ["Hi"]],
      // Rebuilding an omitted output from items that state an output_index only in part.
      [delta("Hi", "msg_1", 0) + done(parts("msg_1", "Hi"), 0) + done({ type: "reasoning", id: "rs_fixture", summary: [] }) + omitted,
        "state an output_index only in part", ["Hi"]],
    ] as Array<[string, string | RegExp, string[]]>) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      if (typeof message === "string") expect(String(outcome.error)).toContain(message);
      else expect(String(outcome.error)).toMatch(message);
      expect(contents(outcome.seen)).toEqual(streamed);
      expect(outcome.seen.every((event) => event.type === "content")).toBe(true);
    }
    expect(String((await mapRaw(frame({ type: "response.output_text.delta", content_index: -1, delta: "x" }))).error))
      .toContain("output_text.delta content_index must be a non-negative integer");
  });

  it("holds every item the stream stated to its final form, and fills an omitted output from text snapshots", async () => {
    const msg = (id: string, ...texts: string[]) => ({
      type: "message", id, role: "assistant", status: "completed",
      content: texts.map((text) => ({ type: "output_text", text, annotations: [] })),
    });
    const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: "{}", status: "completed" };
    const delta = (text: string, item_id?: string, output_index?: number, content_index?: number) => frame({
      type: "response.output_text.delta", ...(item_id ? { item_id } : {}), ...(output_index === undefined ? {} : { output_index }),
      ...(content_index === undefined ? {} : { content_index }), delta: text,
    });
    const textDone = (text: string, item_id: string, output_index: number, content_index?: number) => frame({
      type: "response.output_text.done", item_id, output_index, ...(content_index === undefined ? {} : { content_index }), text,
    });
    const partDone = (text: string, item_id: string, output_index: number, content_index: number) => frame({
      type: "response.content_part.done", item_id, output_index, content_index, part: { type: "output_text", text, annotations: [] },
    });
    const finish = (output?: unknown[]) => frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed", ...(output ? { output } : {}) } });
    const truncate = (output?: unknown[]) => frame({
      type: "response.incomplete",
      response: { id: "resp_fixture_mapping", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, ...(output ? { output } : {}) },
    });
    const contents = (seen: StreamEvent[]) => seen.filter((event) => event.type === "content").map((event) => (event as { delta: string }).delta);
    const messageOf = (seen: StreamEvent[]) => (seen.find((event) => event.type === "message") as { message: ResponsesMessage }).message;

    // A text snapshot (output_text.done or content_part.done) fills the rebuilt message and the rest is delivered once.
    for (const [text, expected, answer] of [
      [delta("hel", "msg_1", 0, 0) + textDone("hello", "msg_1", 0, 0) + finish(), ["hel", "lo"], "hello"],
      [delta("hel", "msg_1", 0, 0) + partDone("hello", "msg_1", 0, 0) + finish(), ["hel", "lo"], "hello"],
      [delta("hel", "msg_1", 0, 0) + truncate(), ["hel"], "hel"],
      // A snapshot that only repeats the streamed text, or a snapshot with nothing streamed.
      [delta("hel", "msg_1", 0, 0) + delta("lo", "msg_1", 0, 0) + textDone("hello", "msg_1", 0, 0) + partDone("hello", "msg_1", 0, 0) + finish(), ["hel", "lo"], "hello"],
      [textDone("hello", "msg_1", 0, 0) + finish(), ["hello"], "hello"],
      // A snapshot with no content_index is the whole item text.
      [delta("hel", "msg_1", 0) + textDone("hello", "msg_1", 0) + finish(), ["hel", "lo"], "hello"],
      // Snapshots that agree with a supplied output.
      [delta("hel", "msg_1", 0, 0) + textDone("hello", "msg_1", 0, 0) + finish([msg("msg_1", "hello")]), ["hel", "lo"], "hello"],
    ] as Array<[string, string[], string]>) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      expect(contents(outcome.seen)).toEqual(expected);
      expect(messageOf(outcome.seen).content).toBe(answer);
      expect(JSON.stringify(messageOf(outcome.seen).responsesOutput)).toContain(JSON.stringify(answer));
    }

    for (const [text, message] of [
      // A snapshot that does not extend the text streamed to its part.
      [delta("help", "msg_1", 0, 0) + textDone("hello", "msg_1", 0, 0) + finish(), "a text done event differs from the streamed text"],
      // Two snapshots of one part that disagree.
      [textDone("hello", "msg_1", 0, 0) + partDone("hullo", "msg_1", 0, 0) + finish(), "states different text for one text part"],
      // A snapshot that differs from the supplied (or finished) part.
      [delta("hel", "msg_1", 0, 0) + textDone("hello", "msg_1", 0, 0) + finish([msg("msg_1", "help")]), "differs from the text the stream stated for it"],
      [textDone("hello", "msg_1", 0, 0) + frame({ type: "response.output_item.done", output_index: 0, item: msg("msg_1", "help") }) + finish(),
        "differs from the text the stream stated for it"],
      [textDone("hello", "msg_1", 0, 1) + finish([msg("msg_1", "hello")]), "differs from the text the stream stated for it"],
      // An item's streamed text that its final text does not continue, though the whole answer does.
      [delta("Hello", "msg_1", 1, 0) + finish([msg("msg_0", "Hello"), msg("msg_1", "World")]), "text of message item msg_1 differs from the text the stream stated"],
      // Unlocated parts streamed out of content order, with the output omitted.
      [delta("world", undefined, undefined, 1) + delta("Hello ", undefined, undefined, 0) + finish(), "answer text differs from the streamed text"],
      // A snapshot of an item the supplied output does not have.
      [textDone("zzz", "msg_9", 1, 0) + finish([call]), "terminal output does not have the streamed message item msg_9"],
    ] as Array<[string, string]>) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(message);
      expect(outcome.seen.every((event) => event.type === "content")).toBe(true);
    }

    // On a completed turn, every item any event named is in the final output: an empty argument
    // delta, a reasoning delta, a content part or a built-in tool event naming an item the
    // output lacks fails before any tool call or end.
    for (const event of [
      { type: "response.function_call_arguments.delta", item_id: "fc_missing", output_index: 1, delta: "" },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_missing", output_index: 1, summary_index: 0, delta: "thinking" },
      { type: "response.content_part.added", item_id: "msg_missing", output_index: 1, content_index: 0, part: { type: "output_text", text: "" } },
      { type: "response.web_search_call.in_progress", item_id: "ws_missing", output_index: 1 },
    ]) {
      for (const terminal of [finish([call]), frame({ type: "response.output_item.done", output_index: 0, item: call }) + finish()]) {
        const outcome = await mapRaw(frame(event) + terminal);
        expect(outcome.error).toBeInstanceOf(ProviderError);
        expect(String(outcome.error)).toContain("never resolved");
        expect(outcome.seen.every((seen) => seen.type === "reasoning")).toBe(true);
      }
      // A truncated turn may stop before the item is in its output; it runs no call.
      const truncated = await mapRaw(frame(event) + truncate([{ ...call, status: "in_progress", arguments: "{" }]));
      expect(truncated.error).toBeUndefined();
      expect(truncated.seen.some((seen) => seen.type === "tool_call")).toBe(false);
    }
    // The same events naming an item the output has still pass.
    const named = await mapRaw(frame({ type: "response.function_call_arguments.delta", item_id: "fc_fixture", output_index: 0, delta: "{}" }) + finish([call]));
    expect(named.error).toBeUndefined();
    expect(named.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
  });

  it("reconciles the call_id of every call item, not only function calls", async () => {
    const custom = (call_id: string, status = "completed") => ({ type: "custom_tool_call", id: "ctc_fixture", call_id, name: "grammar", input: "x", status });
    const added = frame({ type: "response.output_item.added", output_index: 0, item: custom("call_a", "in_progress") });
    for (const text of [
      added + frame({ type: "response.output_item.done", output_index: 0, item: custom("call_b") }) + frame({ type: "response.completed", response: completed([custom("call_b")]) }),
      added + frame({ type: "response.output_item.done", output_index: 0, item: custom("call_a") }) + frame({ type: "response.completed", response: completed([custom("call_b")]) }),
      // A finished custom call whose input the terminal output changed.
      added + frame({ type: "response.output_item.done", output_index: 0, item: custom("call_a") })
        + frame({ type: "response.completed", response: completed([{ ...custom("call_a"), input: "y" }]) }),
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(outcome.seen).toEqual([]);
    }
    // An agreeing custom call replays with the call_id the stream stated, even when the terminal item omits it.
    const outcome = await mapRaw(added + frame({ type: "response.output_item.done", output_index: 0, item: custom("call_a") })
      + frame({ type: "response.completed", response: completed([{ ...custom("call_a"), call_id: undefined }]) }));
    expect(outcome.error).toBeUndefined();
    const message = (outcome.seen.find((event) => event.type === "message") as { message: ResponsesMessage }).message;
    expect(message.responsesOutput).toEqual([custom("call_a")]);
  });

  it("validates announcements and running output snapshots like an output that may be cut short", async () => {
    const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: "{}", status: "completed" };
    const truncated = { type: "response.incomplete", response: { id: "resp_fixture_mapping", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } };
    for (const [text, message] of [
      [frame({ type: "response.in_progress", response: { id: "resp_fixture_mapping", status: "in_progress", output: [null] } })
        + frame({ type: "response.completed", response: completed([call]) }), "output item is malformed"],
      [frame({ type: "response.created", response: { id: "resp_fixture_mapping", status: "in_progress", output: [{ type: "message", role: "user", content: [] }] } })
        + frame({ type: "response.completed", response: completed([call]) }), "must be from the assistant"],
      [frame({ type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: 7, arguments: null, status: "in_progress" } })
        + frame(truncated), "function_call name must be a string"],
      [frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "user", status: "in_progress", content: [] } })
        + frame({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "hi" }) + frame(truncated), "must be from the assistant"],
    ] as Array<[string, string]>) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(message);
      expect(outcome.seen).toEqual([]);
    }
    // Real announcements: a message before its content (with or without content []) and a call with no arguments yet.
    const outcome = await mapRaw(
      frame({ type: "response.created", response: { id: "resp_fixture_mapping", status: "in_progress", output: [] } })
      + frame({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress" } })
      + frame({ type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "", status: "in_progress" } })
      + frame({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [] } })
      + frame({ type: "response.output_item.done", output_index: 1, item: call })
      + frame({ type: "response.completed", response: completed([]) }),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
  });

  it("gives the caller executable arguments apart from the replayed message", async () => {
    const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: "{\"q\":1}", status: "completed" };
    const { seen } = await mapRaw(frame({ type: "response.completed", response: completed([call]) }));
    const toolCall = seen.find((event) => event.type === "tool_call") as { args: Record<string, unknown> };
    const message = (seen.find((event) => event.type === "message") as { message: ResponsesMessage }).message;
    toolCall.args.q = 2;
    expect(message.toolCalls?.[0]?.arguments).toEqual({ q: 1 });
    const parsed = parseResponsesResponse(completed([call]), "fixture");
    (parsed.toolCalls?.[0]?.arguments as Record<string, unknown>).q = 3;
    expect(parsed.message.toolCalls?.[0]?.arguments).toEqual({ q: 1 });
  });

  it("rebuilds an omitted output in stated output_index order, whatever order the items finished in", async () => {
    const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: "{}", status: "completed" };
    const note = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Note", annotations: [] }] };
    const outcome = await mapRaw(
      frame({ type: "response.output_item.done", output_index: 1, item: call })
      + frame({ type: "response.output_item.done", output_index: 0, item: note })
      + frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed" } }),
    );
    expect(outcome.error).toBeUndefined();
    const { message } = outcome.seen.find((event) => event.type === "message") as { message: ResponsesMessage };
    expect(message.responsesOutput?.map((item) => item.type)).toEqual(["message", "function_call"]);
    expect(outcome.seen.map((event) => event.type)).toEqual(["content", "tool_call", "message", "end"]);
  });

  it("merges every event that names an output item into the ledger, and the final item keeps the ledger identity", async () => {
    const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: "{}", status: "completed" };
    const terminal = (output: unknown[]) => frame({ type: "response.completed", response: completed(output) });
    // Each event names index 0 with an implied type that the terminal function_call contradicts.
    for (const event of [
      { type: "response.reasoning_summary_text.delta", item_id: "rs_fixture", output_index: 0, summary_index: 0, delta: "t" },
      { type: "response.reasoning_text.delta", item_id: "rs_fixture", output_index: 0, content_index: 0, delta: "" },
      { type: "response.reasoning_summary_part.added", item_id: "rs_fixture", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.output_text.delta", item_id: "fc_fixture", output_index: 0, content_index: 0, delta: "" },
      { type: "response.output_text.done", item_id: "msg_fixture", output_index: 0, content_index: 0, text: "" },
      { type: "response.refusal.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "" },
      { type: "response.content_part.added", item_id: "msg_fixture", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
      { type: "response.content_part.done", item_id: "msg_fixture", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
    ]) {
      const outcome = await mapRaw(frame(event) + terminal([call]));
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain("terminal output states type function_call");
      expect(outcome.seen.some((seen) => ["tool_call", "message", "end"].includes(seen.type))).toBe(false);
    }
    // An event of another kind that names the item by a different id fails too, and a malformed locator fails.
    const other = await mapRaw(frame({ type: "response.web_search_call.in_progress", item_id: "ws_fixture", output_index: 0 }) + terminal([call]));
    // A built-in tool event implies its item type, which the terminal function_call contradicts.
    expect(String(other.error)).toContain("terminal output states type function_call for web_search_call item ws_fixture");
    const malformed = await mapRaw(frame({ type: "response.output_text.done", item_id: 7, output_index: 0, text: "" }) + terminal([call]));
    expect(String(malformed.error)).toContain("item_id must be a non-empty string");
    // Agreeing events pass.
    const agreeing = await mapRaw(
      frame({ type: "response.reasoning_summary_text.delta", item_id: "rs_fixture", output_index: 0, summary_index: 0, delta: "t" })
      + frame({ type: "response.function_call_arguments.delta", item_id: "fc_fixture", output_index: 1, delta: "" })
      + terminal([{ type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "fixture-encrypted" }, call]),
    );
    expect(agreeing.error).toBeUndefined();
    expect(agreeing.seen.map((event) => event.type)).toEqual(["reasoning", "tool_call", "message", "end"]);
    // A finished reasoning item keeps its id in the replay when the terminal item omits it.
    const reasoning = { type: "reasoning", summary: [], encrypted_content: "fixture-encrypted" };
    for (const output of [[reasoning, call], undefined]) {
      const outcome = await mapRaw(
        frame({ type: "response.output_item.done", output_index: 0, item: { ...reasoning, id: "rs_fixture" } })
        + frame({ type: "response.output_item.done", output_index: 1, item: call })
        + frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed", ...(output ? { output } : {}) } }),
      );
      expect(outcome.error).toBeUndefined();
      const { message } = outcome.seen.find((event) => event.type === "message") as { message: ResponsesMessage };
      expect(message.responsesOutput?.[0]).toMatchObject({ type: "reasoning", id: "rs_fixture" });
    }
    // An announced call_id fills a finished call that omits it.
    const { call_id: _callId, ...anonymousCall } = call;
    const filled = await mapRaw(
      frame({ type: "response.output_item.added", output_index: 0, item: { ...call, status: "in_progress", arguments: "" } })
      + frame({ type: "response.output_item.done", output_index: 0, item: anonymousCall })
      + frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed" } }),
    );
    expect(filled.error).toBeUndefined();
    expect(filled.seen.find((event) => event.type === "tool_call")).toMatchObject({ id: "call_fixture" });
  });

  it("requires a running response envelope's output to be absent or an array", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const terminal = frame({ type: "response.completed", response: completed([call]) });
    for (const type of ["response.created", "response.queued", "response.in_progress"]) {
      for (const output of [{}, null, "items", 7]) {
        const outcome = await mapRaw(frame({ type, response: { id: "resp_fixture_mapping", status: "in_progress", output } }) + terminal);
        expect(outcome.error).toBeInstanceOf(ProviderError);
        expect(String(outcome.error)).toContain(`${type} event response output must be an array`);
        expect(outcome.seen).toEqual([]);
      }
      for (const output of [undefined, []]) {
        const outcome = await mapRaw(frame({ type, response: { id: "resp_fixture_mapping", status: "in_progress", ...(output ? { output } : {}) } }) + terminal);
        expect(outcome.error).toBeUndefined();
        expect(outcome.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
      }
    }
  });

  it("fails a lifecycle frame that reports incomplete_details, as every envelope judge does", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const terminal = frame({ type: "response.completed", response: completed([call]) });
    for (const type of ["response.created", "response.queued", "response.in_progress"]) {
      for (const status of ["in_progress", "queued", null, undefined]) {
        const outcome = await mapRaw(frame({ type, response: { id: "resp_fixture_mapping", status, incomplete_details: { reason: "max_output_tokens" } } }) + terminal);
        expect(outcome.error).toBeInstanceOf(ProviderError);
        expect(String(outcome.error)).toMatch(/incomplete_details on a running response|reports response status incomplete/);
        expect(outcome.seen).toEqual([]);
      }
      const malformed = await mapRaw(frame({ type, response: { status: "in_progress", incomplete_details: "max_output_tokens" } }) + terminal);
      expect(String(malformed.error)).toContain("incomplete_details must be an object");
      expect(malformed.seen).toEqual([]);
      for (const details of [null, {}]) {
        const outcome = await mapRaw(frame({ type, response: { id: "resp_fixture_mapping", status: "in_progress", incomplete_details: details } }) + terminal);
        expect(outcome.error).toBeUndefined();
        expect(outcome.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
      }
    }
  });

  it("holds running output snapshots and finished items to the final item, field by field", async () => {
    const call = (id: string, callId: string, name: string, args: string, status = "completed") =>
      ({ type: "function_call", id, call_id: callId, name, arguments: args, status });
    const running = (type: string, output: unknown[]) => frame({ type, response: { id: "resp_fixture_mapping", status: "in_progress", output } });
    const done = (item: unknown, index: number) => frame({ type: "response.output_item.done", output_index: index, item });
    const terminal = (output: unknown[]) => frame({ type: "response.completed", response: completed(output) });
    const reasoning = (extra: Record<string, unknown> = {}) =>
      ({ type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "fixture summary" }], ...extra });
    const lookup = call("fc_fixture", "call_fixture", "lookup", "{}");
    const rejected: Array<[string, string]> = [
      // A running snapshot shows one call at index 0, and the terminal output another there.
      [running("response.in_progress", [call("fc_fixture_first", "call_fixture_first", "delete_account", "", "in_progress")]) + terminal([lookup]),
        "terminal output states id fc_fixture for function_call item call_fixture_first"],
      [running("response.created", [{ type: "message", id: "msg_fixture", role: "assistant", content: [] }]) + terminal([lookup]),
        "terminal output states type function_call for message item msg_fixture"],
      // Two snapshots of one position that name different items.
      [running("response.in_progress", [call("fc_fixture", "call_fixture", "lookup", "", "in_progress")])
        + running("response.in_progress", [call("fc_fixture_other", "call_fixture", "lookup", "", "in_progress")]) + terminal([lookup]),
        "states id fc_fixture_other"],
      // A call a snapshot shows as completed is complete: its arguments parse, and they do not change after.
      [running("response.in_progress", [call("fc_fixture", "call_fixture", "lookup", "[")]) + terminal([lookup]), "arguments are not valid JSON"],
      [running("response.in_progress", [call("fc_fixture", "call_fixture", "lookup", "{\"q\":1}")]) + terminal([lookup]),
        "terminal output changes the arguments of function_call item call_fixture"],
      [running("response.in_progress", [call("fc_fixture", "call_fixture", "lookup", "{\"q\":1}")]) + done(lookup, 0) + terminal([]),
        "output_item.done changes the arguments of function_call item call_fixture"],
      // A finished item of any type agrees with its terminal form on every field both state.
      [done(reasoning(), 0) + terminal([reasoning({ summary: [{ type: "summary_text", text: "other summary" }] })]),
        "terminal output changes the summary of reasoning item rs_fixture"],
      [done(reasoning({ encrypted_content: "fixture-encrypted" }), 0) + terminal([reasoning({ encrypted_content: "fixture-other" })]),
        "terminal output changes the encrypted_content of reasoning item rs_fixture"],
      [done(said("Hi"), 0) + terminal([{ ...said("Hi"), id: undefined, content: [{ type: "output_text", text: "Hi", annotations: [{ type: "url_citation", url: "https://example.test" }] }] }]),
        "terminal output changes the content"],
      // A content part typed as an output item is an item at the wrong level.
      [frame({ type: "response.content_part.done", item_id: "fc_fixture", output_index: 0, content_index: 0, part: { type: "function_call", name: "x" } }) + terminal([lookup]),
        "content_part.done part has the item type function_call"],
      [frame({ type: "response.content_part.added", item_id: "fc_fixture", output_index: 0, content_index: 0, part: { type: "message" } }) + terminal([lookup]),
        "content_part.added part has the item type message"],
      // A built-in tool event implies its item type, whatever id it names.
      [frame({ type: "response.web_search_call.in_progress", item_id: "fc_fixture", output_index: 0 }) + terminal([lookup]),
        "terminal output states type function_call for web_search_call item fc_fixture"],
      [frame({ type: "response.mcp_call_arguments.delta", item_id: "fc_fixture", output_index: 0, delta: "" }) + terminal([lookup]),
        "terminal output states type function_call for mcp_call item fc_fixture"],
      [frame({ type: "response.custom_tool_call_input.delta", item_id: "fc_fixture", output_index: 0, delta: "" }) + terminal([lookup]),
        "terminal output states type function_call for custom_tool_call item fc_fixture"],
    ];
    for (const [text, error] of rejected) {
      const outcome = await mapRaw(text);
      expect(outcome.error, error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(error);
      expect(outcome.seen).toEqual([]);
    }

    // The final item keeps what an earlier form stated and it omits, for the replayed turn.
    const replay = async (text: string) => {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      expect(outcome.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
      return (outcome.seen.find((event) => event.type === "message") as { message: ResponsesMessage }).message.responsesOutput;
    };
    const encrypted = reasoning({ encrypted_content: "fixture-encrypted" });
    expect(await replay(done(encrypted, 0) + done(lookup, 1) + terminal([reasoning(), lookup]))).toEqual([encrypted, lookup]);
    // A snapshot that shows the item completed fills it too.
    const snapshotted = { ...encrypted, status: "completed" };
    expect(await replay(running("response.in_progress", [snapshotted]) + done(reasoning({ status: "completed" }), 0) + done(lookup, 1) + terminal([])))
      .toEqual([snapshotted, lookup]);
    // Running snapshots that agree pass: an empty one, a call still running, then the same call completed.
    expect(await replay(running("response.created", []) + running("response.in_progress", [call("fc_fixture", "call_fixture", "lookup", "", "in_progress")])
      + running("response.in_progress", [lookup]) + done(lookup, 0) + terminal([lookup]))).toEqual([lookup]);
    // A built-in tool event on its own item passes.
    const search = { type: "web_search_call", id: "ws_fixture", status: "completed" };
    expect(await replay(frame({ type: "response.web_search_call.completed", item_id: "ws_fixture", output_index: 0 }) + terminal([search, lookup])))
      .toEqual([search, lookup]);
  });

  it("treats a running snapshot that shows an item completed as a finished form on every ledger path", async () => {
    const call = (args: string, extra: Record<string, unknown> = {}) =>
      ({ type: "function_call", call_id: "call_fixture", name: "lookup", arguments: args, status: "completed", ...extra });
    const running = (output: unknown[]) => frame({ type: "response.in_progress", response: { id: "resp_fixture_mapping", status: "in_progress", output } });
    const terminal = (output?: unknown[]) => frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed", ...(output ? { output } : {}) } });
    const incomplete = () => frame({ type: "response.incomplete", response: { id: "resp_fixture_mapping", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } });
    const hi = { ...said("Hi there"), id: "msg_fixture" };
    const types = (seen: StreamEvent[]) => seen.map((event) => event.type);

    // Entries merged by the terminal output keep the snapshot: an id-only argument delta and an
    // id-less completed snapshot are one call, whose arguments the terminal output cannot change.
    const merged = await mapRaw(frame({ type: "response.function_call_arguments.delta", item_id: "fc_fixture", delta: "" })
      + running([call("{\"amount\":1}")]) + terminal([call("{\"amount\":2}", { id: "fc_fixture" })]));
    expect(String(merged.error)).toContain("terminal output changes the arguments of function_call item call_fixture");
    expect(merged.seen).toEqual([]);
    // Its text is checked like a finished item's: streamed Hello, snapshot Goodbye, omitted output.
    const differs = await mapRaw(frame({ type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "Hello" })
      + running([{ ...said("Goodbye"), id: "msg_fixture" }]) + terminal());
    expect(differs.error).toBeInstanceOf(ProviderError);
    expect(String(differs.error)).toContain("differs from the text the stream stated for it");
    expect(types(differs.seen)).toEqual(["content"]);
    // A supplied output must hold it, as it holds a finished item.
    const dropped = await mapRaw(running([hi, call("{}")]) + terminal([hi]));
    expect(String(dropped.error)).toContain("terminal output does not have the finished function_call item call_fixture");
    expect(dropped.seen).toEqual([]);

    // An omitted output is rebuilt from it, on a completed turn and on an incomplete one.
    const rebuilt = await mapRaw(running([call("{}")]) + terminal());
    expect(rebuilt.error).toBeUndefined();
    expect(types(rebuilt.seen)).toEqual(["tool_call", "message", "end"]);
    const cut = await mapRaw(running([hi]) + incomplete());
    expect(cut.error).toBeUndefined();
    expect(types(cut.seen)).toEqual(["content", "message", "end"]);
    const message = (cut.seen.find((event) => event.type === "message") as { message: ResponsesMessage }).message;
    expect(message.content).toBe("Hi there");
    expect(message.responsesOutput).toEqual([hi]);
    expect(cut.seen.at(-1)).toMatchObject({ finish_reason: "length" });
    // A call on an incomplete turn stays non-executable, however it finished.
    const cutCall = await mapRaw(running([call("{}")]) + incomplete());
    expect(cutCall.error).toBeUndefined();
    expect(types(cutCall.seen)).toEqual(["message", "end"]);
  });

  it("treats any announcement or snapshot that states a terminal item status as a finished form", async () => {
    const call = (args: string, extra: Record<string, unknown> = {}) =>
      ({ type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: args, status: "completed", ...extra });
    const added = (item: unknown) => frame({ type: "response.output_item.added", output_index: 0, item });
    const done = (item: unknown) => frame({ type: "response.output_item.done", output_index: 0, item });
    const running = (output: unknown[]) => frame({ type: "response.in_progress", response: { id: "resp_fixture_mapping", status: "in_progress", output } });
    const terminal = (output?: unknown[]) => frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed", ...(output ? { output } : {}) } });
    const types = (seen: StreamEvent[]) => seen.map((event) => event.type);
    const message = (text: string) => ({ ...said(text), id: "msg_fixture" });

    for (const [text, expected] of [
      // A completed announcement whose arguments the finished and final call change.
      [added(call("{\"a\":1}")) + done(call("{\"a\":2}")) + terminal([call("{\"a\":2}")]), "output_item.done changes the arguments of function_call item call_fixture"],
      // A completed announcement is a complete item: its arguments must be JSON.
      [added(call("[")) + done(call("{}")) + terminal([call("{}")]), "arguments are not valid JSON"],
      // A completed message announcement whose text the finished item changes.
      [added(message("Hi")) + done(message("Bye")) + terminal([message("Bye")]), "output_item.done changes the content of message item msg_fixture"],
      // An incomplete form is never overturned by a later completed one.
      [running([call("{", { status: "incomplete" })]) + terminal([call("{}")]), "completed stream finished an unfinished function_call"],
      [added(call("{", { status: "incomplete" })) + done(call("{}")) + terminal([call("{}")]), "output_item.done changes the"],
    ] as Array<[string, string]>) {
      const outcome = await mapRaw(text);
      expect(outcome.error, text).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(expected);
      expect(outcome.seen).toEqual([]);
    }

    // Identical announced and finished forms agree, and an in_progress announcement is no
    // finished form, so a realistic stream still runs its call.
    for (const announced of [call("{}"), call("", { status: "in_progress" })]) {
      const outcome = await mapRaw(added(announced) + done(call("{}")) + terminal([call("{}")]));
      expect(outcome.error).toBeUndefined();
      expect(types(outcome.seen)).toEqual(["tool_call", "message", "end"]);
    }
    // A completed announcement with the output omitted is rebuilt from it.
    const rebuilt = await mapRaw(added(call("{}")) + terminal());
    expect(rebuilt.error).toBeUndefined();
    expect(types(rebuilt.seen)).toEqual(["tool_call", "message", "end"]);
  });

  it("ends an incomplete turn whose announced call stated its arguments but never finished", async () => {
    const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: "", status: "in_progress" };
    const prefix = frame({ type: "response.output_item.added", output_index: 0, item: { ...said("Hi"), id: "msg_fixture" } })
      + frame({ type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "Hi" })
      + frame({ type: "response.output_item.done", output_index: 0, item: { ...said("Hi"), id: "msg_fixture" } })
      + frame({ type: "response.output_item.added", output_index: 1, item: call })
      + frame({ type: "response.function_call_arguments.done", item_id: "fc_fixture", output_index: 1, arguments: "{}" });
    const truncated = { id: "resp_fixture_mapping", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    for (const response of [truncated, { ...truncated, output: [{ ...said("Hi"), id: "msg_fixture" }] }]) {
      const outcome = await mapRaw(prefix + frame({ type: "response.incomplete", response }));
      expect(outcome.error).toBeUndefined();
      expect(outcome.seen.map((event) => event.type)).toEqual(["content", "message", "end"]);
      const message = (outcome.seen.find((event) => event.type === "message") as { message: ResponsesMessage }).message;
      expect(message.toolCalls ?? []).toEqual([]);
      expect(JSON.stringify(message.responsesOutput)).not.toContain("call_fixture");
      expect(outcome.seen.at(-1)).toMatchObject({ finish_reason: "length" });
    }
    // On a completed turn the same call must be in the output.
    const completedTurn = await mapRaw(prefix + frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed", output: [{ ...said("Hi"), id: "msg_fixture" }] } }));
    expect(completedTurn.error).toBeInstanceOf(ProviderError);
    expect(completedTurn.seen.map((event) => event.type)).toEqual(["content"]);
  });

  it("lets an incomplete turn drop an item the stream stated only as interrupted", async () => {
    const hi = { ...said("Hi"), id: "msg_fixture" };
    const cutCall = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: "{", status: "incomplete" };
    const response = { id: "resp_fixture_mapping", status: "in_progress" };
    const running = (output: unknown[]) => frame({ type: "response.in_progress", response: { ...response, output } });
    const added = (item: unknown, index: number) => frame({ type: "response.output_item.added", output_index: index, item });
    const truncated = { id: "resp_fixture_mapping", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    const incomplete = (output?: unknown[]) => frame({ type: "response.incomplete", response: { ...truncated, ...(output ? { output } : {}) } });
    const types = (seen: StreamEvent[]) => seen.map((event) => event.type);

    // A running snapshot or an announcement shows the call interrupted; the terminal output
    // supplies only the message, or is omitted: either way the answer and length outcome stay,
    // and the call is neither run nor replayed.
    for (const prefix of [running([hi, cutCall]), added(hi, 0) + added(cutCall, 1) + frame({ type: "response.output_item.done", output_index: 0, item: hi })]) {
      for (const output of [[hi], undefined]) {
        const outcome = await mapRaw(prefix + incomplete(output));
        expect(outcome.error, `${prefix} ${String(output)}`).toBeUndefined();
        expect(types(outcome.seen)).toEqual(["content", "message", "end"]);
        const message = (outcome.seen.find((event) => event.type === "message") as { message: ResponsesMessage }).message;
        expect(message.content).toBe("Hi");
        expect(message.toolCalls ?? []).toEqual([]);
        expect(JSON.stringify(message.responsesOutput)).not.toContain("call_fixture");
        expect(outcome.seen.at(-1)).toMatchObject({ finish_reason: "length" });
      }
    }
    // When the terminal output does have it, it still agrees with the interrupted form.
    const changed = await mapRaw(running([hi, cutCall]) + incomplete([hi, { ...cutCall, arguments: "{\"a\":1}" }]));
    expect(String(changed.error)).toContain("terminal output changes the arguments of function_call item call_fixture");
    expect(changed.seen).toEqual([]);
    // A completed turn may not drop it (nor finish it).
    const completedTurn = await mapRaw(running([hi, cutCall]) + frame({ type: "response.completed", response: completed([hi]) }));
    expect(completedTurn.error).toBeInstanceOf(ProviderError);
    expect(completedTurn.seen).toEqual([]);
    // An output_item.done finishes an item whatever its status, so the output must have it.
    const finished = await mapRaw(added(hi, 0) + frame({ type: "response.output_item.done", output_index: 0, item: hi })
      + frame({ type: "response.output_item.done", output_index: 1, item: cutCall }) + incomplete([hi]));
    expect(String(finished.error)).toContain("terminal output does not have the finished function_call item call_fixture");
  });

  it("reconciles a long stream of text deltas in time linear in their number", async () => {
    const count = 100_000;
    const text = "x".repeat(count);
    const item = { type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    for (const output of [[item], undefined]) {
      const frames: Array<{ data: string }> = [
        { data: JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }) },
      ];
      for (let index = 0; index < count; index += 1) {
        frames.push({ data: JSON.stringify({ type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: "x" }) });
      }
      frames.push({ data: JSON.stringify({ type: "response.output_item.done", output_index: 0, item }) });
      frames.push({ data: JSON.stringify({ type: "response.completed", response: completed(output ?? []) }) });
      let terminalAt = 0;
      async function* source() {
        for (const [index, value] of frames.entries()) {
          if (index === frames.length - 1) terminalAt = performance.now();
          yield value;
        }
      }
      let deltas = 0;
      let message: ResponsesMessage | undefined;
      for await (const event of mapResponsesStream(source(), "fixture")) {
        if (event.type === "content") deltas += 1;
        if (event.type === "message") message = (event as { message: ResponsesMessage }).message;
      }
      // Grouping each delta by copying its part's chunks took over 15 s here.
      expect(performance.now() - terminalAt).toBeLessThan(1000);
      expect(deltas).toBe(count);
      expect(message?.content).toBe(text);
    }
  }, 30_000);

  it("rejects content part events without a typed part, and sparse arrays in an output", async () => {
    const callItem = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: "{}", status: "completed" };
    const terminal = frame({ type: "response.completed", response: completed([callItem]) });
    for (const [event, part] of [["response.content_part.added", undefined], ["response.content_part.done", null], ["response.content_part.done", {}]] as const) {
      const outcome = await mapRaw(frame({ type: event, item_id: "fc_fixture", output_index: 0, content_index: 0, ...(part === undefined ? {} : { part }) }) + terminal);
      expect(String(outcome.error)).toContain("requires a typed part");
      expect(outcome.seen).toEqual([]);
    }
    // Holes in an output, its annotations or a reasoning summary are malformed elements.
    const sparse = <T>(...values: T[]): T[] => {
      const array = new Array<T>(values.length + 1);
      values.forEach((value, index) => { array[index + 1] = value; });
      return array;
    };
    expect(() => outputItemIdentities(sparse(callItem), "fixture")).toThrow(ProviderError);
    for (const output of [
      sparse(callItem),
      [{ ...said("Hi"), content: [{ type: "output_text", text: "Hi", annotations: sparse({ type: "url_citation" }) }] }],
      [{ type: "reasoning", id: "rs_fixture", summary: sparse({ type: "summary_text", text: "plan" }) }],
      [{ type: "reasoning", id: "rs_fixture", summary: [], content: sparse({ type: "reasoning_text", text: "plan" }) }],
    ]) {
      expect(() => parseOutputItems(output, "fixture")).toThrow(ProviderError);
    }
  });

  it("holds unlocated deltas that name a content_index to that part of the answer", async () => {
    const delta = (text: string, content_index: number) => frame({ type: "response.output_text.delta", content_index, delta: text });
    const terminal = (...texts: string[]) => frame({ type: "response.completed", response: completed([{
      type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: texts.map((text) => ({ type: "output_text", text, annotations: [] })),
    }]) });
    // Hello streamed to part 1 while the answer's part 1 is World, though the answer starts with Hello.
    const differs = await mapRaw(delta("Hello", 1) + terminal("Hello", "World"));
    expect(String(differs.error)).toContain("differs from a text event that names no item");
    expect(differs.seen.map((event) => event.type)).toEqual(["content"]);
    const agrees = await mapRaw(delta("Hello", 0) + delta(" Wor", 1) + terminal("Hello", " World"));
    expect(agrees.error).toBeUndefined();
    expect(agrees.seen.filter((event) => event.type === "content").map((event) => (event as { delta: string }).delta)).toEqual(["Hello", " Wor", "ld"]);
  });

  it("holds text done events that name no item to the answer", async () => {
    const terminal = (output: unknown[]) => frame({ type: "response.completed", response: completed(output) });
    const textDone = (text: string, extra: Record<string, unknown> = {}) => frame({ type: "response.output_text.done", text, ...extra });
    for (const text of [textDone("Goodbye") + terminal([said("Hello")]), textDone("Goodbye", { content_index: 0 }) + terminal([said("Hello")]),
      frame({ type: "response.content_part.done", content_index: 1, part: { type: "output_text", text: "Hello" } }) + terminal([said("Hello")])]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain("differs from a text event that names no item");
      expect(outcome.seen).toEqual([]);
    }
    for (const text of [textDone("Hello") + terminal([said("Hello")]), textDone("Hello", { content_index: 0 }) + terminal([said("Hello")]),
      frame({ type: "response.output_text.delta", delta: "Hel" }) + textDone("Hello") + frame({ type: "response.completed", response: { status: "completed" } })]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      expect((outcome.seen.find((event) => event.type === "message") as { message: ResponsesMessage }).message.content).toBe("Hello");
    }
  });

  it("rejects input part types in content parts and message parts in reasoning summary parts", async () => {
    const terminal = frame({ type: "response.completed", response: completed([{ ...said("Hi"), id: "msg_fixture" }]) });
    const rejected: Array<[string, string]> = [
      [frame({ type: "response.content_part.added", item_id: "msg_fixture", output_index: 0, content_index: 0, part: { type: "input_image", image_url: "https://example.test/x.png" } }),
        "content_part.added part has the input part type input_image"],
      [frame({ type: "response.content_part.done", item_id: "msg_fixture", output_index: 0, content_index: 0, part: { type: "input_text", text: "Hi" } }),
        "content_part.done part has the input part type input_text"],
      [frame({ type: "response.reasoning_summary_part.added", item_id: "rs_fixture", output_index: 0, summary_index: 0, part: { type: "function_call" } }),
        "reasoning_summary_part.added part has the item type function_call"],
      [frame({ type: "response.reasoning_summary_part.done", item_id: "rs_fixture", output_index: 0, summary_index: 0, part: { type: "output_text", text: "Hi" } }),
        "reasoning_summary_part.done part is a message part"],
    ];
    for (const [text, error] of rejected) {
      const outcome = await mapRaw(text + terminal);
      expect(outcome.error, error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(error);
      expect(outcome.seen).toEqual([]);
    }
    const summary = frame({ type: "response.reasoning_summary_part.done", item_id: "rs_fixture", output_index: 0, summary_index: 0, part: { type: "summary_text", text: "s" } });
    const reasoning = { type: "reasoning", id: "rs_fixture", summary: [{ type: "summary_text", text: "s" }] };
    const passes = await mapRaw(summary + frame({ type: "response.completed", response: completed([reasoning, said("Hi")]) }));
    expect(passes.error).toBeUndefined();
  });

  it("fails a lifecycle frame whose response status is not a running one, before any tool call or end", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const terminal = frame({ type: "response.completed", response: completed([call]) });
    for (const type of ["response.created", "response.queued", "response.in_progress"]) {
      for (const [status, error] of [
        ["failed", "Responses request failed"],
        ["completed", `${type} event reports response status completed`],
        ["incomplete", `${type} event reports response status incomplete`],
        ["cancelled", `${type} event reports response status cancelled`],
        [{ toString: null }, `${type} event reports response status {"toString":null}`],
      ] as Array<[unknown, string]>) {
        const outcome = await mapRaw(frame({ type, response: { id: "resp_fixture_mapping", status, output: [] } }) + terminal);
        expect(outcome.error).toBeInstanceOf(ProviderError);
        expect(String(outcome.error)).toContain(error);
        expect(outcome.seen).toEqual([]);
      }
      // A running, null or absent status still passes.
      for (const status of ["queued", "in_progress", null, undefined]) {
        const outcome = await mapRaw(frame({ type, response: { id: "resp_fixture_mapping", status, output: [] } }) + terminal);
        expect(outcome.error).toBeUndefined();
        expect(outcome.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
      }
    }
  });

  it("requires a running response envelope on every frame before the terminal one", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const terminal = frame({ type: "response.completed", response: completed([call]) });
    // A lifecycle frame must carry a response object.
    for (const type of ["response.created", "response.queued", "response.in_progress"]) {
      for (const response of [undefined, null, [], "resp_fixture_mapping", 7]) {
        const outcome = await mapRaw(frame({ type, ...(response === undefined ? {} : { response }) }) + terminal);
        expect(outcome.error).toBeInstanceOf(ProviderError);
        expect(String(outcome.error)).toContain(`${type} event requires a response object`);
        expect(outcome.seen).toEqual([]);
      }
    }
    // A cancelled response is never a success, whatever its envelope says.
    for (const type of ["response.cancelled", "response.canceled"]) {
      for (const status of ["cancelled", "in_progress"]) {
        const outcome = await mapRaw(frame({ type, response: { id: "resp_fixture_mapping", status } }) + terminal);
        expect(outcome.error).toBeInstanceOf(ProviderError);
        expect(outcome.seen).toEqual([]);
      }
    }
    // Any other frame that carries an envelope is judged by the same rule.
    const delta = { type: "response.output_text.delta", delta: "Hi" };
    for (const response of [{ status: "completed" }, { status: "in_progress", incomplete_details: { reason: "max_output_tokens" } }, [], null]) {
      const outcome = await mapRaw(frame({ ...delta, response }) + terminal);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(outcome.seen).toEqual([]);
    }
    const running = await mapRaw(frame({ ...delta, response: { id: "resp_fixture_mapping", status: "in_progress" } })
      + frame({ type: "response.completed", response: completed([said("Hi"), call]) }));
    expect(running.error).toBeUndefined();
    expect(running.seen.map((event) => event.type)).toEqual(["content", "tool_call", "message", "end"]);
  });

  it("keeps streamed text that no finished item holds in a rebuilt output, so the replayed turn has it", async () => {
    const delta = frame({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" });
    for (const [terminal, status] of [
      [frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed" } }), "completed"],
      [frame({ type: "response.incomplete", response: { id: "resp_fixture_mapping", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } }), "incomplete"],
    ]) {
      const outcome = await mapRaw(delta + terminal);
      expect(outcome.error).toBeUndefined();
      expect(outcome.seen.filter((event) => event.type === "content")).toHaveLength(1);
      const { message } = outcome.seen.find((event) => event.type === "message") as { message: ResponsesMessage };
      expect(message.content).toBe("Hello");
      const item = { type: "message", id: "msg_1", role: "assistant", status, content: [{ type: "output_text", text: "Hello", annotations: [] }] };
      expect(message.responsesOutput).toEqual([item]);
      expect(payload([{ role: "user", content: "go" }, message]).input).toEqual([{ type: "message", role: "user", content: "go" }, item]);
    }
  });

  it("places streamed text through the item ledger, so no text is delivered twice", async () => {
    const message = (id?: string) => ({ type: "message", ...(id ? { id } : {}), role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello", annotations: [] }] });
    const delta = (locator: Record<string, unknown>) => frame({ type: "response.output_text.delta", content_index: 0, ...locator, delta: "hello" });
    const done = (item: unknown, index?: number) => frame({ type: "response.output_item.done", ...(index === undefined ? {} : { output_index: index }), item });
    const terminal = (output?: unknown[]) => frame({ type: "response.completed", response: { id: "resp_fixture_mapping", status: "completed", ...(output ? { output } : {}) } });
    const contents = (seen: StreamEvent[]) => seen.filter((event) => event.type === "content").map((event) => (event as { delta: string }).delta);
    // A delta located by item_id and output_index finds an item at that index that carries no id.
    for (const text of [
      delta({ item_id: "msg_1", output_index: 0 }) + done(message(), 0) + terminal([message()]),
      delta({ item_id: "msg_1", output_index: 0 }) + done(message(), 0) + terminal(),
      delta({ item_id: "msg_1", output_index: 0 }) + terminal([message()]),
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      expect(contents(outcome.seen)).toEqual(["hello"]);
      expect((outcome.seen.find((event) => event.type === "message") as { message: ResponsesMessage }).message.content).toBe("hello");
    }
    for (const [text, error] of [
      // Streamed at output_index 0, finished with no index: the finished text could be the same text again.
      [delta({ output_index: 0 }) + done(message("msg_1")) + terminal(), "state an output_index only in part"],
      // A truncated turn whose output has another item where the delta was streamed.
      [delta({ item_id: "msg_other", output_index: 0 })
        + frame({ type: "response.incomplete", response: { id: "resp_fixture_mapping", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [message("msg_1")] } }),
        "terminal output states id msg_1 for message item msg_other"],
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(error);
      expect(contents(outcome.seen)).toEqual(["hello"]);
      expect(outcome.seen.every((event) => event.type === "content")).toBe(true);
    }
  });

  it("merges every event about an output item into one ledger entry under one conflict rule", async () => {
    const call = (extra: Record<string, unknown> = {}) => ({ type: "function_call", id: "fc_a", call_id: "call_a", name: "lookup", arguments: "{\"q\":1}", status: "completed", ...extra });
    const added = (item: Record<string, unknown>, index?: number) => frame({
      type: "response.output_item.added", ...(index === undefined ? {} : { output_index: index }), item: { ...item, status: "in_progress", arguments: "" },
    });
    const done = (item: unknown, index?: number) => frame({ type: "response.output_item.done", ...(index === undefined ? {} : { output_index: index }), item });
    const args = (delta: string, locator: Record<string, unknown> = { item_id: "fc_a", output_index: 0 }) =>
      frame({ type: "response.function_call_arguments.delta", ...locator, delta });
    const terminal = (output: unknown[], status = "completed") => frame({
      type: `response.${status}`,
      response: completed(output, status === "incomplete" ? { status, incomplete_details: { reason: "max_output_tokens" } } : {}),
    });
    const { id: _id, ...noId } = call();
    const { id: _a, call_id: _c, ...anonymous } = call();
    for (const [text, error] of [
      // Announced fc_a, finished without an id at the same index, then a terminal fc_b there.
      [added(call(), 0) + done(noId, 0) + terminal([call({ id: "fc_b" })]), "terminal output states id fc_b for function_call item call_a"],
      // The streamed arguments must add up to the finished ones.
      [added(call(), 0) + args("{\"q\":1}") + done(call({ arguments: "{\"q\":2}" }), 0) + terminal([call({ arguments: "{\"q\":2}" })]),
        "streamed function_call arguments differ from function_call item call_a"],
      // Arguments streamed for a call that never finished.
      [done(call(), 0) + args("{\"q\"", { item_id: "fc_b", output_index: 1 }) + terminal([call()]), "arguments name an unknown function_call item fc_b"],
      // An unindexed announcement is one item: a finished item matching one identity must match both.
      [added(call()) + done(call({ call_id: "call_b" })) + terminal([call({ call_id: "call_b" })]), "output_item.done states call_id call_b for function_call item call_a"],
      [added(call()) + done(call({ id: "fc_b" })) + terminal([call({ id: "fc_b" })]), "output_item.done states id fc_b for function_call item call_a"],
      // An announcement with no index or identity must still finish on a completed turn.
      [added(anonymous) + terminal([call()]), "never finished the announced function_call item"],
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeInstanceOf(ProviderError);
      expect(String(outcome.error)).toContain(error);
      expect(outcome.seen).toEqual([]);
    }
    for (const text of [
      // Streamed arguments that add up to the finished ones.
      added(call(), 0) + args("{\"q\"") + args(":1}") + done(call(), 0) + terminal([call()]),
      // An announcement with no index or identity is finished by the one call that matches nothing else.
      added(anonymous) + done(call()) + terminal([call()]),
      added(anonymous) + done(call()) + terminal([]),
    ]) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      expect(outcome.seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
    }
    // A truncated turn may stop mid-arguments: nothing runs.
    const cut = await mapRaw(added(call(), 0) + args("{\"q\"") + terminal([call({ status: "incomplete", arguments: "{\"q\"" })], "incomplete"));
    expect(cut.error).toBeUndefined();
    expect(cut.seen.map((event) => event.type)).toEqual(["message", "end"]);
  });

  it("delivers terminal text that was not streamed as deltas, once, before the tool calls and end", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const delta = (text: string) => frame({ type: "response.output_text.delta", delta: text });
    const terminal = frame({ type: "response.completed", response: completed([said("hello"), call]) });
    const contents = (seen: StreamEvent[]) => seen.filter((event) => event.type === "content").map((event) => (event as { delta: string }).delta);
    for (const [text, expected] of [
      [terminal, ["hello"]],
      [delta("hel") + terminal, ["hel", "lo"]],
      [delta("hel") + delta("lo") + terminal, ["hel", "lo"]],
    ] as Array<[string, string[]]>) {
      const outcome = await mapRaw(text);
      expect(outcome.error).toBeUndefined();
      expect(contents(outcome.seen)).toEqual(expected);
      expect(outcome.seen.slice(-3).map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
    }
    // Terminal text that does not extend the streamed text is a contradiction.
    const differs = await mapRaw(delta("bye") + terminal);
    expect(String(differs.error)).toContain("text differs from the streamed text");
    expect(differs.seen.map((event) => event.type)).toEqual(["content"]);
    // An incomplete turn delivers its partial terminal text the same way.
    const incomplete = await mapRaw(frame({
      type: "response.incomplete",
      response: completed([{ ...said("Part"), status: "incomplete" }], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }),
    }));
    expect(incomplete.seen.map((event) => event.type)).toEqual(["content", "message", "end"]);
    expect(contents(incomplete.seen)).toEqual(["Part"]);
  });

  it("judges a reported error before a malformed frame type, and reasoning parts inside a message", async () => {
    for (const type of [null, 7, ""]) {
      const outcome = await mapRaw(frame({ type, error: { code: "rate_limit_exceeded", message: "slow down" } }));
      expect(outcome.error).toBeInstanceOf(RateLimitError);
      expect(outcome.seen).toEqual([]);
    }
    // Reasoning parts inside an assistant message would drop their text: rejected in the terminal
    // output and in the output rebuilt from finished items.
    for (const part of [{ type: "summary_text", text: "think" }, { type: "reasoning_text", text: "think" }]) {
      const message = { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [part] };
      for (const text of [
        frame({ type: "response.completed", response: completed([message]) }),
        frame({ type: "response.output_item.done", output_index: 0, item: message }) + frame({ type: "response.completed", response: completed([]) }),
      ]) {
        const outcome = await mapRaw(text);
        expect(outcome.error).toBeInstanceOf(ProviderError);
        expect(String(outcome.error)).toContain(`must not contain ${part.type} parts`);
        expect(outcome.seen).toEqual([]);
      }
    }
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
    // Item ids are unique in a JSON response as in a stream; distinct parallel calls pass.
    const second = { ...call, call_id: "call_fixture_second" };
    expect(() => parseResponsesResponse(completed([{ ...call, id: "fc_fixture" }, { ...second, id: "fc_fixture" }]), "fixture"))
      .toThrow("Responses output repeats item id fc_fixture");
    const note = { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi." }] };
    expect(() => parseResponsesResponse(completed([note, note]), "fixture")).toThrow("repeats item id msg_fixture");
    expect(parseResponsesResponse(completed([{ ...call, id: "fc_fixture" }, { ...second, id: "fc_fixture_second" }]), "fixture").toolCalls)
      .toHaveLength(2);
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

  it("normalizes null annotations and rejects malformed output shapes on parse and on replay", async () => {
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
    // A null reasoning status or content is dropped; a valid status stays.
    expect(parseResponsesResponse(completed([{ ...reasoning([]), status: null, content: null }, text({})]), "fixture").message.responsesOutput?.[0])
      .toEqual(reasoning([]));
    expect(parseResponsesResponse(completed([{ ...reasoning([]), status: "completed" }, text({})]), "fixture").message.responsesOutput?.[0])
      .toEqual({ ...reasoning([]), status: "completed" });

    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    const malformed: Array<[unknown, string]> = [
      [text({ annotations: "none" }), "annotations must be an array"],
      [text({}, { id: 7 }), "item id must be a string"],
      [text({}, { status: "done" }), "unexpected status done"],
      [reasoning([{ type: "reasoning_text", text: "think" }]), "unexpected type reasoning_text"],
      [{ ...reasoning([]), status: "done" }, "reasoning item has unexpected status done"],
      [text({ annotations: ["cite"] }), "annotations must be objects"],
      [{ type: "message", role: "assistant", content: [{ type: "input_text", text: "Hi." }] }, "must not contain input_text parts"],
      [{ type: "message", role: "assistant", content: [{ type: "input_image", image_url: "https://example.test/a.png" }] }, "input_image"],
      // An empty discriminator names no type, and reasoning content parts are reasoning_text.
      [{ type: "", id: "item_fixture" }, "output item is malformed"],
      [{ type: "message", role: "assistant", content: [{ type: "", text: "Hi." }] }, "content part is malformed"],
      [{ ...reasoning([]), content: [{ type: "summary_text", text: "think" }] }, "reasoning content part has unexpected type summary_text"],
      // A known discriminator at the wrong level: a content part as an item, an item as a part.
      [{ type: "output_text", text: "Hi.", annotations: [] }, "item has the content part type output_text"],
      [{ type: "input_text", text: "Hi." }, "item has the content part type input_text"],
      [{ type: "message", role: "assistant", content: [call] }, "content part has the item type function_call"],
      [{ type: "message", role: "assistant", content: [{ type: "message", role: "assistant", content: [] }] }, "content part has the item type message"],
      [{ type: "message", role: "assistant", content: [{ type: "reasoning", summary: [] }] }, "content part has the item type reasoning"],
      // Reasoning parts belong in a reasoning item; inside a message their text would be dropped.
      [{ type: "message", role: "assistant", content: [{ type: "summary_text", text: "think" }] }, "must not contain summary_text parts"],
      [{ type: "message", role: "assistant", content: [{ type: "reasoning_text", text: "think" }] }, "must not contain reasoning_text parts"],
      // A wire value is described safely, never through its own toString.
      [text({}, { status: { toString: null } }), 'unexpected status {"toString":null}'],
    ];
    const reasoningProfile = defineCapabilityProfile({ ...customProfile, reasoning: true });
    for (const [item, error] of malformed) {
      expect(() => parseResponsesResponse(completed([item]), "fixture")).toThrow(error);
      const message = { role: "assistant", content: "", responsesOutput: [item] } as unknown as ResponsesMessage;
      expect(() => payload([{ role: "user", content: "go" }, message], reasoningProfile)).toThrow(ValidationError);
    }
    // A reasoning content part of type reasoning_text, or with no type, passes.
    for (const part of [{ type: "reasoning_text", text: "think" }, { text: "think" }]) {
      expect(parseResponsesResponse(completed([{ ...reasoning([]), content: [part] }, text({})]), "fixture").reasoning[0].content).toEqual(["think"]);
    }
    // Unknown item and part types still pass, for forward compatibility, on parse and on replay.
    const future = [{ type: "future_item_fixture" }, { type: "message", role: "assistant", content: [{ type: "future_part_fixture" }] }];
    expect(parseResponsesResponse(completed(future), "fixture").message.responsesOutput).toHaveLength(2);
    expect(() => payload([{ role: "user", content: "go" }, { role: "assistant", content: "", responsesOutput: future } as unknown as ResponsesMessage], reasoningProfile)).not.toThrow();
    // An untyped reasoning content part is replayed as reasoning_text, from a JSON and from a
    // stream-derived turn, so the continuation request carries its discriminator.
    const untyped = { ...reasoning([]), content: [{ text: "think" }] };
    const fromJson = parseResponsesResponse(completed([untyped, call]), "fixture").message;
    const continuation = (assistant: ResponsesMessage) => payload(
      [{ role: "user", content: "go" }, assistant, { role: "tool", content: "ok", tool_call_id: "call_fixture" } as ResponsesMessage],
      reasoningProfile,
    ) as { input: Array<Record<string, unknown>> };
    expect(continuation(fromJson).input.find((item) => item.type === "reasoning")?.content).toEqual([{ type: "reasoning_text", text: "think" }]);
    const streamed = await collect(mapResponsesStream(readServerSentEvents(body(
      `data: ${JSON.stringify({ type: "response.completed", response: completed([untyped, call]) })}\n\n`,
    )), "fixture"));
    const fromStream = (streamed.find((event) => event.type === "message") as { message: ResponsesMessage }).message;
    expect(continuation(fromStream).input.find((item) => item.type === "reasoning")?.content).toEqual([{ type: "reasoning_text", text: "think" }]);
    // A replayed output that repeats an item id fails before sending, as it does on parse.
    const repeated = text({}, { id: "msg_fixture" });
    const twice = (second: unknown) => ({ role: "assistant", content: "Hi.Hi.", responsesOutput: [repeated, second] }) as unknown as ResponsesMessage;
    expect(() => payload([{ role: "user", content: "go" }, twice(repeated)], reasoningProfile)).toThrow(ValidationError);
    expect(() => payload([{ role: "user", content: "go" }, twice({ ...repeated, id: "msg_fixture_second" })], reasoningProfile)).not.toThrow();
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

  it("rejects request shapes the provider would reject or that would silently drop turns", () => {
    const user: ResponsesMessage = { role: "user", content: "x" };
    for (const tool_choice of [{ type: "function" }, { type: "function", name: "" }, { type: "function", name: 7 }]) {
      expect(() => payload([user], openAIProfile(), { tool_choice })).toThrow("tool_choice of type function requires a function name");
    }
    expect(() => payload([user], openAIProfile(), { responseFormat: { type: "json_schema", name: "answer", schema: { type: "object" }, strict: "yes" } }))
      .toThrow("responseFormat strict must be a boolean");
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [user, , user] as ResponsesMessage[];
    expect(() => payload(sparse)).toThrow("Message 1 must be an object");
    // Both function choice shapes need a non-empty name, and both names, when stated, agree.
    for (const tool_choice of [{ type: "function", function: {} }, { type: "function", function: { name: "" } }, { type: "function", function: "lookup" }, { type: "function", name: null }]) {
      expect(() => payload([user], openAIProfile(), { tool_choice })).toThrow("tool_choice of type function requires a function name");
    }
    expect(() => payload([user], openAIProfile(), { tool_choice: { type: "function", name: "lookup", function: { name: "other" } } }))
      .toThrow("tool_choice names two different functions");
    expect(payload([user], openAIProfile(), { tool_choice: { type: "function", name: "lookup", function: { name: "lookup" } } }).tool_choice)
      .toEqual({ type: "function", name: "lookup" });
    for (const tool_choice of [{}, { type: "" }, { type: 7 }]) {
      expect(() => payload([user], openAIProfile(), { tool_choice })).toThrow("tool_choice object requires a type");
    }
    // Sparse tools or assistant tool calls, and non-string descriptions.
    // eslint-disable-next-line no-sparse-arrays
    expect(() => payload([user], openAIProfile(), { tools: [{ name: "lookup" }, , { name: "other" }] })).toThrow("Tool 1 requires a name");
    const call = { id: "call_fixture", name: "lookup", arguments: {} };
    // eslint-disable-next-line no-sparse-arrays
    const sparseCalls = { role: "assistant", content: "", toolCalls: [call, , { ...call, id: "call_other" }] } as unknown as ResponsesMessage;
    expect(() => payload([user, sparseCalls])).toThrow(ValidationError);
    expect(() => payload([user, sparseCalls])).toThrow("assistant tool call 1 must be an object");
    expect(() => payload([user], openAIProfile(), { tools: [{ name: "lookup", description: 7 }] })).toThrow("Tool lookup description must be a string");
    expect(() => payload([user], openAIProfile(), { responseFormat: { type: "json_schema", name: "answer", schema: { type: "object" }, description: 7 } }))
      .toThrow("responseFormat description must be a string");
  });

  it("checks the field types of a truncated function call it does not run", () => {
    const truncated = { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "lookup", arguments: "{\"q\"", status: "incomplete" };
    for (const [item, error] of [
      [{ ...call, name: 7 }, "function_call name must be a string"],
      [{ ...call, call_id: 7 }, "call_id must be a string"],
      [{ ...call, arguments: { q: 1 } }, "function_call arguments must be a string"],
      [{ ...call, status: 7 }, "function_call has unexpected status 7"],
      [{ ...call, name: "" }, "function_call name must not be empty"],
      [{ ...call, name: null }, "function_call name must be a string"],
      [{ ...call, arguments: null }, "function_call arguments must be a string"],
      [{ ...call, call_id: "" }, "call_id must not be empty"],
    ] as Array<[Record<string, unknown>, string]>) {
      expect(() => parseResponsesResponse(completed([item], truncated), "fixture")).toThrow(error);
    }
    // Truncated arguments are still accepted on an incomplete turn, and nothing runs.
    const parsed = parseResponsesResponse(completed([call], truncated), "fixture");
    expect(parsed.finishReason).toBe("length");
    expect(parsed.toolCalls).toBeUndefined();
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

  it("records terminal-only answer text in a LangFn.stream trace", async () => {
    const saveTrace = vi.fn(async (_trace: unknown) => {});
    const sse = `data: ${JSON.stringify({ type: "response.completed", response: completed([said("hello")]) })}\n\n`;
    const model = new ResponsesChatModel({
      model: "m", baseUrl: "https://gateway.example.test", profile: customProfile,
      fetchImpl: async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });
    const lang = new LangFn({ model, observability: { traceStorage: { saveTrace, findMany: async () => [] } } });
    const deltas: string[] = [];
    for await (const event of lang.stream("hi")) if (event.type === "content") deltas.push(event.delta);
    expect(deltas).toEqual(["hello"]);
    expect(saveTrace).toHaveBeenCalledOnce();
    expect(saveTrace.mock.calls[0][0]).toMatchObject({ kind: "stream_completion", output: "hello" });
  });

  it("sends every request to the canonical endpoint its default provider identity names", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      urls.push(String(input));
      return await okFetch([])(input, init);
    };
    const model = new ResponsesChatModel({ model: "m", baseUrl: "https://GATEWAY.example.test/v1", path: "/r\u00e9ponses", profile: customProfile, fetchImpl });
    await model.chat({ messages: [{ role: "user", content: "x" }] });
    expect(urls).toEqual(["https://gateway.example.test/v1/r%C3%A9ponses"]);
    expect(model.provider).toBe(`custom-gateway-responses:${urls[0]}`);
    // A wire status is described safely in a JSON response too.
    expect(() => parseResponsesResponse(completed([], { status: { toString: null } }), "fixture"))
      .toThrow('unexpected status {"toString":null}');
  });

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
    // The path stays below the base URL and canonical, as the default cache identity assumes.
    for (const path of ["/v1/responses?x=1", "/responses#a", "/re sponses", "/v1\\responses", "/v1/../responses", "/./responses", "/%2E%2e/responses"]) {
      expect(() => new ResponsesChatModel({ ...base, path })).toThrow("must not contain whitespace");
    }
    expect(new ResponsesChatModel({ ...base, path: "/v2/responses.json" }).provider).toBe("custom-gateway-responses:https://gateway.example.test/v2/responses.json");
    // Control characters, which URL parsing would strip after validation, are rejected.
    for (const path of ["/..\u0001/responses", "/\u0001", "/responses\u007f", "/\u0000responses"]) {
      expect(() => new ResponsesChatModel({ ...base, path })).toThrow("control characters");
    }
    // The default identity names the URL fetch resolves.
    expect(new ResponsesChatModel({ ...base, baseUrl: "https://gateway.example.test/v1", path: "/r\u00e9ponses" }).provider)
      .toBe("custom-gateway-responses:https://gateway.example.test/v1/r%C3%A9ponses");
    // The credential becomes a header value; one fetch would reject fails at construction, without echoing it.
    for (const apiKey of ["test-api-key\r\nx-injected: 1", "test-api-key\0", "test-api-key-\u2603"]) {
      const error = (() => {
        try {
          return new ResponsesChatModel({ ...base, apiKey });
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(ValidationError);
      expect(String((error as Error).message)).not.toContain("test-api-key");
    }
    expect(() => new ResponsesChatModel({ ...base, headers: { "x-test": "a\r\nb" } })).toThrow(ValidationError);
    // fetch rejects header values outside Latin-1 on send, so they fail at construction instead.
    for (const value of ["a\0b", "caf\u2603", "\u{1F600}"]) {
      expect(() => new ResponsesChatModel({ ...base, headers: { "x-test": value } })).toThrow("single-line Latin-1");
      expect(() => openRouterHeaders({ title: value })).toThrow(ValidationError);
    }
    expect(new ResponsesChatModel({ ...base, headers: { "x-test": "caf\u00e9" } })).toBeInstanceOf(ResponsesChatModel);
    expect(openRouterHeaders({ title: "caf\u00e9" })).toEqual({ "X-Title": "caf\u00e9" });
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
    // A status that names the class still decides when its body is oversized.
    const limited = gateway(async () => new Response(JSON.stringify(message), { status: 429, headers: { "retry-after": "7" } }), { maxResponseBytes: 64 });
    const limitedError = await limited.chat({ messages: [{ role: "user", content: "x" }] }).catch((caught: unknown) => caught);
    expect(limitedError).toBeInstanceOf(RateLimitError);
    expect(limitedError).toMatchObject({ retryAfter: 7 });
    const unauthorized = gateway(async () => new Response(JSON.stringify(message), { status: 401 }), { maxResponseBytes: 64 });
    await expect(unauthorized.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(ProviderAuthError);
    // So it does when its body stalls past the timeout, for chat and for a stream.
    for (const [status, type] of [[429, RateLimitError], [401, ProviderAuthError]] as const) {
      const stalledStatus = gateway(async () => new Response(stalled("{"), { status, headers: { "retry-after": "7" } }), { timeout: 30 });
      const chatError = await stalledStatus.chat({ messages: [{ role: "user", content: "x" }] }).catch((caught: unknown) => caught);
      const streamError = await collect(stalledStatus.streamChat({ messages: [{ role: "user", content: "x" }] })).catch((caught: unknown) => caught);
      for (const error of [chatError, streamError]) {
        expect(error).toBeInstanceOf(type);
        if (status === 429) expect(error).toMatchObject({ retryAfter: 7 });
      }
    }
    // An AbortError the caller did not cause (an upstream abort of the body) is a transport
    // failure: a 429 or 401 still classifies it, keeping it as the cause, and so does any status.
    const upstream = () => new ReadableStream<Uint8Array>({ start(stream) { stream.error(new DOMException("upstream fixture abort", "AbortError")); } });
    for (const [status, type] of [[429, RateLimitError], [401, ProviderAuthError], [503, ProviderError], [200, ProviderError]] as const) {
      const failing = gateway(async () => new Response(upstream(), { status, headers: { "retry-after": "7" } }));
      const chatError = await failing.chat({ messages: [{ role: "user", content: "x" }] }).catch((caught: unknown) => caught);
      // A 200 stream whose body aborts upstream is wrapped the same way as the JSON body read.
      const errors = [chatError, await collect(failing.streamChat({ messages: [{ role: "user", content: "x" }] })).catch((caught: unknown) => caught)];
      for (const error of errors) {
        expect(error, String(status)).toBeInstanceOf(type);
        expect((error as Error).cause).toMatchObject({ name: "AbortError" });
        if (status === 429) expect(error).toMatchObject({ retryAfter: 7 });
      }
    }
    const transport = gateway(async () => new Response(new ReadableStream<Uint8Array>({ start(stream) { stream.error(new TypeError("fixture transport failure")); } }), { status: 503 }));
    const transportError = await transport.chat({ messages: [{ role: "user", content: "x" }] }).catch((caught: unknown) => caught);
    expect(transportError).toBeInstanceOf(ProviderError);
    expect(String(transportError)).toContain("(503)");
    expect((transportError as Error).cause).toBeInstanceOf(TypeError);
    // A caller abort while the body of a 429 stalls still wins.
    const controller = new AbortController();
    const aborted = gateway(async () => {
      setTimeout(() => controller.abort(), 5);
      return new Response(stalled("{"), { status: 429 });
    }, { timeout: 5_000 });
    const abortError = await aborted.chat({ messages: [{ role: "user", content: "x" }], signal: controller.signal }).catch((caught: unknown) => caught);
    expect(abortError).not.toBeInstanceOf(RateLimitError);
    expect(abortError).toMatchObject({ name: "AbortError" });
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
      { type: "response.completed", response: completed([said("partial"), ...calls]) },
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

  it("stops at a transport failure of the body, even when events are already buffered", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    // One chunk holds a delta and a completed call; the body stays open.
    const text = [
      { type: "response.output_text.delta", delta: "partial" },
      { type: "response.completed", response: completed([said("partial"), call]) },
    ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
    const pausing = async (model: ResponsesChatModel, pause: number) => {
      const seen: StreamEvent[] = [];
      const outcome = await (async () => {
        for await (const event of model.streamChat({ messages: [{ role: "user", content: "x" }] })) {
          seen.push(event);
          await new Promise((resolve) => setTimeout(resolve, pause));
        }
      })().catch((caught: unknown) => caught);
      return { seen, outcome };
    };

    // The timeout fires while the consumer pauses after the delta.
    const timedOut = await pausing(gateway(async () => new Response(stalled(text), { status: 200 }), { timeout: 30 }), 80);
    expect(timedOut.outcome).toBeInstanceOf(TimeoutError);
    expect(timedOut.seen.map((event) => event.type)).toEqual(["content"]);

    // A prefetched second chunk crosses maxResponseBytes while the consumer pauses.
    const encoded = new TextEncoder().encode(text);
    const prefetched = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.enqueue(new TextEncoder().encode(`: ${"x".repeat(256)}\n`));
      },
    }), { status: 200 });
    const tooLarge = await pausing(gateway(async () => prefetched(), { timeout: 0, maxResponseBytes: encoded.byteLength + 16 }), 10);
    expect(tooLarge.outcome).toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    // The prefetch may fail before or after the delta is delivered, but never lets more through.
    expect(tooLarge.seen.filter((event) => event.type !== "content")).toEqual([]);

    // Without a failure the same buffered body completes.
    const complete = await pausing(gateway(async () => new Response(stalled(text), { status: 200 }), { timeout: 0 }), 0);
    expect(complete.outcome).toBeUndefined();
    expect(complete.seen.map((event) => event.type)).toEqual(["content", "tool_call", "message", "end"]);
  });

  it("delivers a fully received turn even when the body would fail after its terminal response", async () => {
    const call = { type: "function_call", status: "completed", call_id: "call_fixture", name: "lookup", arguments: "{}" };
    // One chunk holds the whole terminal response; the body stays open past the deadline.
    const text = `data: ${JSON.stringify({ type: "response.completed", response: completed([call]) })}\n\n`;
    const model = () => gateway(async () => new Response(stalled(text), { status: 200 }), { timeout: 40 });

    // The consumer pauses past the deadline on the tool call.
    const seen: StreamEvent[] = [];
    for await (const event of model().streamChat({ messages: [{ role: "user", content: "x" }] })) {
      seen.push(event);
      if (event.type === "tool_call") await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(seen.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);

    // A deadline or a caller abort after end does not fail the turn.
    const controller = new AbortController();
    const afterEnd: StreamEvent[] = [];
    for await (const event of model().streamChat({ messages: [{ role: "user", content: "x" }], signal: controller.signal })) {
      afterEnd.push(event);
      if (event.type === "end") {
        await new Promise((resolve) => setTimeout(resolve, 80));
        controller.abort(new Error("caller cancelled after end"));
      }
    }
    expect(afterEnd.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);

    // LangFn.stream ends with end, not an error event.
    const viaClient: StreamEvent[] = [];
    for await (const event of new LangFn({ model: model() }).stream("x")) {
      viaClient.push(event);
      if (event.type === "message") await new Promise((resolve) => setTimeout(resolve, 80));
    }
    expect(viaClient.map((event) => event.type)).toEqual(["tool_call", "message", "end"]);
  });

  it("keeps the first failure when the caller aborts after a transport deadline", async () => {
    const delta = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`;
    const controller = new AbortController();
    const seen: StreamEvent[] = [];
    const outcome = await (async () => {
      const model = gateway(async () => new Response(stalled(delta), { status: 200 }), { timeout: 30 });
      for await (const event of model.streamChat({ messages: [{ role: "user", content: "x" }], signal: controller.signal })) {
        seen.push(event);
        // The deadline passes during this pause; the caller aborts only afterwards.
        await new Promise((resolve) => setTimeout(resolve, 80));
        controller.abort(new Error("caller cancelled after the deadline"));
      }
    })().catch((caught: unknown) => caught);
    expect(outcome).toBeInstanceOf(TimeoutError);
    expect(seen.map((event) => event.type)).toEqual(["content"]);
  });

  it("rejects a returned call that reuses a call_id from the sent history, before any tool call", async () => {
    const history: ResponsesMessage[] = [
      { role: "user", content: "look it up" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_fixture_sent", name: "lookup", arguments: {} }] },
      { role: "tool", content: "ok", tool_call_id: "call_fixture_sent" },
    ];
    const call = (id: string) => ({ type: "function_call", status: "completed", call_id: id, name: "lookup", arguments: "{}" });
    const json = (id: string) => gateway(async () => new Response(JSON.stringify(completed([call(id)])), { status: 200 }));
    const sse = (id: string) => gateway(async () => new Response(
      `data: ${JSON.stringify({ type: "response.completed", response: completed([call("call_fixture_parallel"), call(id)]) })}\n\n`,
      { status: 200 },
    ));

    const reused = await json("call_fixture_sent").chat({ messages: history }).catch((caught: unknown) => caught);
    expect(reused).toBeInstanceOf(ProviderError);
    expect(String(reused)).toContain("call_id call_fixture_sent, which the sent history already used");
    const seen: StreamEvent[] = [];
    const streamed = await (async () => {
      for await (const event of sse("call_fixture_sent").streamChat({ messages: history })) seen.push(event);
    })().catch((caught: unknown) => caught);
    expect(streamed).toBeInstanceOf(ProviderError);
    expect(seen).toEqual([]);

    // New ids, including parallel ones, pass.
    expect((await json("call_fixture_new").chat({ messages: history })).toolCalls?.map((item) => item.id)).toEqual(["call_fixture_new"]);
    const events = await collect(sse("call_fixture_new").streamChat({ messages: history }));
    expect(events.filter((event) => event.type === "tool_call").map((event) => event.type === "tool_call" && event.id))
      .toEqual(["call_fixture_parallel", "call_fixture_new"]);
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

  it("rejects a blank direct or resolved key before sending", async () => {
    const seen: Headers[] = [];
    const base = { model: "m", baseUrl: "https://gateway.example.test", profile: customProfile, fetchImpl: okFetch(seen) };
    expect(() => new ResponsesChatModel({ ...base, apiKey: "   " })).toThrow(ValidationError);
    const model = new ResponsesChatModel({ ...base, apiKeyRef: "FIXTURE_KEY", secretProvider: () => " \t " });
    await expect(model.chat({ messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(NotConfiguredError);
    expect(seen).toHaveLength(0);
  });

  it("reads a non-object usage as invalid and a null status as absent, as the stream does", () => {
    const message = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi.", annotations: [] }] };
    for (const usage of ["12", 12, [], true]) {
      expect(() => parseResponsesResponse(completed([message], { usage }), "fixture")).toThrow(expect.objectContaining({ code: "INVALID_TOKEN_USAGE" }));
    }
    expect(parseResponsesResponse(completed([message], { usage: null }), "fixture").usage).toBeUndefined();
    expect(parseResponsesResponse(completed([message], { status: null }), "fixture").finishReason).toBe("stop");
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

  it("rejects a resolved key that is not a valid header value before sending, without echoing it", async () => {
    const seen: Headers[] = [];
    const model = new ResponsesChatModel({
      model: "m",
      baseUrl: "https://gateway.example.test",
      profile: customProfile,
      apiKeyRef: "FIXTURE_KEY",
      secretProvider: () => "test-api-key\r\nx-injected: 1",
      fetchImpl: okFetch(seen),
    });
    const error = await model.chat({ messages: [{ role: "user", content: "x" }] }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect(String((error as Error).message)).not.toContain("test-api-key");
    expect(seen).toHaveLength(0);
  });
});
