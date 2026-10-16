import { JsonFrameworkAdapter } from "./json-adapter.js";
import { frameworkCli } from "./process.js";
import type { RunOptions } from "../types.js";
export class JestAdapter extends JsonFrameworkAdapter {
  name = "jest";
  protected arguments(file: string, options: RunOptions): string[] {
    return [
      frameworkCli("jest"),
      "--runInBand",
      "--runTestsByPath",
      file,
      "--json",
      ...(options.timeout ? [`--testTimeout=${options.timeout}`] : []),
    ];
  }
}
