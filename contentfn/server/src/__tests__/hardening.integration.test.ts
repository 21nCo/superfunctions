import { describe, it, expect, beforeEach, vi } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
import type { Adapter } from "@superfunctions/db";
import type { AuthorizeFn } from "../realtime/server.js";
import type { ContentfnLogEntry } from "../logging/logger.js";
import http from "node:http";

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

function makeRequest(handler: Function, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      await handler(req, res);
    });
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      const bodyStr = body !== undefined ? JSON.stringify(body) : "";
      const options = {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyStr),
        },
      };
      const req = http.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          server.close();
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode!, body: data });
          }
        });
      });
      req.on("error", (e) => {
        server.close();
        reject(e);
      });
      req.write(bodyStr);
      req.end();
    });
  });
}

describe("PHASE_12 hardening: auth, limits, logging, status", () => {
  let db: Adapter;

  describe("TV-AUTH-ALLOW-001: authorize allows operation", () => {
    it("returns document when authorize allows docs.get", async () => {
      db = memoryAdapter();
      const authorize: AuthorizeFn = async (_ctx, _action, _input) => true;
      const server = createContentfnServer({ db, authorize });
      const api = server.api;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
      await api.docs.create({ dataset: "prod", id: "post-1", type: "post", doc: { title: "Hello" } });

      const res = await makeRequest(server.handler, "POST", "/contentfn/docs/get", {
        dataset: "prod",
        id: "post-1",
      });

      expect(res.body.ok).toBe(true);
      expect(res.body.result._id).toBe("post-1");
      expect(res.body.result.title).toBe("Hello");
    });
  });

  describe("TV-AUTH-DENY-001: authorize denies operation", () => {
    it("returns PERMISSION_DENIED when authorize denies docs.get", async () => {
      db = memoryAdapter();
      const authorize: AuthorizeFn = async (_ctx, action, _input) => {
        if (action === "docs.get") return false;
        return true;
      };
      const server = createContentfnServer({ db, authorize });
      const api = server.api;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
      await api.docs.create({ dataset: "prod", id: "post-1", type: "post", doc: { title: "Secret" } });

      const res = await makeRequest(server.handler, "POST", "/contentfn/docs/get", {
        dataset: "prod",
        id: "post-1",
      });

      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
      expect(res.body.result).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain("Secret");
    });

    it("deny-all authorize blocks all endpoints", async () => {
      db = memoryAdapter();
      const authorize: AuthorizeFn = async () => false;
      const server = createContentfnServer({ db, authorize });

      const res = await makeRequest(server.handler, "POST", "/contentfn/datasets/list", {});
      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
    });
  });

  describe("TV-LIMIT-PAYLOAD-001: oversized request payload", () => {
    it("returns PAYLOAD_TOO_LARGE when body exceeds maxPayloadBytes", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db, limits: { maxPayloadBytes: 50 } });

      const bigBody = { dataset: "prod", doc: { title: "x".repeat(100) } };
      const res = await makeRequest(server.handler, "POST", "/contentfn/docs/create", bigBody);

      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
    });
  });

  describe("TV-LIMIT-PATCHOPS-001: too many patch ops", () => {
    it("returns VALIDATION_FAILED when patch has more ops than maxPatchOps via API", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db, limits: { maxPatchOps: 2 } });
      const api = server.api;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
      await api.docs.create({ dataset: "prod", id: "post-1", type: "post", doc: { title: "Hello" } });

      const res = await api.docs.patch({
        dataset: "prod",
        id: "post-1",
        ops: [
          { op: "set", path: "title", value: "A" },
          { op: "set", path: "views", value: 1 },
          { op: "set", path: "title", value: "B" },
        ],
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("VALIDATION_FAILED");
      }
    });

    it("returns VALIDATION_FAILED when patch has more ops than maxPatchOps via HTTP", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db, limits: { maxPatchOps: 2 } });
      const api = server.api;

      await api.datasets.create({ dataset: "prod" });
      await api.schema.upsert({ dataset: "prod", schema: schemaV1 });
      await api.docs.create({ dataset: "prod", id: "post-1", type: "post", doc: { title: "Hello" } });

      const res = await makeRequest(server.handler, "POST", "/contentfn/docs/patch", {
        dataset: "prod",
        id: "post-1",
        ops: [
          { op: "set", path: "title", value: "A" },
          { op: "set", path: "views", value: 1 },
          { op: "set", path: "title", value: "B" },
        ],
      });

      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });
  });

  describe("TV-OBS-LOGGING-001: mutation logs exclude document body", () => {
    it("logs action/dataset/docId but not document body content", async () => {
      db = memoryAdapter();
      const logs: ContentfnLogEntry[] = [];
      const server = createContentfnServer({
        db,
        logSink: (entry) => logs.push(entry),
      });

      await makeRequest(server.handler, "POST", "/contentfn/datasets/create", { dataset: "prod" });
      await makeRequest(server.handler, "POST", "/contentfn/schema/upsert", {
        dataset: "prod",
        schema: schemaV1,
      });
      await makeRequest(server.handler, "POST", "/contentfn/docs/create", {
        dataset: "prod",
        id: "post-1",
        type: "post",
        doc: { title: "Hello", secret: "abc" },
      });

      expect(logs.length).toBeGreaterThan(0);
      const createLog = logs.find((l) => l.action === "docs.create");
      expect(createLog).toBeDefined();
      expect(createLog!.dataset).toBe("prod");
      expect(createLog!.docId).toBe("post-1");

      const allLogStr = JSON.stringify(logs);
      expect(allLogStr).not.toContain('"abc"');
      expect(allLogStr).not.toContain('"secret"');
    });
  });

  describe("TV-OBS-LOGGING-002: raw bytes are not logged", () => {
    it("logs asset metadata but not raw base64 bytes", async () => {
      db = memoryAdapter();
      const logs: ContentfnLogEntry[] = [];
      const server = createContentfnServer({
        db,
        logSink: (entry) => logs.push(entry),
      });

      await makeRequest(server.handler, "POST", "/contentfn/datasets/create", { dataset: "prod" });
      await makeRequest(server.handler, "POST", "/contentfn/assets/upload", {
        dataset: "prod",
        filename: "hello.txt",
        contentType: "text/plain",
        bytesBase64: "aGVsbG8=",
      });

      const assetLog = logs.find((l) => l.action === "assets.upload");
      expect(assetLog).toBeDefined();
      expect(assetLog!.contentType).toBe("text/plain");

      const allLogStr = JSON.stringify(logs);
      expect(allLogStr).not.toContain("aGVsbG8=");
    });
  });

  describe("TV-STATUS-001: status returns time/capabilities/limits", () => {
    it("GET /contentfn/status returns serverTime, capabilities, limits", async () => {
      db = memoryAdapter();
      const server = createContentfnServer({ db });

      const res = await makeRequest(server.handler, "GET", "/contentfn/status");

      expect(res.body.ok).toBe(true);
      expect(typeof res.body.result.serverTime).toBe("string");
      expect(Array.isArray(res.body.result.capabilities)).toBe(true);
      expect(res.body.result.capabilities).toContain("content.schema");
      expect(res.body.result.capabilities).toContain("content.docs");
      expect(res.body.result.capabilities).toContain("content.assets");
      expect(res.body.result.capabilities).toContain("content.webhooks");
      expect(res.body.result.capabilities).toContain("content.realtime");
      expect(typeof res.body.result.limits).toBe("object");
      expect(typeof res.body.result.limits.maxPayloadBytes).toBe("number");
      expect(typeof res.body.result.limits.maxPatchOps).toBe("number");
    });
  });

  describe("TV-STATUS-002: status forbidden when protected", () => {
    it("returns PERMISSION_DENIED when authorize denies status", async () => {
      db = memoryAdapter();
      const authorize: AuthorizeFn = async (_ctx, action) => {
        if (action === "status") return false;
        return true;
      };
      const server = createContentfnServer({ db, authorize });

      const res = await makeRequest(server.handler, "GET", "/contentfn/status");

      expect(res.body.ok).toBe(false);
      expect(res.body.error.code).toBe("PERMISSION_DENIED");
    });
  });
});
