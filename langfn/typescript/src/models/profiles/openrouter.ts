import { ValidationError } from "../../core/errors.js";
import { defineCapabilityProfile, type CapabilityProfile, type CapabilityProfileOverrides } from "./types.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter Responses API profile. OpenRouter routes to many models, so callers should
 * narrow the defaults to the routed model (for example `{ vision: false }` for a text-only
 * model). OpenRouter's Responses API is stateless, which matches the model's `store: false`.
 */
export function openRouterProfile(overrides: CapabilityProfileOverrides = {}): CapabilityProfile {
  return defineCapabilityProfile({
    tools: true,
    streaming: true,
    structuredOutput: true,
    vision: true,
    reasoning: true,
    ...overrides,
    id: "openrouter",
  });
}

export interface OpenRouterAttribution {
  /** Application URL sent as HTTP-Referer for OpenRouter attribution. */
  referer?: string;
  /** Application name sent as X-Title for OpenRouter attribution. */
  title?: string;
}

/** Optional OpenRouter attribution headers, for the model's `headers` option. */
export function openRouterHeaders(attribution: OpenRouterAttribution = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [field, header] of [["referer", "HTTP-Referer"], ["title", "X-Title"]] as const) {
    const value = attribution[field];
    if (value === undefined) continue;
    // fetch accepts only Latin-1 (ByteString) header values; CR, LF and NUL are never valid.
    if (typeof value !== "string" || !value.trim() || !/^[^\r\n\0\u0100-\uffff]*$/.test(value)) {
      throw new ValidationError(`OpenRouter ${field} must be a non-empty single-line Latin-1 string`);
    }
    headers[header] = value;
  }
  return headers;
}
