import { expect, it } from "vitest";
import { memoryAdapter } from "../../adapters/memory/index.js";
import { transformRecordForRuntime, transformRecordForStorage, wrapWithSchema } from "../schema-codecs.js";
import type { TableSchemaMap } from "../types.js";
const schema: TableSchemaMap = { records: { modelName: "records", fields: { id: { type: "string" }, payload: { type: "json", jsonStorageType: "json-text" } } } };
it("roundtrips JSON values without confusing strings with serialized JSON", () => {
  for (const payload of [{ nested: [1, true, null] }, "null", "123", "{\"a\":1}", false, 0, [], null]) {
    const stored = transformRecordForStorage(schema, "records", { id: "one", payload });
    expect(stored.payload).toBe(payload === null ? null : JSON.stringify(payload));
    expect(transformRecordForRuntime(schema, "records", stored)).toEqual({ id: "one", payload });
  }
  expect(transformRecordForRuntime(schema, "records", { payload: "null" })).toEqual({ payload: null });
  expect(transformRecordForStorage(schema, "records", { id: "selected" })).toEqual({ id: "selected" });
  expect(() => transformRecordForRuntime(schema, "records", { payload: "sensitive corrupt record" })).toThrow("records.payload contains invalid JSON text");
  const native: TableSchemaMap = { records: { modelName: "records", fields: { payload: { type: "json" } } } };
  const value = { payload: { native: true } };
  expect(transformRecordForStorage(native, "records", value)).toBe(value);
});
it("does not double encode repeated function wrappers or adapterSchema compatibility configuration", async () => {
  for (const configured of [false, true]) {
    const base = memoryAdapter(configured ? { adapterSchema: schema } : undefined);
    const db = wrapWithSchema(wrapWithSchema(base, schema), schema);
    try {
      expect(await db.create({ model: "records", data: { id: "one", payload: "{\"literal\":true}" } })).toEqual({ id: "one", payload: "{\"literal\":true}" });
      expect(await db.findOne({ model: "records", where: [{ field: "id", operator: "eq", value: "one" }], select: ["id"] })).toEqual({ id: "one" });
      await db.transaction(async transaction => {
        await transaction.updateMany({ model: "records", where: [{ field: "id", operator: "eq", value: "one" }], data: { payload: { transaction: true } } });
      });
      expect(await db.findOne({ model: "records", where: [{ field: "id", operator: "eq", value: "one" }] })).toEqual({ id: "one", payload: { transaction: true } });
    } finally { await db.close(); }
  }
});
