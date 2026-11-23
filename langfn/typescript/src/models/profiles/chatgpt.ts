import { ValidationError } from "../../core/errors.js";
import { defineCapabilityProfile, ROUTE_RESTRICTIONS, type CapabilityProfile } from "./types.js";

/** What a caller may narrow on the Sign in with ChatGPT profile; the route's limits stay fixed. */
export type ChatGPTSignInProfileOverrides = Partial<
  Pick<CapabilityProfile, "tools" | "structuredOutput" | "vision" | "reasoning" | "contextWindow" | "maxOutputTokens">
>;

const FIXED = ["id", "streaming", "streamOnly", "restrictions", "systemRole"] as const;

/**
 * Profile for Sign in with ChatGPT: a ChatGPT plan's OAuth access token on the public
 * `/v1/responses` route (use {@link OPENAI_BASE_URL} with an {@link OAuthTokenSource}). The
 * route's preview limits are fixed: every request streams with `store: false`, system messages
 * are sent as `developer` items, and hosted tools, `previous_response_id`, background mode,
 * server-side history and `max_output_tokens` fail with {@link RouteRestrictionError} before any
 * request. Function tools, structured output, vision and reasoning may be narrowed for the
 * chosen model.
 *
 * A failed plan request never falls back to an API key: the caller switches explicitly.
 */
export function chatGPTSignInProfile(overrides: ChatGPTSignInProfileOverrides = {}): CapabilityProfile {
  if (!overrides || typeof overrides !== "object") throw new ValidationError("chatgpt-signin profile overrides must be an object");
  for (const field of FIXED) {
    if (Object.hasOwn(overrides, field)) {
      throw new ValidationError(`The chatgpt-signin profile fixes ${field}; it cannot be overridden`);
    }
  }
  return defineCapabilityProfile({
    tools: true,
    structuredOutput: true,
    vision: true,
    reasoning: true,
    ...overrides,
    id: "chatgpt-signin",
    streaming: true,
    streamOnly: true,
    restrictions: ROUTE_RESTRICTIONS,
    systemRole: "developer",
  });
}
