import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { kyselyAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
import { ALL_TABLES } from "../storage/schema.js";
import { runContentfnMigrations } from "../storage/migrate.js";

it("runs transactional CRUD, revisions, publication and rollback with native SQLite", async () => {
  const sqlite = new Database(":memory:");
  const sql = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database: sqlite }) });
  await runContentfnMigrations({ async createTableIfNotExists(table) {
    let builder = sql.schema.createTable(table.name).ifNotExists();
    const keys: string[] = [];
    for (const [name, column] of Object.entries(table.columns)) {
      builder = builder.addColumn(name, column.type === "number" ? "real" : column.type === "boolean" ? "integer" : "text", column.nullable ? undefined : columnBuilder => columnBuilder.notNull());
      if (column.primaryKey) keys.push(name);
    }
    if (keys.length) builder = builder.addPrimaryKeyConstraint(`${table.name}_pk`, keys as never[]);
    await builder.execute();
  } });
  const db = kyselyAdapter({ db: sql, dialect: "sqlite", schema: Object.fromEntries(ALL_TABLES.map(table => [table.name, table.name])) });
  const server = createContentfnServer({ db });
  try {
    expect(await server.api.datasets.create({ dataset: "prod" })).toMatchObject({ ok: true });
    expect(await server.api.schema.upsert({ dataset: "prod", schema: { version: 1, documentTypes: [{ name: "post", fields: [{ name: "title", type: { kind: "primitive", type: "string" }, required: true }] }] } })).toMatchObject({ ok: true });
    const draft = await server.api.docs.create({ dataset: "prod", id: "post", type: "post", doc: { title: "SQLite" }, asDraft: true });
    expect(draft).toMatchObject({ ok: true });
    if (!draft.ok) return;
    expect(await server.api.docs.publish({ dataset: "prod", id: "post", ifRev: draft.result._rev })).toMatchObject({ ok: true, result: { _id: "post", title: "SQLite" } });
    expect(await server.api.docs.publish({ dataset: "prod", id: "post", ifRev: draft.result._rev })).toMatchObject({ ok: false, error: { code: "REV_CONFLICT" } });
    expect(await server.api.docs.query({ dataset: "prod" })).toMatchObject({ ok: true, result: { data: [{ title: "SQLite" }] } });
    expect(await server.api.docs.patch({ dataset: "prod", id: "post", ops: [{ op: "unset", path: "title" }] })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await server.api.docs.get({ dataset: "prod", id: "post" })).toMatchObject({ ok: true, result: { title: "SQLite" } });
    const request = () => new Request("http://local/contentfn/docs/create", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "durable" }, body: JSON.stringify({ dataset: "prod", type: "post", doc: { title: "Once" } }) });
    const first = await (await server.router.handle(request())).json() as { ok: boolean };
    expect(first.ok).toBe(true);
    const restarted = createContentfnServer({ db });
    expect(await (await restarted.router.handle(request())).json()).toEqual(first);
    expect(await server.api.docs.query({ dataset: "prod" })).toMatchObject({ ok: true, result: { data: expect.arrayContaining([expect.objectContaining({ title: "Once" })]) } });
    const longId = '文'.repeat(1000);
    expect(await server.api.docs.create({ dataset: "prod", id: longId, type: "post", doc: { title: "Long public ID" } })).toMatchObject({ ok: true });
    expect(await server.api.docs.get({ dataset: "prod", id: longId })).toMatchObject({ ok: true, result: { _id: longId } });
    const physical = sqlite.prepare('SELECT id FROM contentfn_docs_published WHERE documentId = ?').get(longId) as { id: string };
    expect(physical.id).toMatch(/^[a-f0-9]{64}$/);
    expect(await server.api.datasets.delete({ dataset: "prod" })).toMatchObject({ ok: true });
  } finally { await db.close(); }
});
