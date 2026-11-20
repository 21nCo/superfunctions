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
}

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
  return Object.freeze({
    id: profile.id,
    tools: profile.tools,
    streaming: profile.streaming,
    structuredOutput: profile.structuredOutput,
    vision: profile.vision,
    reasoning: profile.reasoning,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  });
}

export function requireCapability(profile: CapabilityProfile, capability: Capability, detail?: string): void {
  if (!profile[capability]) throw new UnsupportedCapabilityError(capability, profile.id, detail);
}
