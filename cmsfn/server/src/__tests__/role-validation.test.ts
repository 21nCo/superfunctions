import { expect, it, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { rolesUpsert, roleById } from "../storage/roles.js";
import type { CmsfnRole } from "cmsfn";

const role: CmsfnRole = { id: "editor", name: "Editor", rules: [{ datasets: ["prod"], types: "*", actions: ["doc.read"] }] };
it.each([
  { datasets: ["prod", 1], types: "*", actions: ["doc.read"] },
  { datasets: "*", types: [null], actions: "*" },
  { datasets: "*", types: "*", actions: ["doc.read", "doc.superuser"] },
  { datasets: "production", types: "*", actions: "doc.read.extra" },
  { datasets: "*", types: "*", actions: ["*"] },
])("rejects malformed rules before DB access and preserves the stored role", async invalidRule => {
  const db = memoryAdapter();
  await rolesUpsert({ db }, { role });
  const find = vi.spyOn(db, "findOne");
  const create = vi.spyOn(db, "create");
  const update = vi.spyOn(db, "update");
  const result = await rolesUpsert({ db }, { role: { ...role, rules: [invalidRule] } as CmsfnRole });
  expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED", details: { path: expect.stringMatching(/^role.rules\[0\]/) } } });
  expect(find).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(await roleById({ db }, role.id)).toEqual(role);
});
