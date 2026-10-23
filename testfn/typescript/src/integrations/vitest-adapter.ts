import { JsonFrameworkAdapter } from "./json-adapter.js";
import { frameworkCli } from "./process.js";
import type { RunOptions } from "../types.js";
export class VitestAdapter extends JsonFrameworkAdapter {
  name = "vitest";
  protected arguments(file: string, options: RunOptions): string[] {
    return [
      frameworkCli("vitest", "vitest", options.cwd),
      "run",
      file,
      "--reporter=json",
      "--maxWorkers=1",
      ...(options.timeout ? [`--testTimeout=${options.timeout}`] : []),
    ];
  }
}
