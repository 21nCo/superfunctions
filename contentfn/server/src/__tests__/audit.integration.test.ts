import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { kyselyAdapter, memoryAdapter } from "@superfunctions/db/adapters";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AuditQuery, AuditRecord, ContentfnEnvelope } from "@contentfn/core";
import { createContentfnServer } from "../server.js";
import { ALL_TABLES } from "../storage/schema.js";
import { runContentfnMigrations } from "../storage/migrate.js";

const schema = { version: 1, documentTypes: [{ name: "post", fields: [{ name: "title", type: { kind: "primitive" as const, type: "string" as const } }] }] };

it("persists authorized audit records with mutations, replays once, and survives database reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "content-audit-"));
  const open = async () => {
    const sqlite = new Database(join(directory, "audit.sqlite"));
    const sql = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database: sqlite }) });
    await runContentfnMigrations({ async createTableIfNotExists(table) {
      let builder = sql.schema.createTable(table.name).ifNotExists();
      for (const [name, column] of Object.entries(table.columns)) builder = builder.addColumn(name, column.type === "number" ? "real" : "text", c => column.primaryKey ? c.primaryKey() : column.nullable ? c : c.notNull());
      await builder.execute();
    } });
    const db = kyselyAdapter({ db: sql, dialect: "sqlite", schema: Object.fromEntries(ALL_TABLES.map(table => [table.name, table.name])) });
    const server = createContentfnServer({ db, context: request => ({ subject: request.headers.get("x-actor") ?? "anonymous" }) });
    return { db, server, sqlite };
  };
  let fixture = await open();
  try {
    const api = fixture.server.forContext({ subject: "operator" });
    expect(await api.datasets.create({ dataset: "prod" })).toMatchObject({ ok: true });
    expect(await api.schema.upsert({ dataset: "prod", schema })).toMatchObject({ ok: true });
    const request = () => new Request("http://local/contentfn/docs/create", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "once", "x-actor": "alice" }, body: JSON.stringify({ dataset: "prod", id: "post", type: "post", doc: { title: "secret body never logged" }, assetId: "ignored-secret-extra" }) });
    const first = await (await fixture.server.router.handle(request())).json();
    expect(first).toMatchObject({ ok: true });
    expect(await (await fixture.server.router.handle(request())).json()).toEqual(first);
    const records = await api.audit.query({ dataset: "prod", action: "docs.create" });
    expect(records).toMatchObject({ ok: true, result: { records: [{ action: "docs.create", actor: { subject: "alice" }, targetIds: ["prod", "post"] }], nextOffset: null } });
    expect(JSON.stringify(records)).not.toContain("secret body");
    expect(JSON.stringify(records)).not.toContain("ignored-secret-extra");
    fixture.sqlite.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON contentfn_audit BEGIN SELECT RAISE(ABORT, 'injected'); END");
    expect(await api.docs.patch({ dataset: "prod", id: "post", ops: [{ op: "set", path: "title", value: "must rollback" }] })).toMatchObject({ ok: false, error: { code: "STORAGE_ERROR" } });
    expect(await api.docs.get({ dataset: "prod", id: "post" })).toMatchObject({ ok: true, result: { title: "secret body never logged" } });
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM contentfn_revisions").get()).toEqual({ n: 1 });
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM contentfn_events").get()).toEqual({ n: 1 });
    fixture.sqlite.exec("DROP TRIGGER fail_audit");
    expect(await api.datasets.delete({ dataset: "prod" })).toMatchObject({ ok: true });
    await fixture.db.close();
    fixture = await open();
    expect(await fixture.server.api.audit.query({ dataset: "prod", action: "docs.create" })).toEqual(records);
    expect(await fixture.server.api.audit.query({ dataset: "prod", action: "datasets.delete" })).toMatchObject({ ok: true, result: { records: [{ actor: { subject: "operator" } }] } });
  } finally { await fixture.db.close(); await rm(directory, { recursive: true, force: true }); }
});

