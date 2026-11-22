import { LangFnError, ValidationError } from "../../core/errors.js";

/** A feature a request can need from a provider and model. */
export type Capability = "tools" | "streaming" | "structuredOutput" | "vision" | "reasoning";

export const CAPABILITIES: readonly Capability[] = Object.freeze([
  "tools",
  "streaming",
  "structuredOutput",
  "vision",
  "reasoning",
]);

/**
 * What a provider endpoint and model accept. A request that needs a capability the
 * profile lacks fails with {@link UnsupportedCapabilityError} before any network call;
 * nothing is silently dropped. Profiles never select another provider: the caller chooses.
 */
export interface CapabilityProfile {
  /** Stable profile name, also used as the model's provider name by default. */
  readonly id: string;
  /** Function tools, tool choice and tool-result history. */
  readonly tools: boolean;
  /** Server-sent event streaming. */
  readonly streaming: boolean;
  /** JSON schema or JSON object output formats. */
  readonly structuredOutput: boolean;
  /** Image inputs on user messages. */
  readonly vision: boolean;
  /** Reasoning configuration and replay of encrypted reasoning items in stateless history. */
  readonly reasoning: boolean;
  /** Context window in tokens (input plus output); undefined when unknown. */
  readonly contextWindow?: number;
  /** Largest output token budget per response; undefined when unknown. */
  readonly maxOutputTokens?: number;
  /**
   * The route accepts only streamed requests: every request is sent with `stream: true`, and a
   * whole-turn call (`chat()`) reads the stream and returns the finished turn. Needs `streaming`.
   */
  readonly streamOnly?: boolean;
  /** Request options the route refuses; each fails with {@link RouteRestrictionError} before sending. */
  readonly restrictions?: readonly RouteRestriction[];
  /**
   * Input role for system messages: `developer` on a route that refuses `role: "system"` items.
   * Text and order are kept. Defaults to `system`.
   */
  readonly systemRole?: SystemRole;
}

export type SystemRole = "system" | "developer";

/**
 * A request option a route refuses:
 * - `hostedTools`: provider-hosted tools (any tool, tool choice or replayed item that is not a function tool);
 * - `previousResponseId`: `previous_response_id` continuation from a stored response;
 * - `background`: background mode;
 * - `hostedHistory`: server-side history (`conversation`, or `store` other than false);
 * - `outputTokenCap`: `max_output_tokens`, whether set per request or as the model default.
 */
export type RouteRestriction = "hostedTools" | "previousResponseId" | "background" | "hostedHistory" | "outputTokenCap";

export const ROUTE_RESTRICTIONS: readonly RouteRestriction[] = Object.freeze([
  "hostedTools",
  "previousResponseId",
  "background",
  "hostedHistory",
  "outputTokenCap",
]);

export type CapabilityProfileOverrides = Partial<Omit<CapabilityProfile, "id">>;

/** Thrown before a request is sent when it needs a capability the profile does not have. */
export class UnsupportedCapabilityError extends LangFnError {
  readonly capability: Capability;
  readonly profileId: string;

  constructor(capability: Capability, profileId: string, detail?: string) {
    super(
      `Capability "${capability}" is not supported by profile "${profileId}"${detail ? `: ${detail}` : ""}`,
      { code: "UNSUPPORTED_CAPABILITY", provider: profileId, metadata: { capability, profile: profileId } },
    );
    this.capability = capability;
    this.profileId = profileId;
  }
}

/**
 * Thrown before a request is sent when it uses an option its profile's route refuses (see
 * {@link CapabilityProfile.restrictions}), or asks a stream-only route for a non-streamed request.
 */
export class RouteRestrictionError extends LangFnError {
  readonly restriction: RouteRestriction | "streamOnly";
  /** The request option that was refused, such as `previous_response_id` or `tools[0]`. */
  readonly option: string;
  readonly profileId: string;

  constructor(restriction: RouteRestriction | "streamOnly", option: string, profileId: string) {
    super(`Request option ${option} is not accepted by profile "${profileId}" (${restriction})`, {
      code: "ROUTE_RESTRICTION",
      provider: profileId,
      metadata: { restriction, option, profile: profileId },
    });
    this.restriction = restriction;
    this.option = option;
    this.profileId = profileId;
  }
}

function positiveLimit(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ValidationError(`Capability profile ${field} must be a positive safe integer`);
  }
  return value;
}

/** Validate a profile and return a frozen copy. */
export function defineCapabilityProfile(profile: CapabilityProfile): CapabilityProfile {
  if (!profile || typeof profile !== "object") throw new ValidationError("Capability profile must be an object");
  if (typeof profile.id !== "string" || !profile.id.trim()) {
    throw new ValidationError("Capability profile id must be a non-empty string");
  }
  for (const capability of CAPABILITIES) {
    if (typeof profile[capability] !== "boolean") {
      throw new ValidationError(`Capability profile ${capability} must be a boolean`);
    }
  }
  const contextWindow = positiveLimit(profile.contextWindow, "contextWindow");
  const maxOutputTokens = positiveLimit(profile.maxOutputTokens, "maxOutputTokens");
  if (contextWindow !== undefined && maxOutputTokens !== undefined && maxOutputTokens > contextWindow) {
    throw new ValidationError("Capability profile maxOutputTokens cannot exceed contextWindow");
  }
  if (profile.streamOnly !== undefined && typeof profile.streamOnly !== "boolean") {
    throw new ValidationError("Capability profile streamOnly must be a boolean");
  }
  if (profile.streamOnly && !profile.streaming) {
    throw new ValidationError("Capability profile streamOnly needs the streaming capability");
  }
  const restrictions = routeRestrictions(profile.restrictions);
  if (profile.systemRole !== undefined && profile.systemRole !== "system" && profile.systemRole !== "developer") {
    throw new ValidationError('Capability profile systemRole must be "system" or "developer"');
  }
  return Object.freeze({
    id: profile.id,
    tools: profile.tools,
    streaming: profile.streaming,
    structuredOutput: profile.structuredOutput,
    vision: profile.vision,
    reasoning: profile.reasoning,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(profile.streamOnly ? { streamOnly: true } : {}),
    ...(restrictions.length ? { restrictions: Object.freeze(restrictions) } : {}),
    ...(profile.systemRole === "developer" ? { systemRole: "developer" as const } : {}),
  });
}

function routeRestrictions(value: unknown): RouteRestriction[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ValidationError("Capability profile restrictions must be an array");
  const result: RouteRestriction[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const restriction: unknown = value[index];
    if (!ROUTE_RESTRICTIONS.includes(restriction as RouteRestriction)) {
      throw new ValidationError(`Capability profile restriction ${index} is not one of ${ROUTE_RESTRICTIONS.join(", ")}`);
    }
    if (!result.includes(restriction as RouteRestriction)) result.push(restriction as RouteRestriction);
  }
  return result;
}

export function requireCapability(profile: CapabilityProfile, capability: Capability, detail?: string): void {
  if (!profile[capability]) throw new UnsupportedCapabilityError(capability, profile.id, detail);
}
