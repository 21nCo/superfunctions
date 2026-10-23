/**
 * Integration tests for PHASE_08: asset upload and get with metadata.
 * Covers TV-ASSET-UPLOAD-001/002, TV-ASSET-GET-001/002.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { createContentfnServer } from "../server.js";
import { isISO8601 } from "@contentfn/core";

describe("PHASE_08 assets subsystem", () => {
  let api: ReturnType<typeof createContentfnServer>["api"];

  beforeEach(async () => {
    const server = createContentfnServer({ db: memoryAdapter() });
    api = server.api;
    await api.datasets.create({ dataset: "prod" });
  });

  describe("TV-ASSET-UPLOAD-001: upload asset", () => {
    it("uploads asset and returns assetId and url", async () => {
      const res = await api.assets.upload({
        dataset: "prod",
        filename: "hello.txt",
        contentType: "text/plain",
        bytesBase64: "aGVsbG8=",
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(typeof res.result.assetId).toBe("string");
        expect(res.result.assetId.length).toBeGreaterThan(0);
        expect(typeof res.result.url).toBe("string");
        expect(res.result.url.length).toBeGreaterThan(0);
      }
    });

    it("uploads image and extracts width/height metadata", async () => {
      const pngBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      const uploadRes = await api.assets.upload({
        dataset: "prod",
        filename: "test.png",
        contentType: "image/png",
        bytesBase64: pngBase64,
      });

      expect(uploadRes.ok).toBe(true);
      if (!uploadRes.ok) return;

      const getRes = await api.assets.get({
        dataset: "prod",
        assetId: uploadRes.result.assetId,
      });

      expect(getRes.ok).toBe(true);
      if (getRes.ok) {
        expect(getRes.result.metadata.contentType).toBe("image/png");
        expect(getRes.result.metadata.filename).toBe("test.png");
        expect(typeof getRes.result.metadata.size).toBe("number");
        expect(getRes.result.metadata.width).toBe(1);
        expect(getRes.result.metadata.height).toBe(1);
        expect(isISO8601(getRes.result.metadata.createdAt as string)).toBe(true);
      }
    });
  });

  describe("TV-ASSET-UPLOAD-002: payload too large", () => {
    it("returns PAYLOAD_TOO_LARGE when asset exceeds maxPayloadBytes", async () => {
      const server = createContentfnServer({
        db: memoryAdapter(),
        maxPayloadBytes: 10,
      });
      await server.api.datasets.create({ dataset: "prod" });

      const res = await server.api.assets.upload({
        dataset: "prod",
        filename: "large.txt",
        contentType: "text/plain",
        bytesBase64: Buffer.from("a".repeat(100)).toString("base64"),
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("PAYLOAD_TOO_LARGE");
      }
    });

    it("returns VALIDATION_FAILED for invalid base64", async () => {
      const res = await api.assets.upload({
        dataset: "prod",
        filename: "test.txt",
        contentType: "text/plain",
        bytesBase64: "not-valid-base64!!!",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("VALIDATION_FAILED");
        expect(res.error.details.path).toBe("bytesBase64");
      }
    });
  });

  describe("TV-ASSET-GET-001: get uploaded asset", () => {
    it("returns asset metadata and url", async () => {
      const uploadRes = await api.assets.upload({
        dataset: "prod",
        filename: "hello.txt",
        contentType: "text/plain",
        bytesBase64: "aGVsbG8=",
      });

      expect(uploadRes.ok).toBe(true);
      if (!uploadRes.ok) return;

      const getRes = await api.assets.get({
        dataset: "prod",
        assetId: uploadRes.result.assetId,
      });

      expect(getRes.ok).toBe(true);
      if (getRes.ok) {
        expect(getRes.result.assetId).toBe(uploadRes.result.assetId);
        expect(getRes.result.url).toBe(uploadRes.result.url);
        expect(getRes.result.metadata.contentType).toBe("text/plain");
        expect(getRes.result.metadata.filename).toBe("hello.txt");
        expect(getRes.result.metadata.size).toBe(5);
        expect(isISO8601(getRes.result.metadata.createdAt as string)).toBe(true);
      }
    });
  });

  describe("TV-ASSET-GET-002: missing asset", () => {
    it("returns ASSET_NOT_FOUND for missing asset", async () => {
      const res = await api.assets.get({
        dataset: "prod",
        assetId: "missing",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("ASSET_NOT_FOUND");
        expect(res.error.details.assetId).toBe("missing");
      }
    });
  });

  describe("Dataset isolation", () => {
    it("returns DATASET_NOT_FOUND for missing dataset on upload", async () => {
      const res = await api.assets.upload({
        dataset: "missing",
        filename: "test.txt",
        contentType: "text/plain",
        bytesBase64: "dGVzdA==",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("DATASET_NOT_FOUND");
      }
    });

    it("returns DATASET_NOT_FOUND for missing dataset on get", async () => {
      const res = await api.assets.get({
        dataset: "missing",
        assetId: "test-asset",
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("DATASET_NOT_FOUND");
      }
    });
  });
});
