import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { kyselyAdapter, memoryAdapter } from "@superfunctions/db/adapters";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContentfnServer } from "../server.js";
import { wrapWithSchema } from "@superfunctions/db";
import { processWebhookQueue } from "../webhooks/deliver.js";
import { failUnavailableDelivery, markDelivered } from "../storage/webhookQueue.js";
import { getContentfnSchema, ALL_TABLES } from "../storage/schema.js";
import { upgradeWebhookAuditSchema } from "../storage/migrate.js";
import { backfillWebhookAudit, auditDestinationUrl, auditDeliveryError } from "../storage/webhookAudit.js";

it("upgrades schema3 idempotently, rolls back a failed page, resumes after reopen, and preserves unknown history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "content-webhook-audit-"));
  const open = () => {
    const sqlite = new Database(join(directory, "db.sqlite"));
    const sql = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database: sqlite }) });
    const db = kyselyAdapter({ db: sql, dialect: "sqlite", schema: Object.fromEntries(ALL_TABLES.map(t => [t.name, t.name])) });
    return { sqlite, db };
  };
  let fixture = open();
  const server = () => createContentfnServer({ db: fixture.db, webhookAuditWriterSchemaVersion: 4,
    authorize: (_ctx, action, input) => action !== "audit.webhooks" || input.dataset === "prod" });
  try {
    // Real schema3 DDL: none of the new metadata columns exist yet.
    const added = ["dataset", "destinationUrl", "updatedAt", "timestampKnown", "auditMetadataVersion"];
    for (const table of ALL_TABLES) {
      const columns = Object.entries(table.columns).filter(([name]) => table.name !== "contentfn_webhook_queue" || !added.includes(name));
      fixture.sqlite.exec(`CREATE TABLE ${table.name} (${columns.map(([name, c]) => `${name} ${c.type === "number" || c.type === "boolean" ? "INTEGER" : "TEXT"}${c.primaryKey ? " PRIMARY KEY" : ""}${c.nullable ? "" : " NOT NULL"}`).join(",")})`);
    }
    fixture.sqlite.prepare("INSERT INTO contentfn_webhooks VALUES (?, ?, ?, ?, ?, ?, ?)").run("hook", "hook", "prod", "https://user:pass@example.test/hook?token=secret#fragment", "secret", "[]", "2020-01-01T00:00:00Z");
    for (let n = 0; n < 105; n++) fixture.sqlite.prepare("INSERT INTO contentfn_webhook_queue VALUES (?, ?, ?, ?, ?, ?, ?)").run(`q${String(n).padStart(3, "0")}`, `e${n}`, "hook", 2, "2099-01-01T00:00:00Z", "failed", "HTTP 500");
    const ddl = { async addColumnIfNotExists(table: string, name: string, column: { type: string }) {
      const columns = fixture.sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some(c => c.name === name)) fixture.sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${column.type === "number" || column.type === "boolean" ? "INTEGER" : "TEXT"}`);
    } };
    await upgradeWebhookAuditSchema(ddl); await upgradeWebhookAuditSchema(ddl);
    expect(await server().api.audit.webhooks({ dataset: "prod" })).toMatchObject({ ok: false, error: { details: { reason: "WEBHOOK_AUDIT_NOT_READY" } } });
    fixture.sqlite.exec("CREATE TRIGGER fail_backfill BEFORE UPDATE ON contentfn_webhook_queue WHEN NEW.id = 'q001' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(backfillWebhookAudit({ db: fixture.db }, { legacyWritersStopped: true, limit: 2 })).rejects.toThrow();
    expect(fixture.sqlite.prepare("SELECT count(*) AS n FROM contentfn_webhook_queue WHERE auditMetadataVersion = 1").get()).toEqual({ n: 0 });
    fixture.sqlite.exec("DROP TRIGGER fail_backfill");
    const first = await backfillWebhookAudit({ db: fixture.db }, { legacyWritersStopped: true, limit: 50 });
    expect(first).toEqual({ migrated: 50, nextId: "q049", unresolvedIds: [], ready: false });
    // A schema4 worker records a real transition while migration is between pages.
    await markDelivered({ db: wrapWithSchema(fixture.db, getContentfnSchema()) }, "e50", "hook");
    const transition = fixture.sqlite.prepare("SELECT updatedAt FROM contentfn_webhook_queue WHERE id = 'q050'").get() as { updatedAt: string };
    await fixture.db.close(); fixture = open();
    expect(await backfillWebhookAudit({ db: fixture.db }, { legacyWritersStopped: true, afterId: first.nextId!, limit: 100 })).toEqual({ migrated: 55, nextId: null, unresolvedIds: [], ready: true });
    expect(await backfillWebhookAudit({ db: fixture.db }, { legacyWritersStopped: true })).toEqual({ migrated: 0, nextId: null, unresolvedIds: [], ready: true });
    expect(await createContentfnServer({ db: fixture.db }).api.audit.webhooks({ dataset: "prod" })).toMatchObject({ ok: false });
    expect(await server().api.audit.webhooks({ dataset: "other" })).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    for (const input of [{ dataset: "prod", limit: 0 }, { dataset: "prod", limit: 1001 }, { dataset: "prod", offset: -1 }]) {
      expect(await server().api.audit.webhooks(input)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    }
    fixture.sqlite.prepare("UPDATE contentfn_webhook_queue SET lastError = ? WHERE id = 'q000'").run("provider body private-document https://example.test/?token=legacy-secret");
    const response = await server().router.handle(new Request("http://local/contentfn/audit/webhooks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dataset: "prod", limit: 100 }) }));
    const text = await response.text();
    expect(text).not.toMatch(/private-document|legacy-secret/);
    expect(text).toContain("Webhook delivery failed");
    const page = await server().api.audit.webhooks({ dataset: "prod", limit: 100 });
    expect(page).toMatchObject({ ok: true, result: { nextOffset: 100 } });
    if (!page.ok) throw new Error("Expected page");
    expect(page.result.records).toHaveLength(100);
    expect(page.result.records.slice(0, 2)).toMatchObject([{ id: "q050", timestampKnown: true, updatedAt: transition.updatedAt }, { id: "q000", updatedAt: null, timestampKnown: false }]);
    expect(page.result.records[1].lastError).toBe("Webhook delivery failed");
    expect(page.result.records[2].lastError).toBe("HTTP 500");
    expect(page.result.records.every(r => r.url === "https://example.test/hook")).toBe(true);
    expect(JSON.stringify(page)).not.toMatch(/secret|pass|2099/);
    const tail = await server().api.audit.webhooks({ dataset: "prod", offset: 100, limit: 100 });
    expect(tail).toMatchObject({ ok: true, result: { nextOffset: null } });
    if (tail.ok) expect(new Set([...page.result.records, ...tail.result.records].map(r => r.id)).size).toBe(105);
    // Old binaries writing after the barrier are unsupported; an inserted legacy row gates again.
    fixture.sqlite.prepare("INSERT INTO contentfn_webhook_queue (id,eventId,webhookId,attempt,nextRunAt,status,lastError) VALUES ('orphan','missing','deleted',0,'2099-01-01','pending',NULL)").run();
    expect(await backfillWebhookAudit({ db: fixture.db }, { legacyWritersStopped: true })).toEqual({ migrated: 0, nextId: null, unresolvedIds: ["orphan"], ready: false });
    expect(await server().api.audit.webhooks({ dataset: "prod" })).toMatchObject({ ok: false });
    // Explicit reconciliation recovers provenance without inventing a timestamp or deleted URL.
    fixture.sqlite.prepare("INSERT INTO contentfn_events (id,eventId,dataset,type,timestamp) VALUES ('missing','missing','prod','doc.created','2020-01-01')").run();
    expect(await backfillWebhookAudit({ db: fixture.db }, { legacyWritersStopped: true })).toMatchObject({ migrated: 1, ready: true });
    const unknown = await server().api.audit.webhooks({ dataset: "prod", limit: 100 });
    if (!unknown.ok) throw new Error("Expected reconciled page");
    expect(unknown.result.records.find(r => r.id === "orphan")).toMatchObject({ url: null, updatedAt: null, timestampKnown: false });
    expect(await server().api.webhooks.deliveries({ dataset: "prod", webhookId: "deleted" })).toMatchObject({ ok: false });
    fixture.sqlite.prepare("INSERT INTO contentfn_events (id,eventId,dataset,type,timestamp) VALUES ('foreign','foreign','other','doc.created','2020-01-01')").run();
    fixture.sqlite.prepare("INSERT INTO contentfn_webhook_queue (id,eventId,webhookId,attempt,nextRunAt,status,lastError) VALUES ('conflict','foreign','hook',0,'2099-01-01','pending',NULL)").run();
    expect(await backfillWebhookAudit({ db: fixture.db }, { legacyWritersStopped: true })).toMatchObject({ migrated: 0, unresolvedIds: ["conflict"], ready: false });
    expect(await server().api.audit.webhooks({ dataset: "prod" })).toMatchObject({ ok: false });
  } finally { await fixture.db.close(); await rm(directory, { recursive: true, force: true }); }
});

it("redacts destination credentials and query tokens without accepting other protocols", () => {
  expect(auditDestinationUrl("https://user:password@example.test/path?q=token#secret")).toBe("https://example.test/path");
  expect(auditDestinationUrl("file:///secret")).toBeNull();
});


it.each(["configuration", "event"] as const)("reports missing %s as terminal failed without sending or fabricating delivery", async resource => {
  const raw = memoryAdapter();
  const db = wrapWithSchema(raw, getContentfnSchema());
  const server = createContentfnServer({ db: raw, webhookAuditWriterSchemaVersion: 4 });
  try {
    await server.api.datasets.create({ dataset: "prod" });
    await server.api.schema.upsert({ dataset: "prod", schema: { version: 1, documentTypes: [{ name: "post", fields: [] }] } });
    const hook = await server.api.webhooks.register({ dataset: "prod", url: "https://never-contact.invalid/hook", events: ["doc.created"] });
    if (!hook.ok) throw new Error("Expected hook");
    expect(await server.api.docs.create({ dataset: "prod", id: "post", type: "post", doc: {} })).toMatchObject({ ok: true });
    if (resource === "configuration") await server.api.webhooks.delete({ dataset: "prod", webhookId: hook.result.webhookId });
    else await db.deleteMany({ model: "contentfn_events", where: [{ field: "dataset", operator: "eq", value: "prod" }] });
    const before = await server.api.audit.webhooks({ dataset: "prod" });
    if (!before.ok) throw new Error("Expected page");
    const row = before.result.records[0];
    expect(await failUnavailableDelivery({ db, leaseUntil: "2000-01-01T00:00:00Z" }, row.eventId, row.webhookId, resource)).toBe(false);
    let sends = 0;
    const fetch = async () => { sends++; throw new Error("Must not send"); };
    expect(await processWebhookQueue({ db, fetch })).toEqual({ delivered: 0, failed: 1 });
    expect(await processWebhookQueue({ db, fetch })).toEqual({ delivered: 0, failed: 0 });
    expect(sends).toBe(0);
    expect(await server.api.audit.webhooks({ dataset: "prod" })).toMatchObject({ ok: true, result: { records: [{ status: "failed", timestampKnown: true, lastError: `Webhook ${resource} is unavailable; delivery was not attempted` }] } });
  } finally { await raw.close(); }
});


it("projects only exact known failure metadata", () => {
  expect(auditDeliveryError(null)).toBeNull();
  for (const message of ["HTTP 100", "HTTP 599", "Webhook request failed"]) expect(auditDeliveryError(message)).toBe(message);
  for (const message of ["HTTP 503\n", "HTTP 600", "HTTP 503 body secret", "private-document", { token: "secret" }]) expect(auditDeliveryError(message)).toBe("Webhook delivery failed");
});
