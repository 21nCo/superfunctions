/**
 * ContentFn default limits (SPEC.md Limits / caps).
 * Deployments MAY override via config.limits.
 */

export const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576; // 1 MiB
export const DEFAULT_MAX_PATCH_OPS = 100;
export const DEFAULT_MAX_QUERY_LIMIT = 100;
export const DEFAULT_MAX_EXPAND_DEPTH = 3;
export const DEFAULT_MAX_FILTER_DEPTH = 10;
