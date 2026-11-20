import { ProviderError } from "../../core/errors.js";
import type { StreamEvent } from "../../core/types.js";
import { readStreamLines } from "../stream-lines.js";
import { parseFunctionCall, parseResponsesResponse, responsesError } from "./response.js";

export interface ServerSentEvent {
  event?: string;
  data: string;
}

/** Parse server-sent events: multi-line data, CRLF line endings and comment lines. */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  maxLineBytes?: number,
): AsyncIterable<ServerSentEvent> {
  let data: string[] = [];
  let event: string | undefined;
  for await (const rawLine of readStreamLines(body, maxLineBytes)) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") {
      if (data.length) yield { ...(event !== undefined ? { event } : {}), data: data.join("\n") };
      data = [];
      event = undefined;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
  }
  if (data.length) yield { ...(event !== undefined ? { event } : {}), data: data.join("\n") };
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Map Responses API stream events to LangFn stream events: text deltas to `content`,
 * reasoning summary and reasoning text deltas to `reasoning`, completed function calls to
 * `tool_call`, then `token_usage`, the replayable assistant `message` and `end` from the
 * terminal response. A stream that ends without a terminal event, or that reports a failure,
 * throws a typed error.
 */
export async function* mapResponsesStream(
  events: AsyncIterable<ServerSentEvent>,
  provider: string,
): AsyncIterable<StreamEvent> {
  const fail = (message: string) => new ProviderError(message, { provider });
  const emittedCalls = new Set<string>();
  const doneItems = new Map<number, unknown>();

  for await (const frame of events) {
    if (frame.data === "[DONE]") break;
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch (error) {
      throw new ProviderError("Responses stream event is not valid JSON", { provider, cause: error });
    }
    if (!isRecord(payload)) throw fail("Responses stream event must be a JSON object");
    const type = typeof payload.type === "string" ? payload.type : frame.event;

    switch (type) {
      case "response.output_text.delta": {
        if (typeof payload.delta !== "string") throw fail("Responses text delta must be a string");
        if (payload.delta) yield { type: "content", content: payload.delta, delta: payload.delta };
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (typeof payload.delta !== "string") throw fail("Responses reasoning delta must be a string");
        const step = type === "response.reasoning_text.delta" ? "content" : "summary";
        if (payload.delta) yield { type: "reasoning", step, thinking: payload.delta };
        break;
      }
      case "response.output_item.done": {
        const item = payload.item;
        if (!isRecord(item)) throw fail("Responses output_item.done requires an item");
        if (typeof payload.output_index === "number") doneItems.set(payload.output_index, item);
        else doneItems.set(doneItems.size, item);
        if (item.type === "function_call") {
          const call = parseFunctionCall(item, provider);
          if (!emittedCalls.has(call.id)) {
            emittedCalls.add(call.id);
            yield { type: "tool_call", id: call.id, toolName: call.name, args: call.arguments };
          }
        }
        break;
      }
      case "response.completed":
      case "response.incomplete": {
        const response = payload.response;
        if (!isRecord(response)) throw fail(`Responses ${type} event requires a response`);
        // Some compatible servers omit the output in the terminal event; rebuild it from the items.
        const output = Array.isArray(response.output) && response.output.length
          ? response.output
          : [...doneItems.entries()].sort(([left], [right]) => left - right).map(([, item]) => item);
        const result = parseResponsesResponse({ ...response, output }, provider);
        for (const call of result.toolCalls ?? []) {
          if (emittedCalls.has(call.id)) continue;
          emittedCalls.add(call.id);
          yield { type: "tool_call", id: call.id, toolName: call.name, args: call.arguments };
        }
        if (result.usage) {
          yield {
            type: "token_usage",
            prompt_tokens: result.usage.prompt_tokens,
            completion_tokens: result.usage.completion_tokens,
            total_tokens: result.usage.total_tokens,
          };
        }
        yield { type: "message", message: result.message };
        yield { type: "end", finish_reason: result.finishReason };
        return;
      }
      case "response.failed": {
        const response = isRecord(payload.response) ? payload.response : {};
        throw responsesError(provider, { body: payload, error: response.error });
      }
      case "error":
        throw responsesError(provider, { body: payload, error: isRecord(payload.error) ? payload.error : payload });
      default:
        // Lifecycle and *.done events carry no new data for LangFn stream events.
        break;
    }
  }
  throw fail("Responses stream ended before a terminal response event");
}
