import { defineCapabilityProfile, type CapabilityProfile, type CapabilityProfileOverrides } from "./types.js";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * OpenAI Responses API profile. Defaults describe the API surface for current reasoning
 * models; pass overrides for the chosen model (for example `{ reasoning: false }` for a
 * non-reasoning model, or its `contextWindow`).
 */
export function openAIProfile(overrides: CapabilityProfileOverrides = {}): CapabilityProfile {
  return defineCapabilityProfile({
    tools: true,
    streaming: true,
    structuredOutput: true,
    vision: true,
    reasoning: true,
    ...overrides,
    id: "openai",
  });
}
