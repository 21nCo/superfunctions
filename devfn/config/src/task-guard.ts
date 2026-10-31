import path from "node:path";

import { DevFnConfigError } from "./errors.js";
import { validateDevFnConfig as validateSchema } from "./schema.js";
import type { DevFnConfig, TaskSpec } from "./types.js";

type RecordValue = Record<string, unknown>;

function fail(message: string, field: string): never {
  throw new DevFnConfigError("DEVFN_CONFIG_INVALID", message, field);
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) fail(`${field} must be an integer between ${min} and ${max}.`, field);
  return value as number;
}

function taskInputs(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(`${field} must be an array.`, field);
  const inputs = value.map((item, index) => {
    if (typeof item !== "string" || item.trim() === "") fail(`${field}[${index}] must be a non-empty string.`, `${field}[${index}]`);
    if (path.isAbsolute(item) || item.split(/[\\/]+/).includes("..")) throw new DevFnConfigError("DEVFN_CONFIG_PATH_ESCAPE", `${field}[${index}] must stay inside the repository.`, `${field}[${index}]`);
    return item;
  });
  if (new Set(inputs).size !== inputs.length) fail(`${field} must name each entry once.`, field);
  return inputs;
}

function taskSpec(value: unknown, field: string): TaskSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object.`, field);
  const input = value as RecordValue;
  const rerun = input.rerun ?? "on-change";
  if (rerun !== "on-change" && rerun !== "always" && rerun !== "once") fail(`${field}.rerun must be on-change, always or once.`, `${field}.rerun`);
  if (input.idempotent !== undefined && typeof input.idempotent !== "boolean") fail(`${field}.idempotent must be a boolean.`, `${field}.idempotent`);
  const idempotent = input.idempotent === true;
  const retries = input.retries === undefined ? 0 : integer(input.retries, `${field}.retries`, 0, 5);
  if (rerun === "always" && !idempotent) fail(`${field}.rerun always requires idempotent: true.`, `${field}.rerun`);
  if (retries > 0 && !idempotent) fail(`${field}.retries requires idempotent: true; a non-idempotent task is never repeated automatically.`, `${field}.retries`);
  const inputs = taskInputs(input.inputs, `${field}.inputs`);
  return {
    rerun, idempotent, retries,
    timeoutMs: input.timeoutMs === undefined ? 600_000 : integer(input.timeoutMs, `${field}.timeoutMs`, 1, 86_400_000),
    ...(inputs ? { inputs } : {}),
  };
}

/**
 * Validate a manifest and its finite setup-task contracts. The schema drops
 * fields it does not know, so `task` is read from the manifest here; a task
 * serves nothing: no ports, readiness probe or persistence, and never public.
 */
export function validateDevFnConfig(value: unknown): DevFnConfig {
  const isRecord = (item: unknown): item is RecordValue => Boolean(item) && typeof item === "object" && !Array.isArray(item);
  const tasks: Array<[kind: "processes" | "services", name: string, task: TaskSpec]> = [];
  // Like the other per-node fields, task contracts are checked after the
  // manifest version and before cross-references between nodes.
  if (isRecord(value) && value.version === 1) {
    for (const kind of ["processes", "services"] as const) {
      if (!isRecord(value[kind])) continue;
      for (const [name, raw] of Object.entries(value[kind])) {
        if (!isRecord(raw) || raw.task === undefined) continue;
        const field = `${kind}.${name}`;
        const task = taskSpec(raw.task, `${field}.task`);
        for (const key of kind === "processes" ? ["ports", "health"] : ["ports", "health", "persistent"]) {
          if (raw[key] !== undefined) fail(`${field}.${key} cannot be declared by a task; a task is ready when it exits successfully.`, `${field}.${key}`);
        }
        if (kind === "processes" && raw.exposure === "public") fail(`${field}.exposure cannot be public for a task; a task serves nothing.`, `${field}.exposure`);
        tasks.push([kind, name, task]);
      }
    }
  }
  const config = validateSchema(value);
  for (const [kind, name, task] of tasks) Object.assign(config[kind]![name]!, { task });
  return config;
}
