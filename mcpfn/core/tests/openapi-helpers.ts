import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { createSchemaCompiler, type McpFnRequestExtra } from "../src/index.js";
import type {
  OpenApiExecuteRequest,
  OpenApiExecutor,
  OpenApiToolInfo,
} from "../src/openapi/index.js";

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/openapi/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

export interface RecordingExecutor extends OpenApiExecutor {
  calls: OpenApiExecuteRequest[];
}

export function recordingExecutor(): RecordingExecutor {
  const calls: OpenApiExecuteRequest[] = [];
  return {
    calls,
    execute(request) {
      calls.push(request);
      return { content: [{ type: "text", text: "sent" }] };
    },
  };
}

export function requestExtra(signal = new AbortController().signal): McpFnRequestExtra {
  return { signal } as unknown as McpFnRequestExtra;
}

export function tool(tools: OpenApiToolInfo[], name: string): OpenApiToolInfo {
  const found = tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool ${name}; have ${tools.map((entry) => entry.name).join(", ")}`);
  return found;
}

/**
 * Validate sample arguments with mcpFn's own compiler under both engines, so
 * the produced schemas follow mcpFn's draft-07 rules rather than a local copy.
 */
export function expectArguments(
  schema: object,
  samples: { valid?: unknown[]; invalid?: unknown[] },
): void {
  for (const engine of ["ajv", "cfworker"] as const) {
    const validate = createSchemaCompiler(engine).compile(schema);
    for (const sample of samples.valid ?? []) {
      expect(validate(sample), `${engine} accepts ${JSON.stringify(sample)}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
    for (const sample of samples.invalid ?? []) {
      expect(validate(sample), `${engine} rejects ${JSON.stringify(sample)}`).toBe(false);
    }
  }
}
