import { readResponse, field, array } from "./responseHelpers.js";
/**
 * PHASE_02 role tests: TV-ROLE-UPSERT-001, TV-ROLE-LIST-001, TV-ROLE-DENY-001, TV-ENV-ERR-001.
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
    authorizeRoles: async () => true,
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
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(true);
        expect(field(data, "result")).toBeDefined();
        expect(field(data, "result.role")).toEqual(role);
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
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(true);
        expect(Array.isArray(field(data, "result.roles"))).toBe(true);
        // Deterministic order by id (asc)
        const ids = array(field(data, "result.roles")).map(r => field(r, "id"));
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
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code")).toBe("PERMISSION_DENIED");
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
        const data = await readResponse(res);
        expect(res.status).toBe(200);
        expect(field(data, "ok")).toBe(false);
        expect(field(data, "error.code")).toBe("VALIDATION_FAILED");
        expect(field(data, "error.message")).toBe("Invalid roleId");
        expect(field(data, "error.details.path")).toBe("roleId");
      } finally {
        close();
      }
    });
  });
});

describe("role HTTP body boundary", () => {
  it("returns oversized-body envelopes over a live socket, with and without Content-Length", async () => {
    const server = createCmsfnServer(minimalConfig());
    const { port, close } = await listen(server);
    try {
      for (const chunked of [false, true]) {
        const payload = 'x'.repeat(65537);
        const body = chunked ? new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        } }) : payload;
        const response = await fetch(`http://127.0.0.1:${port}/cmsfn/roles/list`, {
          method: "POST", body, duplex: "half",
        } as RequestInit & { duplex: "half" });
        expect(await response.json()).toMatchObject({ ok: false, error: { code: "PAYLOAD_TOO_LARGE" } });
      }
    } finally { close(); }
  });

  it("denies a role endpoint when no authorizer is configured", async () => {
    const server = createCmsfnServer(minimalConfig({ authorizeRoles: undefined }));
    const { port, close } = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/cmsfn/roles/list`, {
        method: "POST", body: '{"dataset":"prod"}',
      });
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    } finally { close(); }
  });
});

describe("role rule runtime contract over HTTP", () => {
  it.each([
    { datasets: ["prod", null], types: "*", actions: "*" },
    { datasets: "*", types: [12], actions: "*" },
    { datasets: "*", types: "*", actions: ["doc.read", "unknown"] },
    { datasets: "*", types: "*", actions: ["*"] },
    { datasets: "production", types: "*", actions: ["doc.read"] },
  ])("rejects invalid role payloads without storing them", async rule => {
    const db = memoryAdapter();
    const server = createCmsfnServer(minimalConfig({ db }));
    const { port, close } = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/cmsfn/roles/upsert`, {
        method: "POST", body: JSON.stringify({ role: { id: "bad", name: "Bad", rules: [rule] } }),
      });
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
      expect(await db.count({ model: "cmsfn_roles" })).toBe(0);
    } finally { close(); }
  });
  it("denies malformed deployment-supplied roles instead of using string substring matching", async () => {
    const server = createCmsfnServer(minimalConfig({
      getRolesForSubject: async () => [{ id: "bad", name: "Bad", rules: [
        { datasets: "production", types: "*", actions: "doc.publish.extra" },
      ] }] as unknown as CmsfnRole[],
    }));
    const { port, close } = await listen(server);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/cmsfn/publish`, {
        method: "POST", body: JSON.stringify({ dataset: "prod", id: "post-1" }),
      });
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    } finally { close(); }
  });
});
