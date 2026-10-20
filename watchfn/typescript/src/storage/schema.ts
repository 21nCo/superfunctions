import { createHash } from "node:crypto";
import type { TableSchema } from "@superfunctions/db";

/** Applications run migrations; WatchFn owns the JSON codec contract. */
export function getWatchFnSchema(tableName = "watchfn_events"): Record<string, TableSchema> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(tableName)) throw new TypeError("Invalid table name");
  const indexPrefix = tableName.length > 35 ? `${tableName.slice(0, 24)}_${createHash("sha256").update(tableName).digest("hex").slice(0, 10)}` : tableName;
  return { [tableName]: { modelName: tableName, fields: {
    id: { type: "string", required: true, unique: true },
    payload: { type: "json", jsonStorageType: "json-text", required: true },
    // Nullable additive columns preserve old rows until the explicit backfill.
    projectionVersion: { type: "number" },
    eventType: { type: "string", maxLength: 255 }, eventApp: { type: "string", maxLength: 255 }, eventTimestamp: { type: "number" },
    eventSeverity: { type: "string", maxLength: 255 }, eventIssueId: { type: "string", maxLength: 255 },
    eventSessionId: { type: "string", maxLength: 255 }, eventReplayId: { type: "string", maxLength: 255 },
  }, indexes: [
    { name: `${indexPrefix}_type_app_time`, fields: ["eventType", "eventApp", "eventTimestamp"] },
    { name: `${indexPrefix}_type_app_severity`, fields: ["eventType", "eventApp", "eventSeverity"] },
    { name: `${indexPrefix}_issue`, fields: ["eventIssueId"] },
    { name: `${indexPrefix}_session`, fields: ["eventSessionId"] },
    { name: `${indexPrefix}_replay`, fields: ["eventReplayId"] },
    { name: `${indexPrefix}_projection`, fields: ["projectionVersion", "id"] },
  ] } };
}
