// The Python asyncio + httpx target.

import type { SdkTarget } from "../../types.js";
import { customCodeRoot, emitPython } from "./emit.js";
import { analyzePythonOperation } from "./operations.js";
import { resolvePythonOptions, type PythonOptions } from "./options.js";

export type { PythonOptions } from "./options.js";

/** Bumped with any change to generated Python output. */
export const PYTHON_TARGET_VERSION = "0.1.3";

export const pythonTarget: SdkTarget<PythonOptions> = {
  id: "python",
  version: PYTHON_TARGET_VERSION,
  // The custom-code directory sits inside the import package, whose name is an option: see customCodeRootFor.
  customCodeRoot: "src/custom/",
  customCodeRootFor: customCodeRoot,
  resolveOptions: resolvePythonOptions,
  packageOf: (options) => ({ name: options.package.name, version: options.package.version }),
  unsupportedReasons: (operation, catalog) => analyzePythonOperation(operation, catalog).reasons,
  emit: emitPython,
};