it("serves bounded dataset-scoped queries over real HTTP and authorizes audit access", async () => {
  const db = memoryAdapter();
  const server = createContentfnServer({ db, authorize: (context, action, input) => action !== "audit.query" || (context instanceof Request && context.headers.get("authorization") === "Bearer operator" && input.dataset === "prod") });
  const http = createServer(server.handler);
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const client = { audit: { query: async (input: AuditQuery): Promise<ContentfnEnvelope<{ records: AuditRecord[]; nextOffset: number | null }>> => (await fetch(`${baseUrl}/contentfn/audit/query`, { method: "POST", headers: { authorization: "Bearer operator", "content-type": "application/json" }, body: JSON.stringify(input) })).json() as Promise<ContentfnEnvelope<{ records: AuditRecord[]; nextOffset: number | null }>> } };
  try {
    expect(await server.api.datasets.create({ dataset: "prod" })).toMatchObject({ ok: true });
    expect(await server.api.schema.upsert({ dataset: "prod", schema })).toMatchObject({ ok: true });
    expect(await server.api.datasets.create({ dataset: "other" })).toMatchObject({ ok: true });
    expect(await server.api.audit.query({ dataset: "prod" })).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(await client.audit.query({ dataset: "other" })).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    const first = await client.audit.query({ dataset: "prod", limit: 1 });
    expect(first).toMatchObject({ ok: true, result: { records: [expect.objectContaining({ dataset: "prod" })], nextOffset: 1 } });
    const second = await client.audit.query({ dataset: "prod", limit: 1, offset: 1 });
    expect(second).toMatchObject({ ok: true, result: { records: [expect.objectContaining({ dataset: "prod" })], nextOffset: null } });
    if (first.ok && second.ok) expect(first.result.records[0].id).not.toBe(second.result.records[0].id);
    for (const limit of [0, -1, 1001, 1.5]) expect(await client.audit.query({ dataset: "prod", limit })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(await client.audit.query({ dataset: "prod", offset: -1 })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
  } finally { http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); await db.close(); }
});

it("records scheduled publication atomically under an explicit system actor", async () => {
  const db = memoryAdapter();
  const server = createContentfnServer({ db });
  try {
    await server.api.datasets.create({ dataset: "prod" });
    await server.api.schema.upsert({ dataset: "prod", schema });
    await server.api.docs.create({ dataset: "prod", id: "scheduled", type: "post", doc: { title: "scheduled" }, asDraft: true });
    expect(await server.forContext({ subject: "scheduler-owner" }).docs.schedule({ dataset: "prod", id: "scheduled", publishAt: new Date(0).toISOString() })).toMatchObject({ ok: true });
    expect(await server.processScheduledPublishes()).toEqual({ published: 1, failed: 0 });
    expect(await server.processScheduledPublishes()).toEqual({ published: 0, failed: 0 });
    expect(await server.api.audit.query({ dataset: "prod", action: "docs.publish" })).toMatchObject({ ok: true, result: { records: [{ actor: { subject: "system:scheduler" }, targetIds: expect.arrayContaining(["prod", "scheduled"]) }] } });
  } finally { await db.close(); }
});


it("supports descending timestamps with ascending identity ties and rejects unknown orders", async () => {
  const { wrapWithSchema } = await import("@superfunctions/db");
  const { getContentfnSchema } = await import("../storage/schema.js");
  const raw = memoryAdapter();
  const db = wrapWithSchema(raw, getContentfnSchema());
  const server = createContentfnServer({ db: raw });
  try {
    for (const [id, timestamp] of [["old", "2026-10-22T00:00:00Z"], ["b", "2026-10-23T00:00:00Z"], ["a", "2026-10-23T00:00:00Z"]]) {
      await db.create({ model: "contentfn_audit", data: { id, dataset: "prod", action: "docs.publish", actor: null, targetIds: [id], timestamp } });
    }
    const first = await server.api.audit.query({ dataset: "prod", order: "desc", limit: 2 });
    expect(first).toMatchObject({ ok: true, result: { records: [{ id: "a" }, { id: "b" }], nextOffset: 2 } });
    expect(await server.api.audit.query({ dataset: "prod", order: "desc", limit: 2, offset: 2 })).toMatchObject({ ok: true, result: { records: [{ id: "old" }], nextOffset: null } });
    expect(await server.api.audit.query({ dataset: "prod" })).toMatchObject({ ok: true, result: { records: [{ id: "old" }, { id: "a" }, { id: "b" }] } });
    for (const order of ["DESC", "invalid", null, 1]) {
      const response = await server.router.handle(new Request("http://local/contentfn/audit/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataset: "prod", order }) }));
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    }
  } finally { await raw.close(); }
});
