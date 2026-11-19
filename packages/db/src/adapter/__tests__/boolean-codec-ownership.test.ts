import { expect, it } from "vitest";
import { memoryAdapter } from "../../adapters/memory/index.js";
import { wrapWithSchema } from "../schema-codecs.js";
import type { TableSchemaMap } from "../types.js";

it.each([undefined, "native"] as const)("retains integer boolean ownership through %s schema", async booleanStorageType => {
  const schema: TableSchemaMap = { records: { modelName: "records", fields: {
    id: { type: "string" }, active: { type: "boolean", booleanStorageType: "integer" },
  } } };
  const native: TableSchemaMap = { records: { modelName: "records", fields: {
    active: { type: "boolean", ...(booleanStorageType ? { booleanStorageType } : {}) },
  } } };
  const raw = memoryAdapter();
  const owner = wrapWithSchema(raw, schema);
  const db = wrapWithSchema(wrapWithSchema(owner, native), schema);
  try {
    await owner.create({ model: "records", data: { id: "one", active: true } });
    expect(await db.findMany({ model: "records", where: [{ field: "active", operator: "eq", value: true }] }))
      .toEqual([{ id: "one", active: true }]);
    await db.transaction(async tx => {
      await tx.updateMany({ model: "records", where: [{ field: "id", operator: "eq", value: "one" }], data: { active: false } });
    });
    expect(await owner.findMany({ model: "records" })).toEqual([{ id: "one", active: false }]);
    expect(await raw.findMany({ model: "records" })).toEqual([{ id: "one", active: 0 }]);
  } finally { await db.close(); }
});
