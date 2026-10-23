import { createServer, request, type Server } from "node:http";
import { expect, it } from "vitest";
import { createCmsfnServer, type CmsfnServerConfig } from "../index.js";
import { AUDIT_BODY_MAX_BYTES } from "../http/audit.js";
import { AUDIT_RESPONSE_MAX_BYTES } from "../audit/events.js";
import { field, text } from "./responseHelpers.js";
import { contentfnRequest } from "../contentfn/response.js";

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
const records = ["a", "b"].map(id => ({ id, dataset: "prod", action: "docs.publish", actor: { subject: "editor", credential: "hidden" }, targetIds: ["prod", id], timestamp: "2026-10-23T00:00:00Z", document: { secret: "hidden" } }));

it("enforces role and dataset boundaries, cursor identity and trusted upstream headers over HTTP", async () => {
  const seen: Array<{ body: Record<string, unknown>; authorization?: string; subject?: string }> = [];
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += String(chunk);
    const body = JSON.parse(raw) as Record<string, unknown>;
    seen.push({ body, authorization: req.headers.authorization, subject: req.headers["x-subject"] as string | undefined });
    expect(req.url).toBe("/contentfn/audit/query");
    res.setHeader("Content-Type", "application/json");
    const offset = Number(body.offset), limit = Number(body.limit);
    res.end(JSON.stringify({ ok: true, result: { records: records.slice(offset, offset + limit), nextOffset: offset + limit < records.length ? offset + limit : null } }));
  });
  let credentials = 0;
  const allowed = async () => [{ id: "auditor", name: "Auditor", rules: [{ datasets: ["prod"], types: "*" as const, actions: ["audit.read" as const] }] }];
  const config: CmsfnServerConfig = { contentfn: { baseUrl: await listen(upstream) }, datasets: [{ name: "prod" }], desk: { kind: "divider" }, auth: { kind: "custom" }, getRolesForSubject: allowed,
    contentfnAuditHeaders: () => { credentials++; return { authorization: "Bearer service", "x-subject": "trusted-editor" }; } };
  const cms = createCmsfnServer(config);
  try {
    const base = await listen(cms);
    const post = async (body: unknown, path = "events") => (await fetch(`${base}/cmsfn/audit/${path}`, { method: "POST", headers: { authorization: "Bearer browser" }, body: JSON.stringify(body) })).json();
    for (const provider of [undefined, async () => [], async () => { throw new Error("private"); }]) {
      config.getRolesForSubject = provider;
      for (const path of ["events", "webhooks"]) expect(await post({ dataset: "prod" }, path)).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    }
    config.getRolesForSubject = allowed;
    expect(await post({ dataset: "other" })).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    expect(seen).toHaveLength(0); expect(credentials).toBe(0);
    for (const body of [{ dataset: "prod", limit: "1" }, { dataset: "prod", limit: 0 }, { dataset: "prod", limit: 1001 }, { dataset: "prod", cursor: 1 }, { dataset: "prod", cursor: "invalid" }]) expect(await post(body)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    const first = await post({ dataset: "prod", limit: 1 });
    expect(field(first, "result.events")).toEqual([{ eventId: "a", dataset: "prod", type: "docs.publish", timestamp: records[0].timestamp, actor: { subject: "editor" }, targetIds: ["prod", "a"] }]);
    expect(text(field(first, "result.nextCursor"))).toEqual(expect.any(String));
    const second = await post({ dataset: "prod", limit: 1, cursor: text(field(first, "result.nextCursor")) });
    expect(field(second, "result.events.0.eventId")).toBe("b"); expect(field(second, "result.nextCursor")).toBeNull();
    expect(seen.map(row => row.body)).toEqual([0, 1].map(offset => ({ dataset: "prod", limit: 1, offset, order: "desc" })));
    expect(seen.every(row => row.authorization === "Bearer service" && row.subject === "trusted-editor")).toBe(true);
    for (const payload of [{ v: 1, dataset: "other", order: "desc", offset: 1 }, { v: 1, dataset: "prod", order: "asc", offset: 1 }]) expect(await post({ dataset: "prod", cursor: Buffer.from(JSON.stringify(payload)).toString("base64url") })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    config.contentfnAuditHeaders = undefined;
    await post({ dataset: "prod", limit: 1 });
    expect(seen[seen.length - 1]?.authorization).toBeUndefined();
    const raw = (body: string, declared: boolean) => new Promise<unknown>((resolve, reject) => {
      const req = request(`${base}/cmsfn/audit/events`, { method: "POST", headers: declared ? { "Content-Length": Buffer.byteLength(body) } : {} }, res => { let text = ""; res.on("data", chunk => { text += String(chunk); }); res.on("end", () => resolve(JSON.parse(text))); });
      req.on("error", reject); req.end(body);
    });
    for (const body of ["null", "[]", "{", ""]) expect(await raw(body, true)).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    for (const declared of [true, false]) expect(await raw(JSON.stringify({ dataset: "prod", padding: "é".repeat(AUDIT_BODY_MAX_BYTES) }), declared)).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
  } finally { await close(cms); await close(upstream); }
});

