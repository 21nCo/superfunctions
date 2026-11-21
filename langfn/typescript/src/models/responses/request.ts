import { ContextLengthError, ValidationError } from "../../core/errors.js";
import type { ToolCall, ToolSpec } from "../../core/types.js";
import { parseMessageToolCalls } from "../openai.js";
import { requireCapability, type CapabilityProfile } from "../profiles/types.js";
import { parseOutputItems, sameToolCalls } from "./response.js";
import type {
  ResponsesChatRequest,
  ResponsesImageInput,
  ResponsesMessage,
  ResponsesReasoningConfig,
  ResponsesTextFormat,
} from "./types.js";

export interface ResponsesPayloadOptions {
  model: string;
  profile: CapabilityProfile;
  stream: boolean;
  /** Model-level defaults that a request may override. */
  maxOutputTokens?: number;
  reasoning?: ResponsesReasoningConfig;
}

const ROLES = new Set(["system", "user", "assistant", "tool"]);
const IMAGE_DETAILS = new Set(["auto", "low", "high"]);

/**
 * Map a chat request to a stateless Responses API payload (`store: false`; the caller
 * supplies the full history). Throws {@link UnsupportedCapabilityError} for any feature the
 * profile lacks and {@link ValidationError} for malformed input, before any network call.
 */
export function buildResponsesPayload(
  request: ResponsesChatRequest,
  options: ResponsesPayloadOptions,
): Record<string, unknown> {
  const { profile } = options;
  if (options.stream) requireCapability(profile, "streaming");
  if (!request || !Array.isArray(request.messages) || request.messages.length === 0) {
    throw new ValidationError("Responses requests require at least one message");
  }

  const payload: Record<string, unknown> = {
    model: options.model,
    input: toResponsesInput(request.messages, profile),
    store: false,
  };
  if (options.stream) payload.stream = true;

  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools)) throw new ValidationError("tools must be an array");
    if (request.tools.length) {
      requireCapability(profile, "tools", "the request declares tools");
      payload.tools = request.tools.map(toResponsesTool);
    }
  }
  if (request.tool_choice !== undefined) {
    requireCapability(profile, "tools", "the request sets tool_choice");
    payload.tool_choice = toResponsesToolChoice(request.tool_choice);
  }
  if (request.parallelToolCalls !== undefined) {
    requireCapability(profile, "tools", "the request sets parallelToolCalls");
    if (typeof request.parallelToolCalls !== "boolean") throw new ValidationError("parallelToolCalls must be a boolean");
    payload.parallel_tool_calls = request.parallelToolCalls;
  }

  if (request.responseFormat !== undefined) {
    requireCapability(profile, "structuredOutput", "the request sets responseFormat");
    payload.text = { format: toTextFormat(request.responseFormat) };
  }

  if (request.reasoning !== undefined) {
    requireCapability(profile, "reasoning", "the request sets reasoning");
  }
  if (options.reasoning !== undefined) {
    requireCapability(profile, "reasoning", "the model sets a default reasoning configuration");
  }
  const reasoning = request.reasoning ?? options.reasoning;
  if (reasoning !== undefined) payload.reasoning = toReasoning(reasoning);
  // Stateless continuation of a reasoning model needs the encrypted reasoning items back.
  if (profile.reasoning) payload.include = ["reasoning.encrypted_content"];

  const maxOutputTokens = request.maxOutputTokens ?? options.maxOutputTokens;
  if (maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
      throw new ValidationError("maxOutputTokens must be a positive safe integer");
    }
    if (profile.maxOutputTokens !== undefined && maxOutputTokens > profile.maxOutputTokens) {
      throw new ValidationError(
        `maxOutputTokens ${maxOutputTokens} exceeds the ${profile.id} profile limit of ${profile.maxOutputTokens}`,
        { provider: profile.id, metadata: { maxOutputTokens, limit: profile.maxOutputTokens } },
      );
    }
    if (profile.contextWindow !== undefined && maxOutputTokens > profile.contextWindow) {
      throw new ContextLengthError(
        `maxOutputTokens ${maxOutputTokens} exceeds the ${profile.id} context window of ${profile.contextWindow}`,
        { provider: profile.id, metadata: { maxOutputTokens, contextWindow: profile.contextWindow } },
      );
    }
    payload.max_output_tokens = maxOutputTokens;
  }
  return payload;
}

/**
 * In stateless mode the history is the whole call ledger: every function call id appears in
 * one assistant turn only, and every tool result answers exactly one earlier call. Parallel
 * calls may be answered in any order.
 */
