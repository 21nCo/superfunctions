// Re-export types from types.ts
export type {
  DatafnSchema,
  DatafnResourceSchema,
  DatafnFieldSchema,
  DatafnRelationSchema,
  DatafnEvent,
  DatafnEventFilter,
  DatafnSignal,
  DatafnHookContext,
  DatafnPlugin,
} from "./types.js";

// Re-export defineSchema helper
export { defineSchema } from "./types.js";

// Re-export error types and helpers
export type { DatafnErrorCode, DatafnError, DatafnEnvelope } from "./errors.js";
export { ok, err } from "./errors.js";

// Re-export schema validation
export { validateSchema } from "./schema.js";

// Re-export DFQL normalization
export { normalizeDfql, dfqlKey } from "./normalize.js";

// Re-export envelope utilities
export { unwrapEnvelope } from "./envelope.js";

export * from "./dfql";

// Re-export KV utilities
export { ensureBuiltinKv, kvId, KV_RESOURCE_NAME } from "./kv.js";

// Re-export join store utilities
export { getJoinStoreKey, getJoinTableName, enumerateJoinStoreKeys } from "./joins.js";

// Re-export system field constants
export { SYSTEM_FIELDS, READONLY_SYSTEM_FIELDS } from "./system-fields.js";

// Re-export schema index utilities
export {
  type SchemaIndex,
  buildSchemaIndex,
  getResource,
  getField,
  getRelationsFrom,
  getRelation,
  getRelationTarget,
} from "./schema-index.js";

// Re-export filter evaluation
export { type FilterEvalOptions, evaluateFilter } from "./filters.js";

// Re-export sort utilities
export { type SortTerm, parseSortTerms, sortRecords } from "./sort.js";

// Re-export select token parsing
export { type SelectToken, parseSelectToken } from "./select.js";

// Re-export date conversion utilities
export {
  toEpochMs,
  fromEpochMs,
  coerceDateFieldsToEpoch,
  parseDateFieldsToDate,
} from "./date.js";

// Re-export plugin hook runner
export {
  type HookError,
  type BeforeHookResult,
  runBeforeHook,
  runAfterHook,
} from "./hooks.js";
