import { afterEach, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { generateKeyPairSync, verify, webcrypto } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { kyselyAdapter } from "@superfunctions/db/adapters";
import { WatchFn } from "../../src/core/watch-fn";
import { getWatchFnSchema } from "../../src/storage/schema";
import { getBugIssueSchema, BUG_ISSUES_TABLE } from "../../src/integrations/botfn/schema";
import { GitHubClient } from "../../../../botfn/github-integration/src/api";
import { LinearClient } from "../../../../botfn/linear-integration/src/api";

const originalFetch = globalThis.fetch;
const servers: ReturnType<typeof createServer>[] = [];
const watches: WatchFn[] = [];
const databases: Kysely<any>[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const watch of watches.splice(0)) { await watch.flush().catch(() => {}); await watch.stop(); }
  for (const server of servers.splice(0)) await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  for (const database of databases.splice(0)) await database.destroy();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const bug = (id: string, app = "web") => ({ id, type: "bug_report", timestamp: "2026-10-20T00:00:00Z", app: { name: app, version: "1" }, sessionId: "session", report: { title: "Broken checkout", description: "Details", severity: "high", steps: ["Open", "Pay"], tags: ["checkout"] }, context: { custom: { private: "retained only in canonical storage" } } });
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res).catch(() => { res.statusCode = 500; res.end(); }); });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function body(req: IncomingMessage) { const buffers: Buffer[] = []; for await (const part of req) buffers.push(part); return Buffer.concat(buffers); }
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
async function serveWatch(watch: WatchFn) {
  return serve(async (req, res) => {
    const result = await watch.httpRouter.handle(new Request("http://local" + req.url, { method: req.method, headers: req.headers as HeadersInit, body: await body(req) }));
    res.writeHead(result.status, Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer()));
  });
}
function connect(path: string) {
  const native = new Database(path); native.pragma("journal_mode = WAL"); native.pragma("busy_timeout = 2000");
  const sql = new Kysely<any>({ dialect: new SqliteDialect({ database: native }) }); databases.push(sql);
  const adapter = kyselyAdapter({ db: sql, dialect: "sqlite", schema: { watchfn_events: "watchfn_events", watchfn_bug_issues: "watchfn_bug_issues" } });
  return { sql, adapter };
}
async function database() {
  const directory = await mkdtemp(join(tmpdir(), "watchfn-botfn-")); directories.push(directory);
  const path = join(directory, "watch.sqlite"); const connection = connect(path);
  // Explicit additive application migration; callers never provide adapterSchema.
  for (const [name, table] of Object.entries({ ...getWatchFnSchema(), ...getBugIssueSchema() })) {
    let migration = connection.sql.schema.createTable(name);
    for (const [field, options] of Object.entries(table.fields)) migration = migration.addColumn(field, options.type === "number" ? "integer" : "text", column => field === "id" ? column.primaryKey() : options.required ? column.notNull() : column);
    await migration.execute();
  }
  return { ...connection, path };
}
function watch(adapter: ReturnType<typeof kyselyAdapter>, routes: any[], extra: any = {}) {
  const result = new WatchFn({ name: "issues", storage: "database", database: adapter, infra: { enabled: false }, auth: { apiKey: "server-ingest" }, botfn: { namespace: "tenant-one", routes, ...extra } } as any);
  watches.push(result); result.start(); return result;
}
async function close(sql: Kysely<any>) { databases.splice(databases.indexOf(sql), 1); await sql.destroy(); }
const post = (url: string, value: unknown, key = "server-ingest") => originalFetch(url + "/ingest", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(value) });

it("uses real BotFn GitHub App and Linear clients over HTTP, persists canonical issues and links across SQLite close/reopen", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); vi.stubGlobal("crypto", webcrypto);
  let tokens = 0; let githubCreates = 0; let linearCreates = 0;
  const provider = await serve(async (req, res) => {
    if (req.url === "/github/app/installations/456/access_tokens") {
      tokens++; const jwt = req.headers.authorization!.slice(7); const [header, payload, signature] = jwt.split(".");
      expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature, "base64url"))).toBe(true);
      expect(JSON.parse(Buffer.from(payload, "base64url").toString()).iss).toBe("123");
      json(res, { token: "github-installation-secret" }); return;
    }
    if (req.url === "/github/repos/acme/bugs/issues") {
      expect(req.method).toBe("POST"); expect(req.headers.authorization).toBe("token github-installation-secret");
      const input = JSON.parse((await body(req)).toString()); githubCreates++;
      expect(input.body).toContain("watchfn-bug:"); expect(input.body).not.toContain("retained only");
      json(res, { number: 23, html_url: "https://github.com/acme/bugs/issues/23", body: input.body }, 201); return;
    }
    if (req.url === "/linear/graphql") {
      expect(req.headers.authorization).toBe("linear-secret"); const input = JSON.parse((await body(req)).toString());
      expect(input.query).toContain("mutation WatchFnCreateIssue"); expect(input.variables.teamId).toBe("team-123"); linearCreates++;
      json(res, { data: { issueCreate: { success: true, issue: { id: "issue-456", identifier: "ENG-1", url: "https://linear.app/acme/issue/ENG-1/broken-checkout", description: input.variables.description, team: { id: "team-123" } } } } }); return;
    }
    json(res, { error: "unexpected provider path" }, 404);
  });
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin === "https://api.github.com") return originalFetch(provider + "/github" + url.pathname, init);
    if (url.origin === "https://api.linear.app") return originalFetch(provider + "/linear" + url.pathname, init);
    throw new Error("Unexpected external request");
  });
  let db = await database();
  const routes = [
    { app: "web", target: "github", project: "acme/bugs", client: new GitHubClient({ appId: "123", installationId: "456", privateKey: keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString() }) },
    { app: "mobile", target: "linear", project: "team-123", client: new LinearClient({ apiKey: "linear-secret" }) },
  ];
  let instance = watch(db.adapter, routes); let url = await serveWatch(instance);
  expect((await post(url, bug("gh"), "wrong")).status).toBe(401);
  expect((await post(url, [bug("gh"), bug("linear", "mobile")])).status).toBe(202);
  expect(githubCreates + linearCreates).toBe(0);
  await instance.stop(); await close(db.sql);
  const reopened = connect(db.path); instance = watch(reopened.adapter, routes); url = await serveWatch(instance);
  expect(await instance.getBugIssueStatus({ app: "web", reportId: "gh" })).toMatchObject({ state: "pending" });
  expect(await instance.processBugIssues()).toEqual({ processed: 2 });
  expect({ tokens, githubCreates, linearCreates }).toEqual({ tokens: 1, githubCreates: 1, linearCreates: 1 });
  expect((await post(url, bug("gh"))).status).toBe(202);
  expect((await post(url, { ...bug("gh"), report: { ...bug("gh").report, title: "changed" } })).status).toBe(409);
  await instance.flush().catch(() => {}); await instance.stop(); await close(reopened.sql);
  const final = connect(db.path); instance = watch(final.adapter, routes);
  const events = await instance.query({ metric: "bug_report" }); expect(events).toHaveLength(2);
  expect(events.find((event: any) => event.id === "gh")).toEqual({ ...bug("gh"), integration: { target: "github", project: "acme/bugs", issueId: "23", issueUrl: "https://github.com/acme/bugs/issues/23" } });
  expect(events.find((event: any) => event.id === "linear").integration).toMatchObject({ target: "linear", project: "team-123", issueId: "issue-456" });
  const raw = JSON.stringify(await final.sql.selectFrom(BUG_ISSUES_TABLE).selectAll().execute());
  expect(raw).not.toContain("secret"); expect(raw).not.toContain("PRIVATE KEY");
  expect(await instance.processBugIssues()).toEqual({ processed: 0 });
});

