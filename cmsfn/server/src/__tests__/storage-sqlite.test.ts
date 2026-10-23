import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { kyselyAdapter, memoryAdapter } from "@superfunctions/db/adapters";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCmsfnStorageSchema, cmsfnStorageAdapter } from "../storage/schema.js";
import { rolesUpsert, roleById, rolesList, rolesDelete } from "../storage/roles.js";
import { createRelease, getRelease, listReleases, addDocToRelease } from "../storage/releases.js";
import type { CmsfnRole } from "cmsfn";

const role: CmsfnRole = { id: "editor", name: "Éditor", rules: [
  { datasets: ["prod"], types: ["article"], actions: ["doc.read", "doc.patch"] },
] };

for (const legacySchema of [false, true]) {
  describe(`SQLite storage (legacy adapterSchema ${legacySchema})`, () => {
    it("persists JSON and ISO strings across reopen, retaining table isolation and dataset boundaries", async () => {
      const directory = await mkdtemp(join(tmpdir(), "cmsfn-storage-"));
      const path = join(directory, "cms.sqlite");
      let sql: Kysely<any> | undefined;
      const open = () => {
        const database = new Database(path);
        sql = new Kysely({ dialect: new SqliteDialect({ database }) });
        const config = (namespace: string) => ({ db: kyselyAdapter({
          db: sql, dialect: "sqlite",
          schema: { cmsfn_roles: `${namespace}_roles`, cmsfn_releases: `${namespace}_releases` },
          ...(legacySchema ? { adapterSchema: getCmsfnStorageSchema() } : {}),
        }) });
        return { database, first: config("first"), second: config("second") };
      };
      try {
        let opened = open();
        for (const namespace of ["first", "second"]) opened.database.exec(`
          CREATE TABLE ${namespace}_roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, rules TEXT NOT NULL);
          CREATE TABLE ${namespace}_releases (releaseId TEXT PRIMARY KEY, dataset TEXT NOT NULL,
            name TEXT NOT NULL, publishAt TEXT, nextRunAt TEXT, execution TEXT, docIds TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
        `);
        expect(await rolesUpsert(opened.first, { role })).toEqual({ ok: true, result: { role } });
        await rolesUpsert(opened.second, { role: { ...role, name: "Other tenant" } });
        const updated = { ...role, name: "Updated", rules: [...role.rules, { datasets: "*" as const, types: "*" as const, actions: ["doc.publish" as const] }] };
        await rolesUpsert(opened.first, { role: updated });
        expect(opened.database.prepare("SELECT rules FROM first_roles").get()).toEqual({ rules: JSON.stringify(updated.rules) });
        const created = await createRelease(opened.first, { dataset: "prod", name: "Launch", publishAt: "2030-01-01T00:00:00.000Z" });
        if (!created.ok) throw new Error("release creation failed");
        const releaseId = created.result.releaseId;
        expect(await addDocToRelease(opened.first, { dataset: "staging", releaseId, docId: "forbidden" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
        await addDocToRelease(opened.first, { dataset: "prod", releaseId, docId: "z" });
        await addDocToRelease(opened.first, { dataset: "prod", releaseId, docId: "a" });
        await addDocToRelease(opened.first, { dataset: "prod", releaseId, docId: "a" });
        const before = await getRelease(opened.first, { dataset: "prod", releaseId });
        expect(before).toMatchObject({ docIds: ["a", "z"], publishAt: "2030-01-01T00:00:00.000Z" });
        expect(opened.database.prepare("SELECT docIds FROM first_releases").get()).toEqual({ docIds: '["a","z"]' });
        await opened.first.db.close();
        sql = undefined;
        opened = open();
        expect(await roleById(opened.first, "editor")).toEqual(updated);
        expect(await rolesList(opened.first, { dataset: "prod" })).toEqual({ ok: true, result: { roles: [updated] } });
        expect(await roleById(opened.second, "editor")).toMatchObject({ name: "Other tenant", rules: role.rules });
        expect(await getRelease(opened.first, { dataset: "prod", releaseId })).toEqual(before);
        expect(await getRelease(opened.first, { dataset: "staging", releaseId })).toBeNull();
        expect(await getRelease(opened.second, { dataset: "prod", releaseId })).toBeNull();
        expect(await listReleases(opened.first, { dataset: "prod" })).toEqual({ ok: true, result: { releases: [before] } });
        expect(await listReleases(opened.first, { dataset: "staging" })).toEqual({ ok: true, result: { releases: [] } });
        await rolesDelete(opened.first, { roleId: "editor" });
        expect(await roleById(opened.first, "editor")).toBeNull();
        expect(await roleById(opened.second, "editor")).not.toBeNull();
        const unscheduled = await createRelease(opened.first, { dataset: "prod", name: "Later" });
        if (!unscheduled.ok) throw new Error("release creation failed");
        expect(await getRelease(opened.first, { dataset: "prod", releaseId: unscheduled.result.releaseId })).toMatchObject({ publishAt: null, docIds: [] });
      } finally {
        await sql?.destroy();
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
}

it("preserves existing native memory rows and caches wrappers without mutating the supplied adapter", async () => {
  const db = memoryAdapter();
  await db.create({ model: "cmsfn_roles", data: role });
  expect(await roleById({ db }, role.id)).toEqual(role);
  expect(cmsfnStorageAdapter(db)).toBe(cmsfnStorageAdapter(db));
  expect(cmsfnStorageAdapter(db)).not.toBe(db);
  expect(await db.findOne({ model: "cmsfn_roles", where: [{ field: "id", operator: "eq", value: role.id }] })).toEqual(role);
});
