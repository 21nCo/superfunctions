import type { TableSchema } from "@superfunctions/db";

export function getCatchFnSchema(tableName = "catchfn_bugs"): Record<string, TableSchema> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(tableName)) throw new TypeError("Invalid table name");
  return { [tableName]: { modelName: tableName, fields: {
    id: { type: "string", required: true, unique: true },
    app: { type: "string", required: true },
    timestamp: { type: "number", required: true },
    receivedAt: { type: "number", required: true },
    severity: { type: "string", required: true },
    tags: { type: "string", required: true },
    sessionId: { type: "string" },
    replayId: { type: "string" },
    issueId: { type: "string" },
    payload: { type: "json", jsonStorageType: "json-text", required: true },
  }, indexes: [
    { name: `${tableName}_app_time`, fields: ["app", "timestamp"] },
    { name: `${tableName}_app_severity`, fields: ["app", "severity"] },
    { name: `${tableName}_session`, fields: ["sessionId"] },
    { name: `${tableName}_replay`, fields: ["replayId"] },
    { name: `${tableName}_issue`, fields: ["issueId"] },
  ] } };
}