it("atomically rolls back intake and fences two SQLite workers while preserving an unknown HTTP outcome for verified recovery", async () => {
  const db = await database(); const peer = connect(db.path); let creates = 0; let issueBody = ""; let incorrect = false;
  const provider = await serve(async (req, res) => {
    if (req.method === "POST") {
      creates++; issueBody = JSON.parse((await body(req)).toString()).body;
      // The remote commits, then its response is lost. Never retry this create.
      req.socket.destroy(); return;
    }
    json(res, { number: 8, html_url: incorrect ? "https://github.com/other/repo/issues/8" : "https://github.com/acme/bugs/issues/8", body: issueBody });
  });
  // Use actual BotFn client authentication with an already acquired fixture token only in this test;
  // the preceding acceptance verifies issuance and RSA authentication end to end.
  const client = new GitHubClient({ appId: "123", installationId: "456", privateKey: "unused" });
  (client as any).tokenCache = { token: "fixture-token", expiresAt: Date.now() / 1000 + 1000 };
  vi.stubGlobal("fetch", (input: string, init?: RequestInit) => { const url = new URL(input); if (url.origin !== "https://api.github.com") throw new Error("Unexpected host"); return originalFetch(provider + url.pathname, init); });
  const routes = [{ app: "web", target: "github", project: "acme/bugs", client }];
  let instance = watch(db.adapter, routes); const worker = watch(peer.adapter, routes);
  await db.sql.schema.dropTable(BUG_ISSUES_TABLE).execute();
  expect((await post(await serveWatch(instance), bug("missing"))).status).toBe(503);
  expect(await instance.query({})).toEqual([]);
  // Recreate the additive outbox and inject a failure after event insert, proving real rollback.
  let migration = db.sql.schema.createTable(BUG_ISSUES_TABLE);
  for (const [name, field] of Object.entries(getBugIssueSchema()[BUG_ISSUES_TABLE].fields)) migration = migration.addColumn(name, field.type === "number" ? "integer" : "text", column => name === "id" ? column.primaryKey() : field.required ? column.notNull() : column);
  await migration.execute();
  const { sql } = await import("kysely");
  await sql`CREATE TRIGGER reject_bug_outbox BEFORE INSERT ON watchfn_bug_issues BEGIN SELECT RAISE(ABORT, 'outbox rejected'); END`.execute(db.sql);
  expect((await post(await serveWatch(instance), bug("rolledback"))).status).toBe(503);
  expect(await instance.query({})).toEqual([]);
  await sql`DROP TRIGGER reject_bug_outbox`.execute(db.sql);
  await instance.ingest([bug("unknown")]);
  await Promise.all([instance.processBugIssues(), worker.processBugIssues()]);
  expect(creates).toBe(1); const ref = { app: "web", reportId: "unknown" };
  expect(await instance.getBugIssueStatus(ref)).toMatchObject({ state: "reconciliation", attempts: 1 });
  await instance.flush().catch(() => {}); await instance.stop(); await worker.stop(); await close(db.sql); await close(peer.sql);
  const reopened = connect(db.path); instance = watch(reopened.adapter, routes);
  await instance.processBugIssues(); expect(creates).toBe(1);
  incorrect = true; await expect(instance.reconcileBugIssue(ref, "8")).rejects.toThrow("Invalid issue URL");
  incorrect = false; expect(await instance.reconcileBugIssue(ref, "8")).toBe(true);
  expect(await instance.getBugIssueStatus(ref)).toMatchObject({ state: "linked", issueId: "8", attempts: 1 });
  expect((await instance.query({}))[0].integration.issueId).toBe("8");
});
