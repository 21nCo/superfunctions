import { expect, it } from "vitest";
import { createServer } from "node:http";
import { contentfnAuditWebhooks } from "../audit/webhooks.js";
import { cursorFor } from "../audit/events.js";

it("validates webhook pages, binds cursor kind/dataset, retains unknown history, and sends only trusted headers", async () => {
  const record = { id: "q1", webhookId: "w1", eventId: "e1", dataset: "prod", url: "https://user:password@example.test/hook?token=secret#fragment", status: "processing", attempt: 2, lastError: null, timestampKnown: false, updatedAt: null };
  let reply: unknown = { ok: true, result: { records: [record], nextOffset: 1 } };
  const seen: Array<{ body: unknown; credential: string | undefined }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ body: JSON.parse(Buffer.concat(chunks).toString()), credential: req.headers.authorization });
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(reply));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
  const config = { contentfnBaseUrl: `http://127.0.0.1:${address.port}`, headers: { authorization: "Bearer service" } };
  try {
    const first = await contentfnAuditWebhooks(config, { dataset: "prod", limit: 1 });
    expect(first).toMatchObject({ ok: true, result: { deliveries: [{ url: "https://example.test/hook", updatedAt: null, timestampKnown: false, status: "processing" }] } });
    if (!first.ok) throw new Error("Expected page");
    expect(seen[0]).toEqual({ body: { dataset: "prod", limit: 1, offset: 0 }, credential: "Bearer service" });
    reply = { ok: true, result: { records: [], nextOffset: null } };
    expect(await contentfnAuditWebhooks(config, { dataset: "prod", limit: 1, cursor: first.result.nextCursor })).toEqual({ ok: true, result: { deliveries: [], nextCursor: null } });
    expect(seen[1].body).toEqual({ dataset: "prod", limit: 1, offset: 1 });
    for (const cursor of [first.result.nextCursor, cursorFor("prod", 1)]) {
      expect(await contentfnAuditWebhooks(config, { dataset: "other", cursor })).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    }
    expect(await contentfnAuditWebhooks(config, { dataset: "prod", cursor: cursorFor("prod", 1) })).toMatchObject({ ok: false });
    expect(seen).toHaveLength(2);
    for (const result of [
      { records: [record], nextOffset: 2 }, { records: [], nextOffset: 1 },
      { records: [record, record], nextOffset: null },
      ...[{ dataset: "other" }, { timestampKnown: true }, { updatedAt: "invented" }, { attempt: -1 }, { status: "unknown" }, { url: "file:///private" }, { lastError: {} }].map(change => ({ records: [{ ...record, ...change }], nextOffset: null })),
    ]) {
      reply = { ok: true, result };
      expect(await contentfnAuditWebhooks(config, { dataset: "prod", limit: 1 })).toMatchObject({ ok: false, error: { code: "CONTENTFN_UNAVAILABLE" } });
    }
    reply = { ok: false, error: { code: "STORAGE_ERROR", message: "private migration state", details: { secret: "private", reason: "WEBHOOK_AUDIT_NOT_READY" } } };
    const failure = await contentfnAuditWebhooks(config, { dataset: "prod" });
    expect(failure).toMatchObject({ ok: false, error: { details: { reason: "WEBHOOK_AUDIT_NOT_READY" } } }); expect(JSON.stringify(failure)).not.toContain("private");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