function toResponsesInput(messages: ResponsesMessage[], profile: CapabilityProfile): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = [];
  const calls = new Set<string>();
  const results = new Set<string>();
  messages.forEach((message, index) => {
    if (!message || typeof message !== "object") throw new ValidationError(`Message ${index} must be an object`);
    if (!ROLES.has(message.role)) throw new ValidationError(`Message ${index} has an unsupported role`);
    if (typeof message.content !== "string") throw new ValidationError(`Message ${index} content must be a string`);
    if (message.images !== undefined && message.role !== "user") {
      throw new ValidationError(`Message ${index}: images are only accepted on user messages`);
    }
    if (message.responsesOutput !== undefined && message.role !== "assistant") {
      throw new ValidationError(`Message ${index}: responsesOutput is only accepted on assistant messages`);
    }
    if (message.role !== "assistant" && (hasItems(message.toolCalls) || hasItems(message.tool_calls))) {
      throw new ValidationError(`Message ${index}: tool calls are only accepted on assistant messages`);
    }
    switch (message.role) {
      case "system":
        input.push({ type: "message", role: "system", content: message.content });
        return;
      case "user":
        input.push(toUserItem(message, index, profile));
        return;
      case "tool":
        requireCapability(profile, "tools", "the history contains a tool result");
        if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
          throw new ValidationError(`Message ${index}: tool results require tool_call_id`);
        }
        if (!calls.has(message.tool_call_id)) {
          throw new ValidationError(`Message ${index}: tool result ${message.tool_call_id} has no earlier matching tool call`);
        }
        if (results.has(message.tool_call_id)) {
          throw new ValidationError(`Message ${index}: tool call ${message.tool_call_id} already has a result`);
        }
        results.add(message.tool_call_id);
        input.push({ type: "function_call_output", call_id: message.tool_call_id, output: message.content });
        return;
      case "assistant": {
        const items = toAssistantItems(message, index, profile);
        for (const item of items) {
          if (item.type !== "function_call" || typeof item.call_id !== "string") continue;
          if (calls.has(item.call_id)) {
            throw new ValidationError(`Message ${index}: tool call id ${item.call_id} is already used earlier in the history`);
          }
          calls.add(item.call_id);
        }
        input.push(...items);
        return;
      }
    }
  });
  return input;
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null;
}

function toUserItem(message: ResponsesMessage, index: number, profile: CapabilityProfile): Record<string, unknown> {
  if (message.images !== undefined && !Array.isArray(message.images)) {
    throw new ValidationError(`Message ${index}: images must be an array`);
  }
  if (!message.images?.length) return { type: "message", role: "user", content: message.content };
  requireCapability(profile, "vision", "the history contains an image input");
  const content: Record<string, unknown>[] = message.content ? [{ type: "input_text", text: message.content }] : [];
  for (const image of message.images) content.push(toImagePart(image, index));
  return { type: "message", role: "user", content };
}

function toImagePart(image: ResponsesImageInput, index: number): Record<string, unknown> {
  if (!image || typeof image !== "object" || typeof image.url !== "string" || !image.url) {
    throw new ValidationError(`Message ${index}: each image needs a url`);
  }
  if (!/^(https?:|data:image\/)/i.test(image.url)) {
    throw new ValidationError(`Message ${index}: image urls must be http(s) or data:image URLs`);
  }
  if (image.detail !== undefined && !IMAGE_DETAILS.has(image.detail)) {
    throw new ValidationError(`Message ${index}: image detail must be auto, low or high`);
  }
  return { type: "input_image", image_url: image.url, detail: image.detail ?? "auto" };
}

function toAssistantItems(message: ResponsesMessage, index: number, profile: CapabilityProfile): Record<string, unknown>[] {
  let toolCalls: ToolCall[] | undefined;
  try {
    toolCalls = parseMessageToolCalls(message);
  } catch (error) {
    throw new ValidationError(`Message ${index}: invalid assistant tool calls`, { cause: error });
  }
  if (toolCalls?.length) requireCapability(profile, "tools", "the history contains assistant tool calls");
  // Tool results are matched to calls by id, so two calls with one id would be ambiguous.
  const callIds = new Set<string>();
  for (const call of toolCalls ?? []) {
    if (callIds.has(call.id)) throw new ValidationError(`Message ${index}: assistant tool calls repeat id ${call.id}`);
    callIds.add(call.id);
  }

  if (message.responsesOutput !== undefined) {
    return replayOutputItems(message, toolCalls ?? [], index, profile);
  }

  const items: Record<string, unknown>[] = [];
  if (message.content || !toolCalls?.length) {
    items.push({ type: "message", role: "assistant", content: message.content });
  }
  for (const call of toolCalls ?? []) {
    items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) });
  }
  return items;
}

