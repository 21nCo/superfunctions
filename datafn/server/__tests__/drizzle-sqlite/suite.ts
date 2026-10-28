/**
 * Conformance suite for `@datafn/server` on the Drizzle adapter with
 * `dialect: "sqlite"`. The same cases run on better-sqlite3 under Node and on
 * Cloudflare D1 under workerd so both drivers keep identical behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { drizzleAdapter } from "@superfunctions/db/adapters/drizzle";
import { toHono } from "@superfunctions/http-hono";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { createDatafnServer } from "../../src/index.js";
import { isDatafnE2eeEnvelope } from "@datafn/core";
import {
  allTables,
  conformanceSchema,
  createTableStatements,
  legacyJsonUpgradeSql,
  resourceTables,
} from "./fixture.js";

export interface SqliteHarness {
  /** Drizzle database created with `{ schema: drizzleSchema }`. */
  db: unknown;
  /** Runs DDL, one statement per entry. */
  exec(statements: string[]): Promise<void>;
  /** Reads rows straight from the driver, bypassing DataFn. */
  all(sql: string): Promise<Record<string, unknown>[]>;
  close(): Promise<void> | void;
}

type Json = Record<string, any>;

interface Started {
  server: Awaited<ReturnType<typeof createDatafnServer>>;
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }>;
}

