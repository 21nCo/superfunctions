import { existsSync, readFileSync } from "node:fs";
import { parse as parseDotEnv } from "dotenv";

export interface VariableResolutionInput {
  overrides?: Record<string, string>;
  environment?: Record<string, string>;
  collection?: Record<string, string>;
  processEnv?: NodeJS.ProcessEnv;
}

export interface InterpolationResult {
  value: string;
  warnings: string[];
}

const VARIABLE_PATTERN = /\{\{\s*([^}]+)\s*\}\}/g;

export function loadDotEnvFile(dotEnvPath = ".env"): Record<string, string> {
  if (!existsSync(dotEnvPath)) {
    return {};
  }

  const raw = readFileSync(dotEnvPath, "utf8");
  return parseDotEnv(raw);
}

export function resolveVariableContext(input: VariableResolutionInput): Record<string, string> {
  const resolved: Record<string, string> = {};

  const processEnv = input.processEnv ?? process.env;
  for (const [key, value] of Object.entries(processEnv)) {
    if (typeof value === "string") {
      resolved[key] = value;
    }
  }

  Object.assign(resolved, input.collection ?? {});
  Object.assign(resolved, input.environment ?? {});
  Object.assign(resolved, input.overrides ?? {});

  return resolved;
}

export function interpolateVariables(
  template: string,
  context: Record<string, string>,
  options?: {
    processEnv?: NodeJS.ProcessEnv;
  }
): InterpolationResult {
  const warnings: string[] = [];
  const processEnv = options?.processEnv ?? process.env;

  const value = template.replace(VARIABLE_PATTERN, (fullMatch, variableName) => {
    const key = String(variableName).trim();

    if (key.startsWith("process.env.")) {
      const envVar = key.slice("process.env.".length);
      const resolved = processEnv[envVar];
      if (typeof resolved === "string") {
        return resolved;
      }
      throw new Error(`Environment variable ${envVar} is not set`);
    }

    const resolved = context[key];
    if (resolved !== undefined) {
      return resolved;
    }

    warnings.push(`Unresolved variable: ${key}`);
    return fullMatch;
  });

  return { value, warnings };
}
