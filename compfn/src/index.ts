/**
 * @superfunctions/compfn - Self-hosted compliance function
 * Types, constants, storage schema, and compFn() API (Phase 00 + 01).
 */

export * from "./types.js";
export * from "./constants.js";
export { compFn } from "./compfn.js";
export type { Logger, LogLevel } from "./logger.js";
export { ConsoleLogger, defaultLogger } from "./logger.js";
export type { AdapterCheckInput, AdapterEvidence, EvidenceAdapter } from "./adapters/types.js";
export { createSecfnAdapter } from "./adapters/secfn.js";
export type { SecfnClient, SecfnAdapterConfig } from "./adapters/secfn.js";
export { createAuthfnAdapter } from "./adapters/authfn.js";
export type { AuthfnClient, AuthfnAdapterConfig } from "./adapters/authfn.js";
export { validateCreateControlInput, validateUpdateControlInput } from "./validation.js";
export type { ValidationOutcome, ValidationResult, ValidationFailure } from "./validation.js";
export {
  getCompfnSchema,
  getCompfnSchemaMap,
  getSchemaForAdapter,
  createSchemaIfSupported,
} from "./storage/adapter.js";
export type { CompfnSchemaOptions } from "./storage/adapter.js";
export { loadBundle } from "./bundles/loader.js";
export type { FrameworkBundle, BundleLoadResult } from "./bundles/loader.js";
export { createCompFnRouter } from "./http/routes.js";