/**
 * Replay the provider items of an earlier assistant turn unchanged, with their ids and
 * statuses, as the Responses input schema expects. Reasoning items without encrypted content
 * cannot be resolved without stored state, so they are not replayed; unfinished function
 * calls are never replayed (see {@link parseOutputItems}). Required fields a compatible server
 * left out are filled where their value is known (see `normalizeOutputItem`). `item_reference`
 * items are rejected because they need server-side state. An empty item list (a turn cut off before any output) replays as nothing.
 */
function replayOutputItems(
  message: ResponsesMessage,
  toolCalls: ToolCall[],
  index: number,
  profile: CapabilityProfile,
): Record<string, unknown>[] {
  const output = message.responsesOutput as unknown;
  if (!Array.isArray(output)) {
    throw new ValidationError(`Message ${index}: responsesOutput must be an array of items`);
  }
  for (const item of output) {
    if (item && typeof item === "object" && (item as Record<string, unknown>).type === "item_reference") {
      // An item reference resolves against stored server state, which store: false never has.
      throw new ValidationError(`Message ${index}: responsesOutput must not contain item_reference items in stateless mode`);
    }
  }
  let parsed: ReturnType<typeof parseOutputItems>;
  try {
    parsed = parseOutputItems(output, profile.id);
  } catch (error) {
    throw new ValidationError(`Message ${index}: responsesOutput contains a malformed item`, { cause: error });
  }
  if (parsed.content !== message.content || !sameToolCalls(parsed.toolCalls, toolCalls)) {
    throw new ValidationError(
      `Message ${index}: assistant content or tool calls do not match its responsesOutput items`,
    );
  }

  const items: Record<string, unknown>[] = [];
  for (const item of parsed.replayable) {
    if (item.type === "reasoning") {
      const encrypted = typeof item.encrypted_content === "string" && item.encrypted_content.length > 0;
      if (!encrypted) continue;
      requireCapability(profile, "reasoning", "the history contains encrypted reasoning items");
    }
    // parseOutputItems already filled the known fields a compatible server may omit, such as
    // a message's role and status.
    items.push(structuredClone(item) as Record<string, unknown>);
  }
  return items;
}

function toResponsesTool(tool: ToolSpec, index: number): Record<string, unknown> {
  if (!tool || typeof tool !== "object" || typeof tool.name !== "string" || !tool.name) {
    throw new ValidationError(`Tool ${index} requires a name`);
  }
  if (tool.input_schema !== undefined && (!tool.input_schema || typeof tool.input_schema !== "object" || Array.isArray(tool.input_schema))) {
    throw new ValidationError(`Tool ${tool.name} input_schema must be an object`);
  }
  return {
    type: "function",
    name: tool.name,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    parameters: tool.input_schema ?? { type: "object", properties: {} },
    // The Responses API defaults function tools to strict mode, which rejects ordinary JSON schemas.
    strict: false,
  };
}

function toResponsesToolChoice(choice: string | Record<string, unknown>): string | Record<string, unknown> {
  if (typeof choice === "string") {
    if (!choice) throw new ValidationError("tool_choice must not be empty");
    if (choice === "auto" || choice === "none" || choice === "required") return choice;
    return { type: "function", name: choice };
  }
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    throw new ValidationError("tool_choice must be a string or an object");
  }
  const nested = choice.function as Record<string, unknown> | undefined;
  if (choice.type === "function" && typeof choice.name !== "string" && nested && typeof nested.name === "string") {
    // Chat Completions shape: { type: "function", function: { name } }.
    return { type: "function", name: nested.name };
  }
  return { ...choice };
}

function toTextFormat(format: ResponsesTextFormat): Record<string, unknown> {
  if (!format || typeof format !== "object") throw new ValidationError("responseFormat must be an object");
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    if (typeof format.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(format.name)) {
      throw new ValidationError("responseFormat name must be 1-64 letters, digits, underscores or dashes");
    }
    if (!format.schema || typeof format.schema !== "object" || Array.isArray(format.schema)) {
      throw new ValidationError("responseFormat schema must be an object");
    }
    return {
      type: "json_schema",
      name: format.name,
      schema: format.schema,
      ...(format.description !== undefined ? { description: format.description } : {}),
      ...(format.strict !== undefined ? { strict: format.strict } : {}),
    };
  }
  throw new ValidationError("responseFormat type must be json_schema or json_object");
}

function toReasoning(reasoning: ResponsesReasoningConfig): Record<string, unknown> {
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    throw new ValidationError("reasoning must be an object");
  }
  const result: Record<string, unknown> = {};
  if (reasoning.effort !== undefined) {
    if (typeof reasoning.effort !== "string" || !reasoning.effort) throw new ValidationError("reasoning.effort must be a string");
    result.effort = reasoning.effort;
  }
  if (reasoning.summary !== undefined) {
    if (typeof reasoning.summary !== "string" || !reasoning.summary) throw new ValidationError("reasoning.summary must be a string");
    result.summary = reasoning.summary;
  }
  return result;
}