it("rejects oversized, malformed, non-progressing and denied upstream pages without an empty success", async () => {
  let body: unknown = {}, status = 200, declared = false;
  const upstream = createServer((req, res) => { req.resume(); const raw = JSON.stringify(body); res.writeHead(status, { "Content-Type": "application/json", ...(declared ? { "Content-Length": Buffer.byteLength(raw) } : {}) }); res.end(raw); });
  const { contentfnAuditEvents } = await import("../audit/events.js");
  try {
    const base = await listen(upstream);
    for (const value of [{ records: [records[0]], nextOffset: 0 }, { records: [records[0]], nextOffset: 10 }, { records: [{ ...records[0], dataset: "other" }], nextOffset: null }, { records: [], nextOffset: 1 }, { records: [{ ...records[0], targetIds: [42] }], nextOffset: null }]) {
      body = { ok: true, result: value };
      expect(await contentfnAuditEvents({ contentfnBaseUrl: base }, { dataset: "prod", limit: 1 })).toMatchObject({ ok: false, error: { code: "CONTENTFN_UNAVAILABLE" } });
    }
    for (const length of [false, true]) {
      declared = length; body = { ok: true, result: { records: [], nextOffset: null }, padding: "é".repeat(AUDIT_RESPONSE_MAX_BYTES) };
      expect(await contentfnAuditEvents({ contentfnBaseUrl: base }, { dataset: "prod" })).toMatchObject({ ok: false, error: { code: "CONTENTFN_UNAVAILABLE" } });
    }
    declared = false; status = 403; body = { ok: false, error: { code: "PERMISSION_DENIED", message: "private document body", details: { document: "private document body", secret: "credential" } } };
    expect(await contentfnAuditEvents({ contentfnBaseUrl: base }, { dataset: "prod" })).toEqual({ ok: false, error: { code: "PERMISSION_DENIED", message: "ContentFn audit request failed", details: { upstreamStatus: 403 } } });
  } finally { await close(upstream); }
});

it("bounds stalled response bodies for transports configured by audit", async () => {
  const upstream = createServer((req, res) => { req.resume(); res.writeHead(200, { "Content-Type": "application/json" }); res.write('{"ok":'); });
  try {
    const base = await listen(upstream);
    expect(await contentfnRequest(base, "/contentfn/audit/query", {}, () => ({}), { maxResponseBytes: 1024, timeoutMs: 30, redirect: "error" })).toMatchObject({ ok: false, error: { code: "CONTENTFN_UNAVAILABLE" } });
  } finally { await close(upstream); }
});


it("does not follow audit redirects with trusted credentials", async () => {
  let received = 0;
  const target = createServer((req, res) => { received++; req.resume(); res.end("{}"); });
  const targetBase = await listen(target);
  const upstream = createServer((req, res) => { req.resume(); res.writeHead(302, { location: targetBase }); res.end(); });
  try {
    const { contentfnAuditEvents } = await import("../audit/events.js");
    expect(await contentfnAuditEvents({ contentfnBaseUrl: await listen(upstream), headers: { "x-private-key": "service" } }, { dataset: "prod" })).toMatchObject({ ok: false });
    expect(received).toBe(0);
  } finally { await close(upstream); await close(target); }
});
