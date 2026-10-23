import { describe, it, expect, beforeEach, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
import { createHmac } from "node:crypto";
import type { Adapter } from "@superfunctions/db";

const schemaV1 = {
  version: 1,
  documentTypes: [
    {
      name: "post",
      fields: [
        { name: "title", type: { kind: "primitive" as const, type: "string" as const }, required: true },
        { name: "views", type: { kind: "primitive" as const, type: "number" as const }, required: false },
      ],
    },
  ],
};

describe("PHASE_09 webhooks subsystem", () => {
  let server: ReturnType<typeof createContentfnServer>;
  let api: ReturnType<typeof createContentfnServer>["api"];
  let db: Adapter;

  beforeEach(async () => {
    db = memoryAdapter();
    server = createContentfnServer({ db });
    api = server.api;
    await api.datasets.create({ dataset: "prod" });
    await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
  });

  describe("TV-WH-REGISTER-001: register webhook", () => {
    it("registers a webhook and returns webhookId", async () => {
      const res = await api.webhooks.register({
        dataset: "prod",
        url: "https://example.com/hook",
        events: ["doc.published"],
        secret: "shh",
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(typeof res.result.webhookId).toBe("string");
        expect(res.result.webhookId.length).toBeGreaterThan(0);
      }
    });

    it("registered webhook appears in list", async () => {
      const regRes = await api.webhooks.register({
        dataset: "prod",
        url: "https://example.com/hook",
        events: ["doc.published"],
        secret: "shh",
      });

      expect(regRes.ok).toBe(true);
      if (!regRes.ok) return;

      const listRes = await api.webhooks.list({ dataset: "prod" });
      expect(listRes.ok).toBe(true);
      if (listRes.ok) {
        expect(listRes.result.webhooks.length).toBe(1);
        expect(listRes.result.webhooks[0].webhookId).toBe(regRes.result.webhookId);
        expect(listRes.result.webhooks[0].url).toBe("https://example.com/hook");
        expect(listRes.result.webhooks[0].events).toEqual(["doc.published"]);
      }
    });
  });

  describe("TV-WH-REGISTER-002: invalid webhook url", () => {
    it("returns VALIDATION_FAILED for invalid URL", async () => {
      const res = await api.webhooks.register({
        dataset: "prod",
        url: "not-a-url",
        events: ["doc.published"],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("VALIDATION_FAILED");
        expect(res.error.details.path).toBe("url");
      }
    });
  });

  describe("webhook delete", () => {
    it("deletes a webhook", async () => {
      const regRes = await api.webhooks.register({
        dataset: "prod",
        url: "https://example.com/hook",
        events: ["doc.published"],
      });

      expect(regRes.ok).toBe(true);
      if (!regRes.ok) return;

      const delRes = await api.webhooks.delete({
        dataset: "prod",
        webhookId: regRes.result.webhookId,
      });

      expect(delRes.ok).toBe(true);

      const listRes = await api.webhooks.list({ dataset: "prod" });
      expect(listRes.ok).toBe(true);
      if (listRes.ok) {
        expect(listRes.result.webhooks.length).toBe(0);
      }
    });

    it("returns WEBHOOK_NOT_FOUND for missing webhook", async () => {
      const res = await api.webhooks.delete({
        dataset: "prod",
        webhookId: "missing-wh",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("WEBHOOK_NOT_FOUND");
      }
    });
  });

  describe("TV-WH-DELIVERY-001: publish triggers webhook delivery", () => {
    it("delivers webhook with correct payload and HMAC signature on publish", async () => {
      const receivedRequests: Array<{
        body: string;
        headers: Record<string, string>;
      }> = [];

      const mockFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const bodyStr = typeof init?.body === "string" ? init.body : "";
        const headers: Record<string, string> = {};
        if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
          for (const [k, v] of Object.entries(init.headers)) {
            headers[k.toLowerCase()] = String(v);
          }
        }
        receivedRequests.push({ body: bodyStr, headers });
        return new Response("OK", { status: 200 });
      });

      await api.webhooks.register({
        dataset: "prod",
        url: "https://example.com/hook",
        events: ["doc.published"],
        secret: "shh",
      });

      await api.docs.create({
        dataset: "prod",
        id: "post-3",
        type: "post",
        asDraft: true,
        doc: { title: "Draft" },
      });

      await api.docs.publish({
        dataset: "prod",
        id: "post-3",
      });

      const result = await processQueueWithFetch(db, mockFetch);
      expect(result.delivered).toBe(1);
      expect(receivedRequests.length).toBe(1);

      const req = receivedRequests[0];
      const payload = JSON.parse(req.body);
      expect(payload.eventId).toBeDefined();
      expect(payload.dataset).toBe("prod");
      expect(payload.type).toBe("doc.published");
      expect(payload.timestamp).toBeDefined();
      expect(payload.document._id).toBe("post-3");
      expect(payload.document._type).toBe("post");

      const sigHeader = req.headers["x-contentfn-signature"];
      expect(sigHeader).toBeDefined();
      expect(sigHeader.startsWith("v1=")).toBe(true);

      const expectedSig = createHmac("sha256", "shh")
        .update(req.body, "utf8")
        .digest("hex");
      expect(sigHeader).toBe(`v1=${expectedSig}`);
    });
  });

  describe("retry on failure", () => {
    it("schedules retry with backoff on delivery failure", async () => {
      const mockFetch = vi.fn(async () => {
        return new Response("Internal Server Error", { status: 500 });
      });

      await api.webhooks.register({
        dataset: "prod",
        url: "https://example.com/hook",
        events: ["doc.published"],
      });

      await api.docs.create({
        dataset: "prod",
        id: "post-retry",
        type: "post",
        asDraft: true,
        doc: { title: "Retry test" },
      });

      await api.docs.publish({
        dataset: "prod",
        id: "post-retry",
      });

      const result = await processQueueWithFetch(db, mockFetch);
      expect(result.failed).toBe(1);

      const queueRows = await db.findMany({
        model: "contentfn_webhook_queue",
        where: [{ field: "status", operator: "eq" as const, value: "pending" }],
      });

      expect(queueRows.length).toBe(1);
      const entry = queueRows[0] as { attempt: number; lastError: string; status: string };
      expect(entry.attempt).toBe(1);
      expect(entry.lastError).toBe("HTTP 500");
      expect(entry.status).toBe("pending");
    });
  });

  describe("dataset isolation", () => {
    it("returns DATASET_NOT_FOUND for webhook operations on missing dataset", async () => {
      const regRes = await api.webhooks.register({
        dataset: "missing",
        url: "https://example.com/hook",
        events: ["doc.published"],
      });

      expect(regRes.ok).toBe(false);
      if (!regRes.ok) {
        expect(regRes.error.code).toBe("DATASET_NOT_FOUND");
      }

      const listRes = await api.webhooks.list({ dataset: "missing" });
      expect(listRes.ok).toBe(false);
      if (!listRes.ok) {
        expect(listRes.error.code).toBe("DATASET_NOT_FOUND");
      }
    });
  });

  describe("observability: delivery failure logging", () => {
    it("records failure details in webhook queue without exposing secrets", async () => {
      const mockFetch = vi.fn(async () => {
        throw new Error("Connection refused");
      });

      await api.webhooks.register({
        dataset: "prod",
        url: "https://example.com/hook",
        events: ["doc.published"],
        secret: "super-secret",
      });

      await api.docs.create({
        dataset: "prod",
        id: "post-obs",
        type: "post",
        asDraft: true,
        doc: { title: "Obs test" },
      });

      await api.docs.publish({
        dataset: "prod",
        id: "post-obs",
      });

      await processQueueWithFetch(db, mockFetch);

      const queueRows = await db.findMany({
        model: "contentfn_webhook_queue",
        where: [],
      });

      const failedEntry = (queueRows as Array<{ lastError: string | null; status: string }>)
        .find((r) => r.status === "pending" && r.lastError !== null);

      expect(failedEntry).toBeDefined();
      expect(failedEntry!.lastError).toBe("Webhook request failed");
      expect(failedEntry!.lastError).not.toContain("super-secret");
    });
  });
});

async function processQueueWithFetch(
  db: Adapter,
  fetchFn: typeof globalThis.fetch
): Promise<{ delivered: number; failed: number }> {
  const { processWebhookQueue } = await import("../webhooks/deliver.js");
  const { wrapWithSchema } = await import("@superfunctions/db/schema");
  const { getContentfnSchema } = await import("../storage/schema.js");
  return processWebhookQueue({ db: wrapWithSchema(db, getContentfnSchema()), fetch: fetchFn });
}

it("honors configured attempt ceilings and exposes dataset-scoped failures", async () => {
  const server = createContentfnServer({ db: memoryAdapter(), webhooks: { maxAttempts: 1, timeoutMs: 100 } });
  await server.api.datasets.create({ dataset: "prod" });
  await server.api.datasets.create({ dataset: "other" });
  const hook = await server.api.webhooks.register({ dataset: "prod", url: "https://example.com/hook", events: ["asset.created"], secret: "hidden-secret" });
  expect(hook.ok).toBe(true); if (!hook.ok) return;
  await server.api.assets.upload({ dataset: "prod", filename: "x", contentType: "text/plain", bytesBase64: "eA==" });
  const mock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
  try {
    expect(await server.processWebhookQueue()).toEqual({ delivered: 0, failed: 1 });
    expect(await server.processWebhookQueue()).toEqual({ delivered: 0, failed: 0 });
    expect(mock).toHaveBeenCalledTimes(1);
    const result = await server.api.webhooks.deliveries({ dataset: "prod", webhookId: hook.result.webhookId });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.deliveries).toEqual([expect.objectContaining({ attempt: 1, status: "failed", lastError: "HTTP 503" })]);
    expect(JSON.stringify(result)).not.toContain("hidden-secret");
    expect((await server.api.webhooks.deliveries({ dataset: "other", webhookId: hook.result.webhookId })).ok).toBe(false);
  } finally { mock.mockRestore(); }
});

it("leases active deliveries across workers and recovers expired leases", async () => {
  const db = memoryAdapter();
  const server = createContentfnServer({ db });
  await server.api.datasets.create({ dataset: 'leases' });
  await server.api.webhooks.register({ dataset: 'leases', url: 'https://example.com/hook', events: ['asset.created'] });
  await server.api.assets.upload({ dataset: 'leases', filename: 'x', contentType: 'text/plain', bytesBase64: 'eA==' });
  let release!: () => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { began(); await pending; return new Response(null, { status: 204 }); });
  try {
    const first = server.processWebhookQueue(); await started;
    expect(await createContentfnServer({ db }).processWebhookQueue()).toEqual({ delivered: 0, failed: 0 });
    release(); expect(await first).toEqual({ delivered: 1, failed: 0 });
    expect(mock).toHaveBeenCalledTimes(1);
    await db.updateMany({ model: 'contentfn_webhook_queue', where: [], data: { status: 'processing', nextRunAt: '2000-01-01T00:00:00.000Z' } });
    expect(await server.processWebhookQueue()).toEqual({ delivered: 1, failed: 0 });
    expect(mock).toHaveBeenCalledTimes(2);
  } finally { release(); mock.mockRestore(); await db.close(); }
});
