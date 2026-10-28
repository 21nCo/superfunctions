// The TypeScript fetch target.

import type { SdkTarget } from "../../types.js";
import { CUSTOM_CODE_ROOT, emitTypeScript } from "./emit.js";
import { analyzeOperation } from "./operations.js";
import { resolveTypeScriptOptions, type TypeScriptOptions } from "./options.js";

export type { TypeScriptOptions } from "./options.js";

/** Bumped with any change to generated TypeScript output. */
export const TYPESCRIPT_TARGET_VERSION = "0.1.0";

export const typescriptTarget: SdkTarget<TypeScriptOptions> = {
  id: "typescript",
  version: TYPESCRIPT_TARGET_VERSION,
  customCodeRoot: CUSTOM_CODE_ROOT,
  resolveOptions: resolveTypeScriptOptions,
  packageOf: (options) => ({ name: options.package.name, version: options.package.version }),
  unsupportedReasons: (operation, catalog) => analyzeOperation(operation, catalog).reasons,
  emit: emitTypeScript,
};
