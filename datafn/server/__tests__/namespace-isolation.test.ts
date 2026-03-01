/**
 * Namespace Isolation Tests
 * Tests for per-user/tenant serverSeq isolation via authContextProvider
 */

import { describe, it, expect } from "vitest";
import { createDatafnServer } from "../src/server.js";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { AuthContext } from "@superfunctions/auth";

const testSchema = {
  resources: [
    {
      name: "task",
      version: 1,
      fields: [{ name: "title", type: "string" as const, required: true }],
    },
  ],
};

describe("Namespace Isolation via authContextProvider", () => {

  it("uses default namespace when authContextProvider is not provided", async () => {
    const db = memoryAdapter({ libraryNamespace: "datafn" });
    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: testSchema,
      db,
    });

    const req = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:1",
        mutations: [
          {
            operation: "insert",
            resource: "task",
            id: "task:1",
            clientId: "client:1",
            mutationId: "m-1",
            record: { title: "Test" },
          },
        ],
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.cursor).toBeDefined();
  });

  it("extracts namespace from authContextProvider using request headers", async () => {
    const db = memoryAdapter({ libraryNamespace: "datafn" });
    
    // authContextProvider extracts user from custom header (simulating session/JWT)
    const authContextProvider = {
      getContext: (ctx: any): AuthContext => {
        // In real usage, this would extract from session, JWT, or similar
        // For testing, we'll use the parsedBody.clientId as a proxy for userId
        // Or we could add custom headers to the request
        const parsedBody = ctx.parsedBody as any;
        return {
          userId: parsedBody?.userId || parsedBody?.clientId || "",
          tenantId: parsedBody?.tenantId,
        };
      },
    };

    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: testSchema,
      db,
      authContextProvider,
    });

    // Push for user 1 (using clientId as userId for this test)
    const req1 = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:1",
        userId: "user-1", // Extra field for auth context
        mutations: [
          {
            operation: "insert",
            resource: "task",
            id: "task:1",
            clientId: "client:1",
            mutationId: "m-1",
            record: { title: "User 1 Task" },
          },
        ],
      }),
    });

    const res1 = await server.router.handle(req1);
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.ok).toBe(true);
    expect(body1.result.cursor).toBe("1"); // First serverSeq for user-1

    // Push for user 2 - should get independent serverSeq
    const req2 = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:2",
        userId: "user-2", // Different user
        mutations: [
          {
            operation: "insert",
            resource: "task",
            id: "task:2",
            clientId: "client:2",
            mutationId: "m-2",
            record: { title: "User 2 Task" },
          },
        ],
      }),
    });

    const res2 = await server.router.handle(req2);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.ok).toBe(true);
    expect(body2.result.cursor).toBe("1"); // First serverSeq for user-2 (independent namespace)
  });

  it("constructs tenant:userId namespace for multi-tenant isolation", async () => {
    const db = memoryAdapter({ libraryNamespace: "datafn" });
    const authContextProvider = {
      getContext: (ctx: any): AuthContext => {
        const parsedBody = ctx.parsedBody as any;
        return {
          userId: parsedBody?.userId || "",
          tenantId: parsedBody?.tenantId,
        };
      },
    };

    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: testSchema,
      db,
      authContextProvider,
    });

    // Push for tenant A, user 1
    const req1 = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:1",
        userId: "user-1",
        tenantId: "tenant-a",
        mutations: [
          {
            operation: "insert",
            resource: "task",
            id: "task:1",
            clientId: "client:1",
            mutationId: "m-1",
            record: { title: "Tenant A Task" },
          },
        ],
      }),
    });

    const res1 = await server.router.handle(req1);
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.result.cursor).toBe("1");

    // Push for tenant B, same user ID (but different tenant = different namespace)
    const req2 = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:1",
        userId: "user-1",
        tenantId: "tenant-b",
        mutations: [
          {
            operation: "insert",
            resource: "task",
            id: "task:2",
            clientId: "client:1",
            mutationId: "m-2",
            record: { title: "Tenant B Task" },
          },
        ],
      }),
    });

    const res2 = await server.router.handle(req2);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.result.cursor).toBe("1"); // Independent namespace
  });

  it("returns error when getContext throws (SRV-010: no silent fallback)", async () => {
    const db = memoryAdapter({ libraryNamespace: "datafn" });
    const authContextProvider = {
      getContext: (): AuthContext => {
        throw new Error("Auth error");
      },
    };

    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: testSchema,
      db,
      authContextProvider,
    });

    const req = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:1",
        mutations: [
          {
            operation: "insert",
            resource: "task",
            id: "task:1",
            clientId: "client:1",
            mutationId: "m-1",
            record: { title: "Test" },
          },
        ],
      }),
    });

    const res = await server.router.handle(req);
    // SRV-010: extractNamespace now throws on auth errors instead of falling back
    // to "datafn" to prevent accidental cross-tenant data leaks.
    expect(res.status).not.toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  it("falls back to default namespace when userId is missing", async () => {
    const db = memoryAdapter({ libraryNamespace: "datafn" });
    const authContextProvider = {
      getContext: (): AuthContext => ({
        userId: "", // Empty userId
      }),
    };

    const server = await createDatafnServer({ allowUnknownResources: true,
      schema: testSchema,
      db,
      authContextProvider,
    });

    const req = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:1",
        mutations: [
          {
            operation: "insert",
            resource: "task",
            id: "task:1",
            clientId: "client:1",
            mutationId: "m-1",
            record: { title: "Test" },
          },
        ],
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(200); // Should not fail, falls back to default
  });
});
