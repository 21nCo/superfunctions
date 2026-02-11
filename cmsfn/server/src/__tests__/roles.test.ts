/**
 * PHASE_02 role tests: TV-ROLE-UPSERT-001, TV-ROLE-LIST-001, TV-ROLE-DENY-001, TV-ENV-ERR-001.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createCmsfnServer } from "../index.js";
import type { CmsfnServerConfig } from "../index.js";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { CmsfnRole } from "@cmsfn/core";

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
    db: memoryAdapter(),
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

/** Only mock fetch for ContentFn URL so status and other requests work. */
function installContentfnFetchMock(
  contentfnBehavior: (url: string) => Promise<Response>
) {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (url.startsWith(CONTENTFN_BASE)) {
        return contentfnBehavior(url);
      }
      return realFetch(input as string, init);
    }
  );
}

describe("PHASE_02: Roles CRUD + enforcement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("TV-ROLE-UPSERT-001: upsert role", () => {
    it("POST /cmsfn/roles/upsert with valid role returns ok and role", async () => {
      installContentfnFetchMock(async () =>
        new Response(JSON.stringify(contentfnUpResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const role: CmsfnRole = {
          id: "editor",
          name: "Editor",
          rules: [{ datasets: "*", types: "*", actions: ["doc.read", "doc.patch"] }],
        };
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/roles/upsert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(true);
        expect(data.result).toBeDefined();
        expect(data.result.role).toEqual(role);
      } finally {
        close();
      }
    });
  });

  describe("TV-ROLE-LIST-001: list roles", () => {
    it("POST /cmsfn/roles/list returns ok and roles in deterministic order", async () => {
      installContentfnFetchMock(async () =>
        new Response(JSON.stringify(contentfnUpResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        // Upsert two roles in one order
        await fetch(`http://127.0.0.1:${port}/cmsfn/roles/upsert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: { id: "b-role", name: "B", rules: [{ datasets: "*", types: "*", actions: ["doc.read"] }] },
          }),
        });
        await fetch(`http://127.0.0.1:${port}/cmsfn/roles/upsert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role: { id: "a-role", name: "A", rules: [{ datasets: "*", types: "*", actions: ["doc.read"] }] },
          }),
        });
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/roles/list`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod" }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(true);
        expect(Array.isArray(data.result.roles)).toBe(true);
        // Deterministic order by id (asc)
        const ids = data.result.roles.map((r: CmsfnRole) => r.id);
        expect(ids).toEqual(["a-role", "b-role"]);
      } finally {
        close();
      }
    });
  });

  describe("TV-ROLE-DENY-001: denied action returns PERMISSION_DENIED", () => {
    it("POST /cmsfn/publish when role denies doc.publish returns PERMISSION_DENIED", async () => {
      installContentfnFetchMock(async () =>
        new Response(JSON.stringify(contentfnUpResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const roleDenyPublish: CmsfnRole = {
        id: "viewer",
        name: "Viewer",
        rules: [{ datasets: "*", types: "*", actions: ["doc.read"] }],
      };
      const server = createCmsfnServer(
        minimalConfig({
          getRolesForSubject: async () => [roleDenyPublish],
        })
      );
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dataset: "prod", id: "post-1" }),
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

  describe("TV-ENV-ERR-001: canonical error envelope", () => {
    it("POST /cmsfn/roles/delete with roleId '' returns VALIDATION_FAILED and path roleId", async () => {
      installContentfnFetchMock(async () =>
        new Response(JSON.stringify(contentfnUpResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      const server = createCmsfnServer(minimalConfig());
      const { port, close } = await listen(server);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/cmsfn/roles/delete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ roleId: "" }),
        });
        const data = await res.json();
        expect(res.status).toBe(200);
        expect(data.ok).toBe(false);
        expect(data.error?.code).toBe("VALIDATION_FAILED");
        expect(data.error?.message).toBe("Invalid roleId");
        expect(data.error?.details?.path).toBe("roleId");
      } finally {
        close();
      }
    });
  });
});
