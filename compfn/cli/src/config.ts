import { readFileSync } from "fs";
import { resolve } from "path";
import type { Adapter } from "@superfunctions/db";
import type { CompFnConfig } from "compfn";

export interface CliConfig extends Omit<CompFnConfig, 'database'> {
  database: Adapter;
}

export async function loadConfig(configPath?: string): Promise<CliConfig> {
  const path = configPath ?? process.env.COMPFN_CONFIG ?? "compfn.config.json";
  const resolvedPath = resolve(path);

  const content = readFileSync(resolvedPath, "utf-8");
  const parsed = JSON.parse(content);

  const databaseType = parsed.database?.type ?? "memory";

  let database: Adapter;
  if (databaseType === "memory") {
    const { memoryAdapter } = await import("@superfunctions/db/adapters");
    database = memoryAdapter({});
  } else {
    throw new Error(`Unsupported database type: ${databaseType}. Please implement adapter loading for ${databaseType}`);
  }

  return {
    database,
    namespace: parsed.namespace,
    systemActorId: parsed.systemActorId,
    readinessWindowDays: parsed.readinessWindowDays,
    evidencePayloadMaxBytes: parsed.evidencePayloadMaxBytes,
    retentionDays: parsed.retentionDays,
    exportMaxBytes: parsed.exportMaxBytes,
    adapters: parsed.adapters,
  };
}
