import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { handleReleasesCreate, handleReleasesList, handleReleasesAdd, handleReleasesPublish } from "../http/releases.js";
import { createServer, request, type Server } from "node:http";
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { kyselyAdapter } from "@superfunctions/db/adapters";
import type { CmsfnRole } from "cmsfn";
import { createCmsfnServer, type CmsfnServerConfig } from "../index.js";
import { RELEASE_BODY_MAX_BYTES } from "../http/releases.js";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
const role: CmsfnRole = { id: "editor", name: "Editor", rules: [
  { datasets: ["prod"], types: "*", actions: ["release.manage", "doc.publish"] },
] };
const paths = ["create", "list", "add", "publish"];

// Actual Node HTTP framing and SQLite rows, without mocking fetch or storage.
async function fixture(run: (value: {
  config: CmsfnServerConfig; base: string; database: Database.Database;
  upstream: string[]; post: (path: string, body: unknown) => Promise<any>;
}) => Promise<void>) {
  const database = new Database(":memory:");
  database.exec(`CREATE TABLE cmsfn_releases (releaseId TEXT PRIMARY KEY, dataset TEXT NOT NULL,
    name TEXT NOT NULL, publishAt TEXT, docIds TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)`);
  const sql = new Kysely({ dialect: new SqliteDialect({ database }) });
  const upstream: string[] = [];
  const content = createServer((req, res) => {
    upstream.push(req.url!);
    req.resume();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: { _id: "drafts.article", _type: "article", _cms: { state: "approved" } } }));
  });
  const config: CmsfnServerConfig = {
    contentfn: { baseUrl: await listen(content) }, datasets: [{ name: "prod" }, { name: "staging" }],
    desk: { kind: "divider" }, auth: { kind: "custom" },
    db: kyselyAdapter({ db: sql, dialect: "sqlite", schema: { cmsfn_releases: "cmsfn_releases" } }), getRolesForSubject: async () => [role],
  };
  const server = createCmsfnServer(config);
  try {
    const base = await listen(server);
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${base}/cmsfn/releases/${path}`, { method: "POST", body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.json();
    };
    await run({ config, base, database, upstream, post });
  } finally {
    await close(server); await close(content); await sql.destroy();
  }
}

describe("release authorization over HTTP and SQLite", () => {
  it("denies missing, empty, malformed and throwing role providers on every path without disclosure, mutation or upstream calls", async () => fixture(async ({ config, post, database, upstream }) => {
    const created = await post("create", { dataset: "prod", name: "Launch" });
    const releaseId = created.result.releaseId;
    await post("add", { dataset: "prod", releaseId, docId: "article" });
    const rows = () => database.prepare("SELECT * FROM cmsfn_releases").all();
    const before = rows();
    const reads = [vi.spyOn(config.db!, "findMany"), vi.spyOn(config.db!, "findOne")];
    for (const provider of [undefined, async () => [], async () => null as unknown as CmsfnRole[], async () => { throw new Error("private provider detail"); }]) {
      config.getRolesForSubject = provider;
      for (const path of paths) {
        expect(await post(path, { dataset: "prod", name: "Forbidden", releaseId, docId: "other" })).toEqual({
          ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} },
        });
      }
      for (const read of reads) expect(read).not.toHaveBeenCalled();
      expect(rows()).toEqual(before);
      expect(upstream).toEqual([]);
    }
  }));

  it("enforces role datasets, configured datasets and release ownership while retaining permitted publish", async () => fixture(async ({ config, post, database, upstream }) => {
    const created = await post("create", { dataset: "prod", name: "Launch" });
    const releaseId = created.result.releaseId;
    for (const dataset of ["staging", "unconfigured"]) for (const path of paths) {
      expect(await post(path, { dataset, name: "Forbidden", releaseId, docId: "article" })).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    }
    config.getRolesForSubject = async () => [{ ...role, rules: [{ datasets: "*", types: "*", actions: "*" }] }];
    for (const path of paths) expect(await post(path, { dataset: "unconfigured", name: "No", releaseId, docId: "article" })).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    for (const path of ["add", "publish"]) expect(await post(path, { dataset: "staging", releaseId, docId: "article" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await post("list", { dataset: "staging" })).toEqual({ ok: true, result: { releases: [] } });
    expect(upstream).toEqual([]);
    expect(await post("add", { dataset: "prod", releaseId, docId: "article" })).toEqual({ ok: true, result: {} });
    expect(await post("publish", { dataset: "prod", releaseId })).toEqual({ ok: true, result: { releaseId, published: ["article"], failures: [] } });
    expect(upstream).toEqual(["/contentfn/docs/get", "/contentfn/docs/publish"]);
    expect(database.prepare("SELECT count(*) AS count FROM cmsfn_releases").get()).toEqual({ count: 1 });
  }));

  it("converts a per-document authorization failure into a denied document, without publishing", async () => fixture(async ({ config, post, upstream }) => {
    const { result: { releaseId } } = await post("create", { dataset: "prod", name: "Launch" });
    await post("add", { dataset: "prod", releaseId, docId: "article" });
    let calls = 0;
    config.getRolesForSubject = async () => { if (++calls > 1) throw new Error("private detail"); return [role]; };
    expect(await post("publish", { dataset: "prod", releaseId })).toEqual({ ok: true, result: { releaseId, published: [], failures: [{ docId: "article", code: "PERMISSION_DENIED", message: "Permission denied" }] } });
    expect(upstream).toEqual(["/contentfn/docs/get"]);
  }));

  it("rejects malformed and oversized declared/chunked requests on every route and accepts the exact byte boundary", async () => fixture(async ({ base, database }) => {
    const raw = (path: string, body: string, declared: boolean) => new Promise<any>((resolve, reject) => {
      const req = request(`${base}/cmsfn/releases/${path}`, { method: "POST", headers: declared ? { "content-length": Buffer.byteLength(body) } : {} }, res => {
        let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
        res.on("end", () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
      });
      req.on("error", reject); req.write(body); req.end();
    });
    for (const path of paths) {
      for (const body of ["", "{", "null", "[]", "42"]) expect(await raw(path, body, true)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
      for (const declared of [false, true]) expect(await raw(path, JSON.stringify({ dataset: "prod", padding: "é".repeat(RELEASE_BODY_MAX_BYTES / 2) }), declared)).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
    }
    const prefix = '{"dataset":"prod","padding":"';
    const exact = prefix + "x".repeat(RELEASE_BODY_MAX_BYTES - Buffer.byteLength(prefix) - 2) + '"}';
    expect(Buffer.byteLength(exact)).toBe(RELEASE_BODY_MAX_BYTES);
    expect(await raw("list", exact, false)).toEqual({ ok: true, result: { releases: [] } });
    expect(database.prepare("SELECT count(*) AS count FROM cmsfn_releases").get()).toEqual({ count: 0 });
  }));
});

for (const handler of [handleReleasesCreate, handleReleasesList, handleReleasesAdd, handleReleasesPublish]) {
  it(`${handler.name} rejects missing identity configuration or outer veto before consuming any body`, async () => {
    for (const mode of ["missing", "deny", "throw", "truthy"]) {
      const source = Readable.from(["invalid JSON"]);
      Object.assign(source, { headers: {} });
      const iterator = vi.spyOn(source, "iterator");
      const result = await handler({
        releasesStorage: { db: memoryAdapter() }, contentfnBaseUrl: "http://127.0.0.1:1",
        getRolesForSubject: mode === "missing" ? undefined : async () => [role],
        authorizeReleases: mode === "missing" ? undefined : async () => {
          if (mode === "throw") throw new Error("private detail");
          return mode === "truthy" ? "yes" as unknown as boolean : false;
        },
      }, source as unknown as IncomingMessage);
      expect(result).toEqual({ ok: false, error: { code: "PERMISSION_DENIED", message: "Permission denied", details: {} } });
      expect(iterator).not.toHaveBeenCalled();
      source.destroy();
    }
  });
}
