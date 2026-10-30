import { DevFnConfigError } from "./errors.js";
import { validateDevFnConfig as validateSchema } from "./schema.js";
import type { DevFnConfig } from "./types.js";

/**
 * Validate a manifest, rejecting setup tasks until this build runs them.
 * The schema drops fields it does not know, so a declared `task` would
 * otherwise start its command as an ordinary process on every `up`,
 * ignoring its rerun contract.
 */
export function validateDevFnConfig(value: unknown): DevFnConfig {
  const config = validateSchema(value);
  const input = value as Record<string, unknown>;
  for (const kind of ["processes", "services"] as const) {
    for (const [name, spec] of Object.entries((input[kind] ?? {}) as Record<string, unknown>)) {
      if (spec && typeof spec === "object" && Object.hasOwn(spec, "task")) {
        throw new DevFnConfigError("DEVFN_CONFIG_INVALID", `${kind}.${name}.task declares a setup task, which this DevFn build cannot run yet.`, `${kind}.${name}.task`);
      }
    }
  }
  return config;
}
