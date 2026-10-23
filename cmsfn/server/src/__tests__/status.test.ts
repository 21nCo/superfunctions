import { readResponse, field, text } from "./responseHelpers.js";
/**
 * PHASE_01 status tests: TV-STATUS-001, TV-STATUS-002, TV-STATUS-CONTENTFN-DOWN-001, TV-ENV-OK-001.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCmsfnServer } from "../index.js";
import type { CmsfnServerConfig } from "../index.js";

const CONTENTFN_BASE = "http://contentfn.test";

function contentfnUpResponse() {
  return {
    ok: true,
    result: {
      serverTime: new Date().toISOString(),
      capabilities: [
        "content.schema",
        "content.docs",
        "content.assets",
        "content.webhooks",
        "content.realtime",
      ],
      limits: { maxPayloadBytes: 1e6, maxPatchOps: 100 },
    },
  };
}

function minimalConfig(overrides: Partial<CmsfnServerConfig> = {}): CmsfnServerConfig {
  return {
    contentfn: { baseUrl: CONTENTFN_BASE },
    datasets: [{ name: "prod" }, { name: "staging" }],
    desk: { kind: "divider" },
    auth: { kind: "custom" },
    ...overrides,
  };
}

function listen(server: ReturnType<typeof createCmsfnServer>): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        port,
        close: () => server.close(),
      });
    });
  });
}

/** Only mock fetch for ContentFn URL; use real fetch for test requests to our server. */
function installContentfnFetchMock(
  contentfnBehavior: (url: string) => Promise<Response>
) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(CONTENTFN_BASE)) {
        return contentfnBehavior(url);
      }
      return realFetch(input, init);
    }
  );
}

describe("PHASE_01: Status + ContentFn health", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("TV-ENV-OK-001: canonical success envelope", () => {
    it("GET /cmsfn/status returns { ok: true, result: { serverTime, capabilities, datasets } }", async () => {
      installContentfnFetchMock(async () =>
        new Response(JSON.stringify(contentfnUpResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/status`);
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(true);
        expect(field(data, "result")).toBeDefined();
        expect(typeof field(data, "result.serverTime")).toBe("string");
        expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text(field(data, "result.serverTime")))).toBe(true);
        expect(Array.isArray(field(data, "result.capabilities"))).toBe(true);
        expect(field(data, "result.capabilities.length")).toBeGreaterThan(0);
        expect(Array.isArray(field(data, "result.datasets"))).toBe(true);
      } finally {
        close();
      }
    });
  });

  describe("TV-STATUS-001: status includes datasets in config order", () => {
    it("result.datasets equals configured dataset names in order", async () => {
      installContentfnFetchMock(async () =>
        new Response(JSON.stringify(contentfnUpResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const config = minimalConfig({
        datasets: [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }],
      });
      const server = createCmsfnServer(config);
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/status`);
        const data = await readResponse(res);
        expect(field(data, "ok")).toBe(true);
        expect(field(data, "result.datasets")).toEqual(["alpha", "beta", "gamma"]);
      } finally {
        close();
      }
    });
  });

  describe("TV-STATUS-002: status forbidden when protected", () => {
    it("returns PERMISSION_DENIED when authorizeStatus denies", async () => {
      let contentfnFetched = false;
      installContentfnFetchMock(async () => {
        contentfnFetched = true;
        return new Response("", { status: 200 });
      });
      const authorizeStatus = vi.fn().mockResolvedValue(false);

      const server = createCmsfnServer(
        minimalConfig({ authorizeStatus })
      );
      const { port, close } = await listen(server);
      await server.readiness;
      contentfnFetched = false; // Startup is a separate service-level probe.
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/status`);
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code") === "PERMISSION_DENIED" || field(data, "error.code") === "AUTH_REQUIRED").toBe(true);
        expect(contentfnFetched).toBe(false);
      } finally {
        close();
      }
    });
  });

  describe("TV-STATUS-CONTENTFN-DOWN-001: ContentFn unavailable", () => {
    it("returns CONTENTFN_UNAVAILABLE when ContentFn is unreachable", async () => {
      installContentfnFetchMock(async () => {
        throw new Error("network");
      });

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/status`);
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code")).toBe("CONTENTFN_UNAVAILABLE");
      } finally {
        close();
      }
    });

    it("returns CONTENTFN_UNAVAILABLE when ContentFn returns non-200", async () => {
      installContentfnFetchMock(async () => new Response("", { status: 503 }));

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/status`);
        const data = await readResponse(res);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code")).toBe("CONTENTFN_UNAVAILABLE");
      } finally {
        close();
      }
    });

    it("returns CONTENTFN_UNAVAILABLE when ContentFn missing required capability", async () => {
      installContentfnFetchMock(async () =>
        new Response(
          JSON.stringify({
            ok: true,
            result: {
              serverTime: new Date().toISOString(),
              capabilities: ["content.schema"],
              limits: {},
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/status`);
        const data = await readResponse(res);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code")).toBe("CONTENTFN_UNAVAILABLE");
      } finally {
        close();
      }
    });
  });
});
