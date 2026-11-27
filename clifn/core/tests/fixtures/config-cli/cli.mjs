// A minimal CLI over the built package: `node cli.mjs show [--config <path>] [--trust-config] [--json]`.
// It loads config from its working directory under the data-only policy, and `--trust-config` is the explicit,
// non-interactive trust signal a host passes through for an executable `--config` path.
import { parseArgs } from "node:util";

import { loadConfig, resolveRunnerOptions, runAction } from "../../../dist/index.js";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    config: { type: "string" },
    "trust-config": { type: "boolean" },
    json: { type: "boolean" },
  },
});

if (positionals[0] !== "show") {
  process.stderr.write("usage: cli.mjs show [--config <path>] [--trust-config] [--json]\n");
  process.exit(2);
}

const exitCode = await runAction(
  async (flags, ctx) => {
    const loaded = await loadConfig({
      cwd: ctx.cwd,
      configPath: flags.config,
      policy: "data-only",
      trustExecutableConfig: flags["trust-config"] === true,
    });
    ctx.output.info(`loaded ${loaded.path}`);
    return { data: { path: loaded.path, config: loaded.config } };
  },
  values,
  resolveRunnerOptions({ json: values.json, nonInteractive: true })
);

process.exitCode = exitCode;
