import { readResponse, field } from "./responseHelpers.js";
/**
 * PHASE_06: Publish/unpublish gating — TV-WF-PUBLISH-GATE-001, workflow gate, unpublish.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createCmsfnServer } from "../index.js";
import type { CmsfnServerConfig } from "../index.js";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { CmsfnRole } from "cmsfn";

const CONTENTFN_BASE = "http://contentfn.test";

function contentfnUpResponse() {
  return {
    ok: true,
    result: {
      serverTime: new Date().toISOString(),
      capabilities: [],
      limits: { maxPayloadBytes: 1e6, maxPatchOps: 100 },
    },
  };
}

function minimalConfig(overrides: Partial<CmsfnServerConfig> = {}): CmsfnServerConfig {
  return {
    contentfn: { baseUrl: CONTENTFN_BASE },
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

function installContentfnFetchMock(behavior: (url: string, body?: unknown) => Promise<Response>) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    if (url.startsWith(CONTENTFN_BASE)) {
      const body = init?.body ? JSON.parse(typeof init.body === "string" ? init.body : "") : undefined;
      return behavior(url, body);
    }
    return realFetch(input as string, init);
  });
}

describe("PHASE_06: Publish/unpublish gating", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("TV-WF-PUBLISH-GATE-001: publish blocked by workflow (draft state)", () => {
    it("when draft has state draft and role has doc.publish, gate denies with PERMISSION_DENIED", async () => {
      const draftDoc = {
        _id: "drafts.post-1",
        _type: "post",
        _rev: "rev-1",
        _cms: { workflow: "default", state: "draft", updatedAt: new Date().toISOString() },
      };
      installContentfnFetchMock(async (url, body) => {
        if (url.includes("/contentfn/docs/get")) {
          return new Response(JSON.stringify({ ok: true, result: draftDoc }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ ok: false, error: { code: "UNEXPECTED" } }), { status: 400 });
      });

      const roleWithPublish: CmsfnRole = {
        id: "editor",
        name: "Editor",
        rules: [{ datasets: "*", types: "*", actions: ["doc.read", "doc.patch", "doc.publish"] }],
      };
      const server = createCmsfnServer(
        minimalConfig({ getRolesForSubject: async () => [roleWithPublish] })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", id: "post-1" }),
        });
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code")).toBe("PERMISSION_DENIED");
        expect(field(data, "error.details.state")).toBe("draft");
      } finally {
        close();
      }
    });
  });

  describe("TV-WF-PUBLISH-GATE-001: in_review without override", () => {
    it("when draft is in_review and role lacks doc.publish, returns PERMISSION_DENIED", async () => {
      installContentfnFetchMock(async () =>
        new Response(JSON.stringify(contentfnUpResponse()), { status: 200, headers: { "Content-Type": "application/json" } })
      );

      const roleNoPublish: CmsfnRole = {
        id: "reviewer",
        name: "Reviewer",
        rules: [{ datasets: "*", types: "*", actions: ["doc.read"] }],
      };
      const server = createCmsfnServer(
        minimalConfig({ getRolesForSubject: async () => [roleNoPublish] })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", id: "post-1" }),
        });
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code")).toBe("PERMISSION_DENIED");
      } finally {
        close();
      }
    });
  });

  describe("Unpublish", () => {
    it("POST /cmsfn/unpublish without doc.unpublish returns PERMISSION_DENIED", async () => {
      installContentfnFetchMock(async () =>
        new Response(JSON.stringify(contentfnUpResponse()), { status: 200, headers: { "Content-Type": "application/json" } })
      );

      const roleNoUnpublish: CmsfnRole = {
        id: "editor",
        name: "Editor",
        rules: [{ datasets: "*", types: "*", actions: ["doc.read", "doc.publish"] }],
      };
      const server = createCmsfnServer(
        minimalConfig({ getRolesForSubject: async () => [roleNoUnpublish] })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/unpublish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", id: "post-1" }),
        });
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code")).toBe("PERMISSION_DENIED");
      } finally {
        close();
      }
    });
  });
});