export function describeDrizzleSqliteConformance(
  driver: string,
  createHarness: () => Promise<SqliteHarness>,
): void {
  describe(`@datafn/server + drizzleAdapter({ dialect: "sqlite" }) on ${driver}`, () => {
    let harness: SqliteHarness;
    let started: Started[] = [];

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      // Let each server drain before its database goes away.
      await Promise.all(started.map((app) => app.server.close()));
      started = [];
      await harness.close();
    });

    /** Serves DataFn over the harness database the way the Workers deploy guide wires it. */
    async function serve(): Promise<Started> {
      const server = await createDatafnServer({
        schema: conformanceSchema,
        db: drizzleAdapter({ db: harness.db, dialect: "sqlite" }),
        authorize: async () => true,
        allowUnknownResources: true,
        rest: true,
      });
      const app = new Hono();
      app.route("/", toHono(server.router));
      const handle: Started = {
        server,
        async call(method, path, body) {
          const response = await app.fetch(
            new Request(`http://datafn.test${path}`, {
              method,
              headers: body === undefined ? undefined : { "Content-Type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
            }),
          );
          return { status: response.status, body: (await response.json()) as Json };
        },
      };
      started.push(handle);
      return handle;
    }

    async function start(tables: SQLiteTable[] = allTables): Promise<Started> {
      await harness.exec(createTableStatements(tables));
      return serve();
    }

    const count = async (table: string) =>
      Number((await harness.all(`SELECT count(*) AS n FROM "${table}"`))[0]?.n ?? 0);

    function insertTask(id: string, title: string, priority: number, extra: Json = {}) {
      return {
        resource: "task",
        version: 1,
        operation: "insert",
        id,
        clientId: "seed",
        mutationId: `seed-${id}`,
        record: { title, priority, done: false, ...extra },
      };
    }

    async function seedTasks(app: Started) {
      const pushed = await app.call("POST", "/datafn/push", {
        clientId: "seed",
        mutations: [
          insertTask("task:a", "Alpha", 3),
          insertTask("task:b", "Bravo", 1, { done: true }),
          insertTask("task:c", "Charlie", 3),
          insertTask("task:d", "Delta", 2),
          insertTask("task:e", "Echo", 5, { done: true }),
        ],
      });
      expect(pushed.status).toBe(200);
      expect(pushed.body.result.ok).toBe(true);
    }

    describe("schema init", () => {
      it("serves status against a freshly migrated database without writing rows", async () => {
        const app = await start();
        const status = await app.call("GET", "/datafn/status");
        expect(status.status).toBe(200);
        expect(status.body.ok).toBe(true);
        expect(await count("task")).toBe(0);
        expect(await count("__datafn_changes")).toBe(0);
      });

      it("creates internal tables on first write when only resource tables were migrated", async () => {
        const app = await start(resourceTables);
        const before = await harness.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '__datafn_*' ORDER BY name`);
        expect(before.map((row) => row.name)).toEqual(["__datafn_join_task_tags"]);

        const res = await app.call("POST", "/datafn/mutation", insertTask("task:a", "Alpha", 1));
        expect(res.status).toBe(200);
        expect(res.body.result.ok).toBe(true);

        const after = await harness.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB '__datafn_*' ORDER BY name`);
        expect(after.map((row) => row.name)).toEqual(
          expect.arrayContaining(["__datafn_changes", "__datafn_idempotency", "__datafn_meta"]),
        );
        const pulled = await app.call("POST", "/datafn/pull", { clientId: "c1", cursor: "0" });
        expect(pulled.body.result.changes.map((change: Json) => change.id)).toEqual(["task:a"]);
      });
    });

    describe("query", () => {
      it("filters, sorts and paginates with offset and keyset cursors", async () => {
        const app = await start();
        await seedTasks(app);

        const filtered = await app.call("POST", "/datafn/query", {
          resource: "task",
          version: 1,
          select: ["id", "title", "priority", "done"],
          filters: { priority: { $gte: 2 }, done: false },
          sort: ["priority:desc", "id:asc"],
        });
        expect(filtered.status).toBe(200);
        expect(filtered.body.result.data).toEqual([
          { id: "task:a", title: "Alpha", priority: 3, done: false },
          { id: "task:c", title: "Charlie", priority: 3, done: false },
          { id: "task:d", title: "Delta", priority: 2, done: false },
        ]);

        const matched = await app.call("POST", "/datafn/query", {
          resource: "task",
          version: 1,
          select: ["id"],
          filters: { id: { $in: ["task:a", "task:c", "task:e"] }, title: { $ne: "Echo" }, projectId: { $is_null: true } },
          sort: ["id:asc"],
        });
        expect(matched.body.result.data).toEqual([{ id: "task:a" }, { id: "task:c" }]);

        const page = await app.call("POST", "/datafn/query", {
          resource: "task",
          version: 1,
          select: ["id"],
          sort: ["priority:asc", "id:asc"],
          limit: 2,
          offset: 1,
          count: true,
        });
        expect(page.body.result.data).toEqual([{ id: "task:d" }, { id: "task:a" }]);
        expect(page.body.result.count).toBe(5);

        const afterCursor = await app.call("POST", "/datafn/query", {
          resource: "task",
          version: 1,
          select: ["id"],
          sort: ["priority:asc", "id:asc"],
          limit: 2,
          cursor: { after: { priority: 3, id: "task:a" } },
        });
        expect(afterCursor.body.result.data).toEqual([{ id: "task:c" }, { id: "task:e" }]);
      });
    });

    describe("mutations", () => {
      it("replays a clientId + mutationId without applying it twice", async () => {
        const app = await start();
        const mutation = insertTask("task:a", "Alpha", 1);
        const first = await app.call("POST", "/datafn/mutation", mutation);
        const replay = await app.call("POST", "/datafn/mutation", mutation);
        expect(first.body).toMatchObject({ ok: true, result: { ok: true, mutationId: "seed-task:a", deduped: false } });
        expect(replay.body).toMatchObject({ ok: true, result: { ok: true, mutationId: "seed-task:a", deduped: true } });
        expect(await count("task")).toBe(1);
        expect(await count("__datafn_changes")).toBe(1);

        const merged = await app.call("POST", "/datafn/mutation", {
          resource: "task",
          version: 1,
          operation: "merge",
          id: "task:a",
          clientId: "c1",
          mutationId: "m-merge",
          record: { title: "Alpha 2" },
        });
        expect(merged.body.result.ok).toBe(true);
        const replayedMerge = await app.call("POST", "/datafn/mutation", {
          resource: "task",
          version: 1,
          operation: "merge",
          id: "task:a",
          clientId: "c1",
          mutationId: "m-merge",
          record: { title: "Alpha 3" },
        });
        expect(replayedMerge.body.result).toMatchObject({ ok: true, deduped: true });
        const rows = await harness.all(`SELECT title FROM task WHERE id = 'task:a'`);
        expect(rows).toEqual([{ title: "Alpha 2" }]);
      });

      it("applies a mutation whose if guard matches and rejects one that does not", async () => {
        const app = await start();
        await app.call("POST", "/datafn/mutation", insertTask("task:a", "Alpha", 1));

        const guarded = await app.call("POST", "/datafn/mutation", {
          resource: "task",
          version: 1,
          operation: "merge",
          id: "task:a",
          clientId: "c1",
          mutationId: "m-guard-ok",
          record: { done: true },
          if: { done: false },
        });
        expect(guarded.status).toBe(200);
        expect(guarded.body.result.ok).toBe(true);

        const rejected = await app.call("POST", "/datafn/mutation", {
          resource: "task",
          version: 1,
          operation: "merge",
          id: "task:a",
          clientId: "c1",
          mutationId: "m-guard-stale",
          record: { title: "Stale" },
          if: { done: false },
        });
        expect(rejected.status).toBe(409);
        expect(rejected.body.error).toMatchObject({ code: "CONFLICT", details: { path: "if" } });

        const rows = await harness.all(`SELECT title, done FROM task WHERE id = 'task:a'`);
        expect(rows).toEqual([{ title: "Alpha", done: 1 }]);
      });

      it("deletes a record and records a delete change", async () => {
        const app = await start();
        await app.call("POST", "/datafn/mutation", insertTask("task:a", "Alpha", 1));
        const deleted = await app.call("POST", "/datafn/mutation", {
          resource: "task",
          version: 1,
          operation: "delete",
          id: "task:a",
          clientId: "c1",
          mutationId: "m-delete",
        });
        expect(deleted.body.result.ok).toBe(true);
        expect(await count("task")).toBe(0);
        const pulled = await app.call("POST", "/datafn/pull", { clientId: "c2", cursor: "0" });
        expect(pulled.body.result.changes.map((change: Json) => change.op)).toEqual(["upsert", "delete"]);
      });
    });

    describe("relations", () => {
      it("resolves many-one references and relates many-many tags", async () => {
        const app = await start();
        const seeded = await app.call("POST", "/datafn/push", {
          clientId: "seed",
          mutations: [
            { resource: "project", version: 1, operation: "insert", id: "project:p1", clientId: "seed", mutationId: "s-p1", record: { name: "Launch" } },
            { resource: "tag", version: 1, operation: "insert", id: "tag:x", clientId: "seed", mutationId: "s-x", record: { label: "urgent" } },
            { resource: "tag", version: 1, operation: "insert", id: "tag:y", clientId: "seed", mutationId: "s-y", record: { label: "later" } },
            insertTask("task:a", "Alpha", 1, { projectId: "project:p1" }),
          ],
        });
        expect(seeded.body.result.ok).toBe(true);

        const related = await app.call("POST", "/datafn/mutation", {
          resource: "task",
          version: 1,
          operation: "relate",
          id: "task:a",
          clientId: "c1",
          mutationId: "m-relate",
          relations: { tags: [{ $ref: "tag:x" }, { $ref: "tag:y" }] },
        });
        expect(related.body.result.ok).toBe(true);

        const unrelated = await app.call("POST", "/datafn/mutation", {
          resource: "task",
          version: 1,
          operation: "unrelate",
          id: "task:a",
          clientId: "c1",
          mutationId: "m-unrelate",
          relations: { tags: [{ $ref: "tag:y" }] },
        });
        expect(unrelated.body.result.ok).toBe(true);

        const result = await app.call("POST", "/datafn/query", {
          resource: "task",
          version: 1,
          select: ["id", "project.*", "tags.*"],
          filters: { id: "task:a" },
        });
        expect(result.status).toBe(200);
        const [row] = result.body.result.data;
        expect(row.project).toMatchObject({ id: "project:p1", name: "Launch" });
        expect(row.tags.map((tagRow: Json) => tagRow.id)).toEqual(["tag:x"]);
        expect(await count("__datafn_join_task_tags")).toBe(1);
      });
    });

    describe("sync", () => {
      it("clones, pulls from a cursor and deduplicates a replayed push", async () => {
        const app = await start();
        await seedTasks(app);

        const cloned = await app.call("POST", "/datafn/clone", { clientId: "c1", tables: ["task"] });
        expect(cloned.status).toBe(200);
        const clonedIds = cloned.body.result.data.task.map((row: Json) => row.id).sort();
        expect(clonedIds).toEqual(["task:a", "task:b", "task:c", "task:d", "task:e"]);
        const cursor = cloned.body.result.cursors.task;
        expect(cursor).toBe("5");

        const push = {
          clientId: "c2",
          mutations: [
            { resource: "task", version: 1, operation: "merge", id: "task:a", clientId: "c2", mutationId: "p1", record: { done: true } },
            { resource: "task", version: 1, operation: "delete", id: "task:b", clientId: "c2", mutationId: "p2" },
          ],
        };
        const pushed = await app.call("POST", "/datafn/push", push);
        expect(pushed.body.result).toMatchObject({ ok: true, applied: ["p1", "p2"], cursorBefore: "5", cursor: "7" });
        const replayed = await app.call("POST", "/datafn/push", push);
        expect(replayed.body.result).toMatchObject({ ok: true, applied: ["p1", "p2"] });
        expect(await count("__datafn_changes")).toBe(7);

        const pulled = await app.call("POST", "/datafn/pull", { clientId: "c1", cursor, limit: 1 });
        expect(pulled.body.result.changes).toHaveLength(1);
        expect(pulled.body.result.changes[0]).toMatchObject({ id: "task:a", op: "upsert" });
        const rest = await app.call("POST", "/datafn/pull", {
          clientId: "c1",
          cursor: pulled.body.result.nextCursor,
        });
        expect(rest.body.result.changes).toEqual([expect.objectContaining({ id: "task:b", op: "delete" })]);
        expect(rest.body.result.nextCursor).toBe("7");
      });
    });

    describe("concurrency", () => {
      it("gives concurrent writers on separate servers distinct server sequence numbers", async () => {
        const first = await start();
        // A second server over the same database behaves like a second Worker
        // isolate: it shares no in-process lock with the first.
        const second = await serve();
        const writes = Array.from({ length: 12 }, (_, n) =>
          (n % 2 === 0 ? first : second).call("POST", "/datafn/mutation", insertTask(`task:${n}`, `Task ${n}`, n)),
        );
        const results = await Promise.all(writes);
        expect(results.map((res) => res.body.result?.ok)).toEqual(Array(12).fill(true));

        const seqs = (await harness.all(`SELECT server_seq FROM __datafn_changes ORDER BY server_seq`)).map(
          (row) => Number(row.server_seq),
        );
        expect(seqs).toEqual(Array.from({ length: 12 }, (_, n) => n + 1));
      });
    });

    describe("REST wrappers", () => {
      it("creates through POST and reads through GET with booleans and JSON intact", async () => {
        const app = await start();
        const meta = { labels: ["edge", "d1"], estimate: { hours: 2 } };
        const labels = ["edge", 2, { nested: true }];
        const created = await app.call("POST", "/datafn/resources/task", {
          operation: "insert",
          id: "task:r",
          clientId: "c1",
          mutationId: "rest-1",
          record: { title: "Rest", priority: 4, done: true, meta, labels },
        });
        expect(created.status).toBe(200);
        expect(created.body).toMatchObject({ ok: true, result: { ok: true, affectedIds: ["task:r"] } });

        const q = encodeURIComponent(
          JSON.stringify({ select: ["id", "title", "done", "meta", "labels"], filters: { priority: 4, done: true } }),
        );
        const read = await app.call("GET", `/datafn/resources/task?q=${q}`);
        expect(read.status).toBe(200);
        expect(read.body.result.data).toEqual([{ id: "task:r", title: "Rest", done: true, meta, labels }]);
        // Storage stays plain SQLite: 0/1 integers and JSON text.
        expect(await harness.all(`SELECT done, meta, labels FROM task WHERE id = 'task:r'`)).toEqual([
          { done: 1, meta: JSON.stringify(meta), labels: JSON.stringify(labels) },
        ]);
      });
    });

    describe("column storage", () => {
      const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
      const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

      it("keeps E2EE envelopes in boolean and object fields as ciphertext that decrypts", async () => {
        const app = await start();
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        // Same envelope and plaintext encoding as @datafn/client E2EE.
        async function encrypt(value: unknown) {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const plaintext = new TextEncoder().encode(JSON.stringify({ value }));
          const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext));
          return { __datafnE2ee: 1, alg: "AES-GCM", keyRef: "key-1", iv: toBase64(iv), data: toBase64(data) };
        }
        async function decrypt(envelope: Json) {
          expect(isDatafnE2eeEnvelope(envelope)).toBe(true);
          const iv = fromBase64(envelope.iv);
          const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, fromBase64(envelope.data));
          return JSON.parse(new TextDecoder().decode(plaintext)).value;
        }

        const done = await encrypt(false);
        const meta = await encrypt({ secret: "plan" });
        const pushed = await app.call("POST", "/datafn/push", {
          clientId: "seed",
          mutations: [insertTask("task:s", "Secret", 1, { done, meta })],
        });
        expect(pushed.body.result.ok).toBe(true);

        // Storage keeps the ciphertext instead of coercing the envelope to 1.
        expect(await harness.all(`SELECT done, meta FROM task WHERE id = 'task:s'`)).toEqual([
          { done: JSON.stringify(done), meta: JSON.stringify(meta) },
        ]);
        const read = await app.call("POST", "/datafn/query", {
          resource: "task",
          version: 1,
          select: ["id", "done", "meta"],
          filters: { id: "task:s" },
        });
        const [record] = read.body.result.data;
        expect(record).toEqual({ id: "task:s", done, meta });
        expect(await decrypt(record.done)).toBe(false);
        expect(await decrypt(record.meta)).toEqual({ secret: "plan" });
      });

      it("fills the JSON default for rows that predate the column and for inserts that omit it", async () => {
        const app = await start();
        await app.call("POST", "/datafn/mutation", insertTask("task:a", "Alpha", 1));
        const [{ __ns }] = await harness.all(`SELECT __ns FROM task`);
        // Leaving the column out applies its DEFAULT, as ALTER TABLE ADD COLUMN does for existing rows.
        await harness.exec([
          `INSERT INTO task (__ns, id, title, priority, done) VALUES ('${String(__ns)}', 'task:old', 'Old', 2, 0)`,
        ]);

        const read = await app.call("POST", "/datafn/query", {
          resource: "task",
          version: 1,
          select: ["id", "status"],
          sort: ["id:asc"],
        });
        expect(read.status).toBe(200);
        expect(read.body.result.data).toEqual([
          { id: "task:a", status: "open" },
          { id: "task:old", status: "open" },
        ]);
        expect(await harness.all(`SELECT status FROM task ORDER BY id`)).toEqual([
          { status: '"open"' },
          { status: '"open"' },
        ]);
      });

      it("reads legacy plain-text JSON values back as the same strings after the documented upgrade", async () => {
        const app = await start();
        await app.call("POST", "/datafn/mutation", insertTask("task:a", "Alpha", 1));
        const [{ __ns }] = await harness.all(`SELECT __ns FROM task`);
        // Values a 0.1.1 schema stored as plain text; several are also valid JSON.
        const legacy = ["123", "true", "null", '"quoted"', "hello", '{"a":1}', "it's"];
        await harness.exec(
          legacy.map(
            (value, n) =>
              `INSERT INTO kv (__ns, id, value) VALUES ('${String(__ns)}', 'kv:${n}', '${value.replaceAll("'", "''")}')`,
          ),
        );
        await harness.exec([legacyJsonUpgradeSql]);

        const read = await app.call("POST", "/datafn/query", {
          resource: "kv",
          version: 1,
          select: ["id", "value"],
          sort: ["id:asc"],
        });
        expect(read.status).toBe(200);
        expect(read.body.result.data).toEqual(legacy.map((value, n) => ({ id: `kv:${n}`, value })));
      });
    });

    describe("transact", () => {
      it("rejects an atomic transact with mutations before writing anything", async () => {
        const app = await start();
        await app.call("POST", "/datafn/mutation", insertTask("task:a", "Alpha", 1));
        const changesBefore = await count("__datafn_changes");
        const idempotencyBefore = await count("__datafn_idempotency");

        const res = await app.call("POST", "/datafn/transact", {
          steps: [
            { mutation: insertTask("task:b", "Bravo", 2) },
            // Duplicate insert fails at execution time; a partial apply would keep task:b.
            { mutation: { ...insertTask("task:a", "Alpha again", 3), mutationId: "dup-a" } },
          ],
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({
          code: "DFQL_UNSUPPORTED",
          details: { path: "atomic" },
        });
        expect(await count("task")).toBe(1);
        expect(await count("__datafn_changes")).toBe(changesBefore);
        expect(await count("__datafn_idempotency")).toBe(idempotencyBefore);
      });

      it("rejects even when every mutation would succeed", async () => {
        const app = await start();
        const res = await app.call("POST", "/datafn/transact", {
          atomic: true,
          steps: [{ mutation: insertTask("task:a", "Alpha", 1) }],
        });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("DFQL_UNSUPPORTED");
        expect(await count("task")).toBe(0);
      });

      it("runs query-only and explicitly non-atomic transacts step by step", async () => {
        const app = await start();
        await app.call("POST", "/datafn/mutation", insertTask("task:a", "Alpha", 1));

        const reads = await app.call("POST", "/datafn/transact", {
          steps: [{ query: { resource: "task", version: 1, select: ["id"] } }],
        });
        expect(reads.status).toBe(200);
        expect(reads.body.result.results[0].data).toEqual([{ id: "task:a" }]);

        const writes = await app.call("POST", "/datafn/transact", {
          atomic: false,
          steps: [
            { mutation: insertTask("task:b", "Bravo", 2) },
            { mutation: { ...insertTask("task:a", "Alpha again", 3), mutationId: "dup-a" } },
          ],
        });
        expect(writes.status).toBe(200);
        expect(writes.body.result.ok).toBe(false);
        expect(writes.body.result.results[0].ok).toBe(true);
        expect(writes.body.result.results[1].ok).toBe(false);
        expect(await count("task")).toBe(2);
      });
    });
  });
}
