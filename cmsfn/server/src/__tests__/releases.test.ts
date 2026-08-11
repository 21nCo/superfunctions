/**
 * PHASE_10: Releases — TV-REL-CREATE-001, TV-REL-ADD-001, TV-REL-PUBLISH-001, TV-REL-PUBLISH-002.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createCmsfnServer } from "../index.js";
import type { CmsfnServerConfig } from "../index.js";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { CmsfnRole } from "cmsfn";

const CONTENTFN_BASE = "http://contentfn.test";

function minimalConfig(overrides: Partial<CmsfnServerConfig> = {}): CmsfnServerConfig {
  return {
    contentfn: { baseUrl: CONTENTFN_BASE },
    datasets: [{ name: "prod" }],
    desk: { kind: "divider" },
    auth: { kind: "custom" },
    db: memoryAdapter(),
    getRolesForSubject: async (): Promise<CmsfnRole[]> => [
      {
        id: "admin",
        name: "Admin",
        rules: [{ datasets: "*", types: "*", actions: ["release.manage", "doc.publish", "doc.read"] }],
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

describe("PHASE_10: Releases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("TV-REL-CREATE-001: create release", () => {
    it("POST /cmsfn/releases/create returns ok=true and result.releaseId", async () => {
      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/releases/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", name: "Launch", publishAt: null }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(true);
        expect(data.result?.releaseId).toBeDefined();
        expect(typeof data.result.releaseId).toBe("string");
        expect(data.result.releaseId.length).toBeGreaterThan(0);
      } finally {
        close();
      }
    });
  });

  describe("TV-REL-ADD-001: add doc to release", () => {
    it("POST /cmsfn/releases/add after create returns ok=true", async () => {
      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const createRes = await fetch(`http://127.0.0.1:${port}/cmsfn/releases/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", name: "Launch", publishAt: null }),
        });
        const createData = await createRes.json();
        expect(createData.ok).toBe(true);
        const releaseId = createData.result.releaseId;

        const addRes = await fetch(`http://127.0.0.1:${port}/cmsfn/releases/add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", releaseId, docId: "post-1" }),
        });
        const addData = await addRes.json();
        expect(addRes.status).toBe(200);
        expect(addData.ok).toBe(true);
      } finally {
        close();
      }
    });
  });

  describe("TV-REL-PUBLISH-001: publish release", () => {
    it("POST /cmsfn/releases/publish returns ok=true with deterministic summary (published doc IDs)", async () => {
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.startsWith(CONTENTFN_BASE)) {
            if (url.includes("/contentfn/docs/get")) {
              const body = init?.body ? JSON.parse(init.body as string) : {};
              const id = body?.id ?? "";
              return new Response(
                JSON.stringify({
                  ok: true,
                  result: {
                    _id: id,
                    _type: "post",
                    _rev: "r1",
                    _cms: { workflow: "default", state: "approved", updatedAt: new Date().toISOString() },
                  },
                }),
                { status: 200, headers: { "Content-Type": "application/json" } }
              );
            }
            if (url.includes("/contentfn/docs/publish")) {
              const body = init?.body ? JSON.parse(init.body as string) : {};
              return new Response(
                JSON.stringify({
                  ok: true,
                  result: { _id: body?.id ?? "", _type: "post", _rev: "r2" },
                }),
                { status: 200, headers: { "Content-Type": "application/json" } }
              );
            }
          }
          return realFetch(input as string, init);
        })
      );

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const createRes = await fetch(`http://127.0.0.1:${port}/cmsfn/releases/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", name: "Launch", publishAt: null }),
        });
        const createData = await createRes.json();
        expect(createData.ok).toBe(true);
        const releaseId = createData.result.releaseId;

        await fetch(`http://127.0.0.1:${port}/cmsfn/releases/add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", releaseId, docId: "post-1" }),
        });

        const pubRes = await fetch(`http://127.0.0.1:${port}/cmsfn/releases/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", releaseId }),
        });
        const pubData = await pubRes.json();
        expect(pubRes.status).toBe(200);
        expect(pubData.ok).toBe(true);
        expect(pubData.result?.releaseId).toBe(releaseId);
        expect(Array.isArray(pubData.result?.published)).toBe(true);
        expect(pubData.result.published).toContain("post-1");
        expect(Array.isArray(pubData.result?.failures)).toBe(true);
      } finally {
        close();
      }
    });
  });

  describe("TV-REL-PUBLISH-002: publish release with failing doc", () => {
    it("when doc fails workflow gate, result includes deterministic failures", async () => {
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.startsWith(CONTENTFN_BASE) && url.includes("/contentfn/docs/get")) {
            return new Response(
              JSON.stringify({
                ok: true,
                result: {
                  _id: "drafts.post-1",
                  _type: "post",
                  _rev: "r1",
                  _cms: { workflow: "default", state: "draft", updatedAt: new Date().toISOString() },
                },
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
        const createRes = await fetch(`http://127.0.0.1:${port}/cmsfn/releases/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", name: "Launch", publishAt: null }),
        });
        const createData = await createRes.json();
        expect(createData.ok).toBe(true);
        const releaseId = createData.result.releaseId;

        await fetch(`http://127.0.0.1:${port}/cmsfn/releases/add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", releaseId, docId: "post-1" }),
        });

        const pubRes = await fetch(`http://127.0.0.1:${port}/cmsfn/releases/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", releaseId }),
        });
        const pubData = await pubRes.json();
        expect(pubRes.status).toBe(200);
        expect(pubData.ok).toBe(true);
        expect(pubData.result?.releaseId).toBe(releaseId);
        expect(Array.isArray(pubData.result?.failures)).toBe(true);
        expect(pubData.result.failures.length).toBeGreaterThanOrEqual(1);
        const failure = pubData.result.failures.find((f: { docId: string }) => f.docId === "post-1");
        expect(failure).toBeDefined();
        expect(failure?.code).toBe("PERMISSION_DENIED");
      } finally {
        close();
      }
    });
  });

  describe("TV-LIMIT-RELEASE-001: release too large", () => {
    it("adding docs beyond max size returns VALIDATION_FAILED", async () => {
      const { MAX_DOCS_PER_RELEASE } = await import("../limits/limits.js");
      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const createRes = await fetch(`http://127.0.0.1:${port}/cmsfn/releases/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", name: "Big", publishAt: null }),
        });
        const createData = await createRes.json();
        expect(createData.ok).toBe(true);
        const releaseId = createData.result.releaseId;
        for (let i = 0; i < MAX_DOCS_PER_RELEASE; i++) {
          const addRes = await fetch(`http://127.0.0.1:${port}/cmsfn/releases/add`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dataset: "prod", releaseId, docId: `doc-${i}` }),
          });
          const addData = await addRes.json();
          expect(addData.ok).toBe(true);
        }
        const overRes = await fetch(`http://127.0.0.1:${port}/cmsfn/releases/add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", releaseId, docId: "doc-501" }),
        });
        const overData = await overRes.json();
        expect(overRes.status).toBe(200);
        expect(overData.ok).toBe(false);
        expect(overData.error?.code).toBe("VALIDATION_FAILED");
      } finally {
        close();
      }
    });
  });
});
