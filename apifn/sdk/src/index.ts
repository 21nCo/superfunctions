// @apifn/sdk — SDK generation from ApiFn operation catalogs through target adapters.

export * from "./types.js";
export { generateSdk, type GenerateSdkInput } from "./generate.js";
export { validateCatalog } from "./catalog.js";
export { writeSdk, type WriteSdkOptions, type WriteSdkResult } from "./write.js";
export { GENERATOR_NAME, GENERATOR_VERSION } from "./version.js";
export { typescriptTarget, TYPESCRIPT_TARGET_VERSION, type TypeScriptOptions } from "./targets/typescript/index.js";

import { typescriptTarget } from "./targets/typescript/index.js";
import type { SdkTarget } from "./types.js";

/** Targets shipped with this package. */
export const SDK_TARGETS: readonly SdkTarget<any>[] = [typescriptTarget];
