import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_PATCH_OPS,
  DEFAULT_MAX_QUERY_LIMIT,
  DEFAULT_MAX_EXPAND_DEPTH,
  DEFAULT_MAX_FILTER_DEPTH,
} from "@contentfn/core";

export interface ContentfnLimits {
  maxPayloadBytes: number;
  maxPatchOps: number;
  maxQueryLimit: number;
  maxExpandDepth: number;
  maxFilterDepth: number;
}

export function resolveLimits(overrides?: Partial<ContentfnLimits>): ContentfnLimits {
  return {
    maxPayloadBytes: overrides?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    maxPatchOps: overrides?.maxPatchOps ?? DEFAULT_MAX_PATCH_OPS,
    maxQueryLimit: overrides?.maxQueryLimit ?? DEFAULT_MAX_QUERY_LIMIT,
    maxExpandDepth: overrides?.maxExpandDepth ?? DEFAULT_MAX_EXPAND_DEPTH,
    maxFilterDepth: overrides?.maxFilterDepth ?? DEFAULT_MAX_FILTER_DEPTH,
  };
}
