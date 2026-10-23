import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { getDraftDoc, contentfnPublish, contentfnUnpublish } from "../publish/contentfnClient.js";
import { contentfnImport } from "../ops/import.js";
import { contentfnExport } from "../ops/export.js";
import { contentfnAuditEvents } from "../audit/events.js";
import { contentfnAuditWebhooks } from "../audit/webhooks.js";
import type { CmsfnEnvelope } from "cmsfn";

const document = { _id: "drafts.post", _type: "post", _rev: "r1", _createdAt: "2026-10-22T00:00:00.000Z", _updatedAt: "2026-10-22T00:00:00.000Z", _cms: { state: "approved" } };
const artifact = { formatVersion: 1, dataset: "prod", exportedAt: "2026-10-22T00:00:00.000Z", schema: null, publishedDocs: [], draftDocs: [], assets: [], revisions: [] };
const clients: Array<{ name: string; call: (base: string) => Promise<CmsfnEnvelope<unknown>>; result: unknown; invalid: unknown }> = [
  { name: "get", call: base => getDraftDoc({ baseUrl: base }, "prod", "post"), result: document, invalid: { _id: "post", _type: 12 } },
  { name: "publish", call: base => contentfnPublish({ baseUrl: base }, "prod", "post"), result: { ...document, _id: "post" }, invalid: { ...document, _cms: { state: ["approved"] } } },
  { name: "unpublish", call: base => contentfnUnpublish({ baseUrl: base }, "prod", "post"), result: {}, invalid: { unexpected: true } },
  { name: "import", call: base => contentfnImport({ contentfnBaseUrl: base }, { dataset: "prod", artifact }), result: {}, invalid: [] },
  { name: "export", call: base => contentfnExport({ contentfnBaseUrl: base }, "prod"), result: { artifact }, invalid: { artifact: { ...artifact, dataset: "other" } } },
  { name: "events", call: base => contentfnAuditEvents({ contentfnBaseUrl: base }, { dataset: "prod" }), result: { records: [], nextOffset: null }, invalid: { records: [null], nextOffset: null } },
  { name: "webhooks", call: base => contentfnAuditWebhooks({ contentfnBaseUrl: base }, { dataset: "prod" }), result: { deliveries: [], nextCursor: null }, invalid: { deliveries: [], nextCursor: 3 } },
];
async function fixture(run: (base: string, reply: (body: unknown, status?: number, raw?: boolean) => void) => Promise<void>) {
  let body = "{}", status = 200;
  const server = createServer((req, res) => { req.resume(); res.writeHead(status, { "Content-Type": "application/json" }); res.end(body); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  try { await run(`http://127.0.0.1:${address.port}`, (next, code = 200, raw = false) => { body = raw ? String(next) : JSON.stringify(next); status = code; }); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

describe("ContentFn transport validation over owned HTTP", () => {
  for (const client of clients) it(`${client.name}: validates envelope and result and never promotes a transport failure`, async () => fixture(async (base, reply) => {
    reply({ ok: true, result: client.result });
    expect(await client.call(base)).toEqual({ ok: true, result: client.name === "events" ? { events: [], nextCursor: null } : client.result });
    for (const invalid of [null, [], {}, { ok: "true", result: client.result }, { ok: true }, { ok: true, result: client.invalid }, { ok: false, error: null }, { ok: false, error: { code: "CONFLICT", message: {}, details: {} } }]) {
      reply(invalid);
      expect(await client.call(base)).toMatchObject({ ok: false, error: { code: "CONTENTFN_UNAVAILABLE" } });
    }
    reply("not json", 502, true);
    expect(await client.call(base)).toMatchObject({ ok: false, error: { code: "CONTENTFN_UNAVAILABLE" } });
    reply({ ok: true, result: client.result }, 500);
    expect(await client.call(base)).toMatchObject({ ok: false, error: { code: "CONTENTFN_UNAVAILABLE" } });
    for (const status of [200, 403]) {
      reply({ ok: false, error: { code: "PERMISSION_DENIED", message: "Denied", details: { dataset: "prod" } } }, status);
      expect(await client.call(base)).toEqual({ ok: false, error: { code: "PERMISSION_DENIED", message: ["events", "webhooks"].includes(client.name) ? "ContentFn audit request failed" : "Denied", details: { ...(["events", "webhooks"].includes(client.name) ? {} : { dataset: "prod" }), upstreamStatus: status } } });
      reply({ ok: false, error: { code: "REV_CONFLICT", message: "Conflict", details: { expectedRev: "r1" } } }, status);
      expect(await client.call(base)).toMatchObject({ ok: false, error: { code: "CONFLICT", details: { upstreamCode: "REV_CONFLICT", ...(["events", "webhooks"].includes(client.name) ? {} : { expectedRev: "r1" }) } } });
      reply({ ok: false, error: { code: "FUTURE_CODE", message: "Unavailable", details: { upstreamCode: "spoofed" } } }, status);
      expect(await client.call(base)).toMatchObject({ ok: false, error: { code: "CONTENTFN_UNAVAILABLE", details: { upstreamCode: "FUTURE_CODE" } } });
    }
  }));

  it("rejects a different document identity and closed upstream connections", async () => {
    let closedBase = "";
    await fixture(async (base, reply) => {
      closedBase = base;
      reply({ ok: true, result: { ...document, _id: "drafts.other" } });
      expect(await getDraftDoc({ baseUrl: base }, "prod", "post")).toMatchObject({ ok: false });
      reply({ ok: true, result: { ...document, _id: "other" } });
      expect(await contentfnPublish({ baseUrl: base }, "prod", "post")).toMatchObject({ ok: false });
    });
    for (const client of clients) expect(await client.call(closedBase)).toEqual({ ok: false, error: { code: "CONTENTFN_UNAVAILABLE", message: ["events", "webhooks"].includes(client.name) ? "ContentFn audit request failed" : "ContentFn request failed", details: {} } });
  });

  it("projects only safe audit metadata and rejects invalid nested shapes or wrong dataset", async () => fixture(async (base, reply) => {
    const event = { id: "e1", dataset: "prod", action: "docs.publish", timestamp: "2026-10-22T00:00:00Z", targetIds: ["prod", "post"], actor: { subject: "user", secret: "private" }, document: { body: "private" }, diff: { rawBody: "private" } };
    reply({ ok: true, result: { records: [event], nextOffset: null } });
    expect(await contentfnAuditEvents({ contentfnBaseUrl: base }, { dataset: "prod" })).toEqual({ ok: true, result: { events: [{ eventId: "e1", dataset: "prod", type: "docs.publish", timestamp: event.timestamp, targetIds: ["prod", "post"], actor: { subject: "user" } }], nextCursor: null } });
    for (const bad of [{ ...event, dataset: "other" }, { ...event, id: 1 }, { ...event, actor: { subject: [] } }, { ...event, targetIds: [1] }]) {
      reply({ ok: true, result: { records: [bad], nextOffset: null } });
      expect(await contentfnAuditEvents({ contentfnBaseUrl: base }, { dataset: "prod" })).toMatchObject({ ok: false });
    }
    const delivery = { webhookId: "w1", dataset: "prod", url: "https://example.invalid", eventId: "e1", attempt: 1, status: "delivered", updatedAt: "2026-10-22T00:00:00Z" };
    for (const bad of [{ ...delivery, status: "invented" }, { ...delivery, attempt: -1 }, { ...delivery, dataset: "other" }]) {
      reply({ ok: true, result: { deliveries: [bad], nextCursor: null } });
      expect(await contentfnAuditWebhooks({ contentfnBaseUrl: base }, { dataset: "prod" })).toMatchObject({ ok: false });
    }
  }));
});
