/**
 * PHASE_07: Preview token — TV-PREVIEW-TOKEN-001, TV-PREVIEW-DISABLED-001.
 */

import { describe, it, expect } from "vitest";
import { createCmsfnServer } from "../index.js";
import type { CmsfnServerConfig } from "../index.js";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { CmsfnRole } from "cmsfn";

function minimalConfig(overrides: Partial<CmsfnServerConfig> = {}): CmsfnServerConfig {
  return {
    contentfn: { baseUrl: "http://contentfn.test" },
    datasets: [{ name: "prod" }],
    desk: { kind: "divider" },
    auth: { kind: "custom" },
    db: memoryAdapter(),
    ...overrides,
  };
}

function listen(server: ReturnType<typeof createCmsfnServer>): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

describe("PHASE_07: Preview token", () => {
  describe("TV-PREVIEW-TOKEN-001: preview token minted", () => {
    it("POST /cmsfn/preview/token with dataset and docId returns ok, result.token and result.expiresAt (ISO)", async () => {
      const roleWithRead: CmsfnRole = {
        id: "editor",
        name: "Editor",
        rules: [{ datasets: "*", types: "*", actions: ["doc.read"] }],
      };
      const server = createCmsfnServer(
        minimalConfig({
          preview: { enabled: true, targetOrigin: "https://preview.test", resolveUrl: () => "" },
          previewSecret: "test-secret",
          getRolesForSubject: async () => [roleWithRead],
        })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/preview/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", docId: "post-1" }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(true);
        expect(data.result).toBeDefined();
        expect(typeof data.result.token).toBe("string");
        expect(data.result.token.length).toBeGreaterThan(0);
        expect(typeof data.result.expiresAt).toBe("string");
        expect(data.result.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
        expect(data.result.dataset).toBe("prod");
        expect(Array.isArray(data.result.docIds)).toBe(true);
        expect(data.result.docIds).toEqual(["post-1"]);
      } finally {
        close();
      }
    });
  });

  describe("TV-PREVIEW-DISABLED-001: preview not configured", () => {
    it("POST /cmsfn/preview/token when preview disabled returns ok=false, error.code PREVIEW_NOT_CONFIGURED", async () => {
      const server = createCmsfnServer(
        minimalConfig({
          preview: { enabled: false, targetOrigin: "", resolveUrl: () => "" },
        })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/preview/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", docId: "post-1" }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(false);
        expect(data.error?.code).toBe("PREVIEW_NOT_CONFIGURED");
      } finally {
        close();
      }
    });

    it("POST /cmsfn/preview/token when previewSecret not set returns PREVIEW_NOT_CONFIGURED", async () => {
      const server = createCmsfnServer(
        minimalConfig({
          preview: { enabled: true, targetOrigin: "https://x.test", resolveUrl: () => "" },
          getRolesForSubject: async () => [],
        })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/preview/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", docId: "post-1" }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(false);
        expect(data.error?.code).toBe("PREVIEW_NOT_CONFIGURED");
      } finally {
        close();
      }
    });
  });

  describe("Permission", () => {
    it("when role denies doc.read returns PERMISSION_DENIED", async () => {
      const roleNoRead: CmsfnRole = {
        id: "anon",
        name: "Anon",
        rules: [],
      };
      const server = createCmsfnServer(
        minimalConfig({
          preview: { enabled: true, targetOrigin: "https://x.test", resolveUrl: () => "" },
          previewSecret: "secret",
          getRolesForSubject: async () => [roleNoRead],
        })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/preview/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", docId: "post-1" }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(false);
        expect(data.error?.code).toBe("PERMISSION_DENIED");
      } finally {
        close();
      }
    });
  });
});
