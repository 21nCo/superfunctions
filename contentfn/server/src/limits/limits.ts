import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_PATCH_OPS,
  DEFAULT_MAX_QUERY_LIMIT,
  DEFAULT_MAX_EXPAND_DEPTH,
  DEFAULT_MAX_FILTER_DEPTH,
} from "@contentfn/core";

export const DEFAULT_MAX_RICHTEXT_BLOCKS = 5000;

export interface ContentfnLimits {
  maxRichtextBlocks: number;
  maxPayloadBytes: number;
  maxPatchOps: number;
  maxQueryLimit: number;
  maxExpandDepth: number;
  maxFilterDepth: number;
}

export function resolveLimits(overrides?: Partial<ContentfnLimits>): ContentfnLimits {
  const limits = {
    maxRichtextBlocks: overrides?.maxRichtextBlocks ?? DEFAULT_MAX_RICHTEXT_BLOCKS,
    maxPayloadBytes: overrides?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    maxPatchOps: overrides?.maxPatchOps ?? DEFAULT_MAX_PATCH_OPS,
    maxQueryLimit: overrides?.maxQueryLimit ?? DEFAULT_MAX_QUERY_LIMIT,
    maxExpandDepth: overrides?.maxExpandDepth ?? DEFAULT_MAX_EXPAND_DEPTH,
    maxFilterDepth: overrides?.maxFilterDepth ?? DEFAULT_MAX_FILTER_DEPTH,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (name.includes("Depth") ? 0 : 1)) throw new RangeError(`${name} must be a valid nonnegative integer limit`);
  }
  return limits;
}
