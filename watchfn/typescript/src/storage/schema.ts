import type { TableSchema } from "@superfunctions/db";

/** Applications run migrations; WatchFn owns the JSON codec contract. */
export function getWatchFnSchema(tableName = "watchfn_events"): Record<string, TableSchema> {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(tableName)) throw new TypeError("Invalid table name");
  return { [tableName]: { modelName: tableName, fields: {
    id: { type: "string", required: true, unique: true },
    payload: { type: "json", jsonStorageType: "json-text", required: true },
  } } };
}
