/**
 * Unit test: instantiate schema and run migration/validation (Phase 00).
 * No business logic tests yet.
 */

import { describe, it, expect } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import {
  getCompfnSchema,
  getCompfnSchemaMap,
  createSchemaIfSupported,
  getSchemaForAdapter,
} from "../storage/adapter.js";

describe("CompFn schema", () => {
  it("instantiates schema with default namespace", () => {
    const { version, schemas } = getCompfnSchema();
    expect(version).toBe(1);
    expect(schemas).toHaveLength(4);
    const modelNames = schemas.map((s) => s.modelName).sort();
    expect(modelNames).toEqual(["checks", "controls", "evidence", "frameworks"]);
  });

  it("instantiates schema with custom namespace", () => {
    const { schemas } = getCompfnSchema({ namespace: "my_compfn" });
    expect(schemas.length).toBe(4);
    const controls = schemas.find((s) => s.modelName === "controls");
    expect(controls).toBeDefined();
    expect(controls!.indexes?.some((i) => i.name.startsWith("my_compfn_"))).toBe(true);
  });

  it("getCompfnSchemaMap returns TableSchemaMap", () => {
    const map = getCompfnSchemaMap();
    expect(map.controls).toBeDefined();
    expect(map.frameworks).toBeDefined();
    expect(map.evidence).toBeDefined();
    expect(map.checks).toBeDefined();
    expect(map.controls.fields.id.unique).toBe(true);
  });

  it("getSchemaForAdapter returns same map as getCompfnSchemaMap", () => {
    const map = getSchemaForAdapter();
    expect(Object.keys(map)).toEqual(["controls", "frameworks", "evidence", "checks"]);
  });

  it("createSchemaIfSupported runs without error (validate or migrate)", async () => {
    const db = memoryAdapter();
    await db.initialize();
    const result = await createSchemaIfSupported(db, { namespace: "compfn" });
    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
    await db.close();
  });
});

it('does not accept invalid adapter schema validation without an error message', async () => {
  const db = memoryAdapter();
  const result = await createSchemaIfSupported({...db,createSchema:undefined,validateSchema:async()=>({valid:false,errors:[]})});
  expect(result.success).toBe(false);
  expect(result.errors?.[0]).toContain('controls');
});
