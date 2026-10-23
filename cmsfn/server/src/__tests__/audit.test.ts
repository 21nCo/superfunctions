import { readResponse, field } from "./responseHelpers.js";
/**
 * PHASE_12: Audit — TV-AUDIT-EVENTS-001, TV-AUDIT-WEBHOOKS-001, TV-AUDIT-DENY-001.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createCmsfnServer } from "../index.js";
import type { CmsfnServerConfig } from "../index.js";
import type { CmsfnRole } from "cmsfn";

const CONTENTFN_BASE = "http://contentfn.test";

function minimalConfig(overrides: Partial<CmsfnServerConfig> = {}): CmsfnServerConfig {
  return {
    contentfn: { baseUrl: CONTENTFN_BASE },
    datasets: [{ name: "prod" }],
    desk: { kind: "divider" },
    auth: { kind: "custom" },
    getRolesForSubject: async (): Promise<CmsfnRole[]> => [
      { id: "auditor", name: "Auditor", rules: [{ datasets: "*", types: "*", actions: ["audit.read"] }] },
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

describe("PHASE_12: Audit", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("TV-AUDIT-EVENTS-001: read event metadata without raw document body", () => {
    it("POST /cmsfn/audit/events returns ok=true with event metadata list", async () => {
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.startsWith(CONTENTFN_BASE) && url.includes("/contentfn/audit/query")) {
            return new Response(
              JSON.stringify({
                ok: true,
                result: {
                  records: [
                    {
                      id: "evt-1",
                      dataset: "prod",
                      action: "docs.publish",
                      timestamp: "2026-02-11T12:00:00Z",
                      targetIds: ["prod", "post-1"], actor: null,
                    },
                  ],
                  nextOffset: null,
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return realFetch(input, init);
        })
      );

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/audit/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", limit: 10 }),
        });
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(true);
        expect(Array.isArray(field(data, "result.events"))).toBe(true);
        expect(field(data, "result.events.length")).toBe(1);
        expect(field(data, "result.events.0.eventId")).toBe("evt-1");
        expect(field(data, "result.events.0.type")).toBe("docs.publish");
        expect(field(data, "result.events.0.targetIds")).toEqual(["prod", "post-1"]);
        expect(field(data, "result.events.0.document")).toBeUndefined();
      } finally {
        close();
      }
    });
  });

  describe("TV-AUDIT-WEBHOOKS-001: read webhook delivery status", () => {
    it("POST /cmsfn/audit/webhooks returns ok=true with webhookId, status, attempt, timestamps", async () => {
      const realFetch = globalThis.fetch;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (url.startsWith(CONTENTFN_BASE) && url.includes("/contentfn/audit/webhooks")) {
            return new Response(
              JSON.stringify({
                ok: true,
                result: {
                  deliveries: [
                    {
                      webhookId: "wh-1",
                      dataset: "prod",
                      url: "https://example.com/hook",
                      eventId: "evt-1",
                      attempt: 1,
                      status: "delivered",
                      updatedAt: "2026-02-11T12:00:00Z",
                    },
                  ],
                  nextCursor: null,
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } }
            );
          }
          return realFetch(input, init);
        })
      );

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/audit/webhooks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", limit: 10 }),
        });
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(true);
        expect(Array.isArray(field(data, "result.deliveries"))).toBe(true);
        expect(field(data, "result.deliveries.length")).toBe(1);
        expect(field(data, "result.deliveries.0.webhookId")).toBe("wh-1");
        expect(field(data, "result.deliveries.0.status")).toBe("delivered");
        expect(field(data, "result.deliveries.0.attempt")).toBe(1);
        expect(field(data, "result.deliveries.0.updatedAt")).toBeDefined();
      } finally {
        close();
      }
    });
  });

  describe("TV-AUDIT-DENY-001: audit access denied without permission", () => {
    it("POST /cmsfn/audit/events without audit.read returns PERMISSION_DENIED", async () => {
      const server = createCmsfnServer(
        minimalConfig({
          getRolesForSubject: async () => [
            { id: "viewer", name: "Viewer", rules: [{ datasets: "*", types: "*", actions: ["doc.read"] }] },
          ],
        })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/audit/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod" }),
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
