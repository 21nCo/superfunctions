/**
 * PHASE_11: Ops import/export — TV-OPS-EXPORT-001, TV-OPS-IMPORT-001, TV-OPS-IMPORT-002.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createCmsfnServer } from "../index.js";
import type { CmsfnServerConfig } from "../index.js";
import type { CmsfnRole } from "@cmsfn/core";

const CONTENTFN_BASE = "http://contentfn.test";

function minimalConfig(overrides: Partial<CmsfnServerConfig> = {}): CmsfnServerConfig {
  return {
    contentfn: { baseUrl: CONTENTFN_BASE },
    datasets: [{ name: "prod" }, { name: "prod2" }],
    desk: { kind: "divider" },
    auth: { kind: "custom" },
    getRolesForSubject: async (): Promise<CmsfnRole[]> => [
      {
        id: "ops",
        name: "Ops",
        rules: [{ datasets: "*", types: "*", actions: ["audit.read"] }],
      },
    ],
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

const validArtifact = {
  formatVersion: 1,
  dataset: "prod",
  exportedAt: "2026-02-11T00:00:00Z",
  schema: null,
  publishedDocs: [],
  draftDocs: [],
  assets: [],
  revisions: [],
};

describe("PHASE_11: Ops import/export", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("TV-OPS-EXPORT-001: trigger export", () => {
    it("POST /cmsfn/ops/export returns ok=true and artifact (or job handle)", async () => {
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.startsWith(CONTENTFN_BASE) && url.includes("/contentfn/datasets/export")) {
            return new Response(
              JSON.stringify({
                ok: true,
                result: { artifact: validArtifact },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return realFetch(input as string, init);
        })
      );

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/ops/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod" }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(true);
        expect(data.result?.artifact).toBeDefined();
        expect(data.result.artifact.formatVersion).toBe(1);
        expect(data.result.artifact.dataset).toBe("prod");
      } finally {
        close();
      }
    });
  });

  describe("TV-OPS-IMPORT-001: trigger import", () => {
    it("POST /cmsfn/ops/import with valid artifact returns ok=true", async () => {
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.startsWith(CONTENTFN_BASE) && url.includes("/contentfn/datasets/import")) {
            return new Response(
              JSON.stringify({ ok: true, result: {} }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return realFetch(input as string, init);
        })
      );

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/ops/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod2", artifact: validArtifact }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(true);
      } finally {
        close();
      }
    });
  });

  describe("TV-OPS-IMPORT-002: malformed artifact", () => {
    it("import with malformed artifact returns ok=false, error.code=VALIDATION_FAILED", async () => {
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.startsWith(CONTENTFN_BASE) && url.includes("/contentfn/datasets/import")) {
            return new Response(
              JSON.stringify({
                ok: false,
                error: { code: "VALIDATION_FAILED", message: "Malformed import artifact", details: { path: "artifact" } },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return realFetch(input as string, init);
        })
      );

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/ops/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod2", artifact: "not-an-object" }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(false);
        expect(data.error?.code).toBe("VALIDATION_FAILED");
      } finally {
        close();
      }
    });
  });

  describe("Dataset isolation", () => {
    it("export for disallowed dataset returns VALIDATION_FAILED", async () => {
      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/ops/export`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "other" }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(false);
        expect(data.error?.code).toBe("VALIDATION_FAILED");
      } finally {
        close();
      }
    });
  });
});
