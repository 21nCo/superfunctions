import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { kyselyAdapter } from "@superfunctions/db/adapters";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContentfnServer } from "../server.js";
import { ALL_TABLES } from "../storage/schema.js";
import { runContentfnMigrations } from "../storage/migrate.js";

it("persists signed HTTP webhook attempts across SQLite reopen and enforces expired-lease attempt ceilings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "contentfn-hooks-"));
  const received: Array<{ body: string; signature: string | undefined }> = [];
  let responseStatus = 503;
  const receiver = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({ body: Buffer.concat(chunks).toString("utf8"), signature: request.headers["x-contentfn-signature"] as string | undefined });
    response.writeHead(responseStatus); response.end();
  });
  await new Promise<void>(resolve => receiver.listen(0, "127.0.0.1", resolve));
  const address = receiver.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const open = () => {
    const sqlite = new Database(join(directory, "content.sqlite"));
    const sql = new Kysely<Record<string, Record<string, unknown>>>({ dialect: new SqliteDialect({ database: sqlite }) });
    const db = kyselyAdapter({ db: sql, dialect: "sqlite", schema: Object.fromEntries(ALL_TABLES.map(table => [table.name, table.name])) });
    return { sqlite, sql, db, server: createContentfnServer({ db, webhooks: { maxAttempts: 2, timeoutMs: 500 } }) };
  };
  let current!: ReturnType<typeof open>;
  try {
    current = open();
    await runContentfnMigrations({ async createTableIfNotExists(table) {
      let builder = current.sql.schema.createTable(table.name).ifNotExists();
      const keys: string[] = [];
      for (const [name, column] of Object.entries(table.columns)) {
        builder = builder.addColumn(name, column.type === "number" ? "real" : column.type === "boolean" ? "integer" : "text", column.nullable ? undefined : b => b.notNull());
        if (column.primaryKey) keys.push(name);
      }
      if (keys.length) builder = builder.addPrimaryKeyConstraint(`${table.name}_pk`, keys as never[]);
      await builder.execute();
    } });
    const api = current.server.api;
    expect(await api.datasets.create({ dataset: "prod" })).toMatchObject({ ok: true });
    expect(await api.webhooks.register({ dataset: "prod", url: `http://127.0.0.1:${address.port}/hook`, events: ["doc.published"], secret: "fixture-secret" })).toMatchObject({ ok: true });
    expect(await api.schema.upsert({ dataset: "prod", schema: { version: 1, documentTypes: [{ name: "post", fields: [{ name: "title", type: { kind: "primitive", type: "string" }, required: true }] }] } })).toMatchObject({ ok: true });
    expect(await api.docs.create({ dataset: "prod", id: "post", type: "post", doc: { title: "Durable" }, asDraft: true })).toMatchObject({ ok: true });
    expect(await api.docs.publish({ dataset: "prod", id: "post" })).toMatchObject({ ok: true });
    expect(await current.server.processWebhookQueue()).toEqual({ delivered: 0, failed: 1 });
    expect(received).toHaveLength(1);
    const first = received[0];
    expect(first.signature).toBe("v1=" + createHmac("sha256", "fixture-secret").update(first.body).digest("hex"));
    expect(JSON.parse(first.body)).toMatchObject({ dataset: "prod", type: "doc.published", document: { _id: "post", _type: "post" } });
    await current.db.close(); current = open();
    const row = current.sqlite.prepare("SELECT * FROM contentfn_webhook_queue").get() as { status: string; attempt: number; nextRunAt: string };
    expect(row).toMatchObject({ status: "pending", attempt: 1 });
    // Advance only the persisted due time, preserving attempt/status and using real HTTP.
    current.sqlite.prepare("UPDATE contentfn_webhook_queue SET nextRunAt = ?").run("2000-01-01T00:00:00.000Z");
    responseStatus = 204;
    expect(await current.server.processWebhookQueue()).toEqual({ delivered: 1, failed: 0 });
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual(first);
    await current.db.close(); current = open();
    expect(current.sqlite.prepare("SELECT status, attempt FROM contentfn_webhook_queue").get()).toEqual({ status: "delivered", attempt: 2 });
    expect(await current.server.processWebhookQueue()).toEqual({ delivered: 0, failed: 0 });
    // A worker can die after reserving its final attempt, leaving processing state.
    current.sqlite.prepare("UPDATE contentfn_webhook_queue SET status = 'processing', nextRunAt = ?").run("2000-01-01T00:00:00.000Z");
    await current.db.close(); current = open();
    const contender = open();
    try {
      const results = await Promise.all([current.server.processWebhookQueue(), contender.server.processWebhookQueue()]);
      expect(results.reduce((count, result) => count + result.failed, 0)).toBe(1);
      expect(results.every(result => result.delivered === 0)).toBe(true);
    } finally { await contender.db.close(); }
    expect(received).toHaveLength(2);
    expect(current.sqlite.prepare("SELECT status, attempt FROM contentfn_webhook_queue").get()).toEqual({ status: "failed", attempt: 2 });
  } finally {
    await current?.db.close();
    receiver.closeAllConnections();
    await new Promise<void>(resolve => receiver.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
