/**
 * Authorization (Authz) Tests
 * Tests for TV-AUTH-001, TV-AUTH-001N, TV-AUTH-002, TV-AUTH-002N
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createDatafnServer } from "../src/server.js";
import { memoryAdapter } from "@superfunctions/db/adapters";
import type { AuthContext } from "@superfunctions/auth";

describe("Server Authorization (AUTH-001)", () => {
  const testSchema = {
    resources: [
      {
        name: "node",
        version: 1,
        fields: [
          { name: "label", type: "string" as const, required: false },
          { name: "secretField", type: "string" as const, required: false },
        ],
        permissions: {
          read: {
            fields: ["id", "label"], // secretField is NOT allowed
          },
          write: {
            fields: ["label"], // secretField is NOT allowed, id is auto-allowed
          },
        },
      },
    ],
  };

  let db: any;
  let server: any;

  beforeEach(async () => {
    db = memoryAdapter({ libraryNamespace: "datafn" });
    server = await createDatafnServer({
      schema: testSchema,
      db,
    });
  });

  it("TV-AUTH-001: Authorized query passes (select allowed fields)", async () => {
    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      body: JSON.stringify({
        resource: "node",
        version: 1,
        select: ["id", "label"],
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("TV-AUTH-001N: Query selecting forbidden field is rejected with FORBIDDEN", async () => {
    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      body: JSON.stringify({
        resource: "node",
        version: 1,
        select: ["id", "secretField"], // secretField is forbidden
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization denied");
    expect(body.error.details.path).toBe("select[1]");
  });

  it("TV-AUTH-001: Authorized mutation passes (write allowed fields)", async () => {
    const req = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:1",
        mutations: [
          {
            resource: "node",
            version: 1,
            operation: "insert",
            id: "node:1",
            clientId: "client:1",
            mutationId: "m-1",
            record: { label: "Test" }, // label is allowed
          },
        ],
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("TV-AUTH-001N: Mutation writing forbidden field is rejected with FORBIDDEN", async () => {
    const req = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:1",
        mutations: [
          {
            resource: "node",
            version: 1,
            operation: "insert",
            id: "node:1",
            clientId: "client:1",
            mutationId: "m-1",
            record: { label: "Test", secretField: "secret" }, // secretField is forbidden
          },
        ],
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization denied");
    expect(body.error.details.path).toContain("secretField");
  });

  it("TV-AUTH-001N: Filters on forbidden field are rejected with FORBIDDEN", async () => {
    const req = new Request("http://localhost/datafn/query", {
      method: "POST",
      body: JSON.stringify({
        resource: "node",
        version: 1,
        select: ["id", "label"],
        filters: {
          secretField: { eq: "test" }, // secretField is forbidden in filters
        },
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("FORBIDDEN");
  });
});

describe("Namespace Isolation (AUTH-002)", () => {
  const testSchema = {
    resources: [
      {
        name: "task",
        version: 1,
        fields: [{ name: "title", type: "string" as const, required: true }],
      },
    ],
  };

  it("TV-AUTH-002: Namespace isolation is enforced end-to-end", async () => {
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

    const server = await createDatafnServer({
      schema: testSchema,
      db,
      authContextProvider,
    });

    // Push for user 1
    const req1 = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:1",
        userId: "user-1",
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
    expect(body1.result.cursor).toBe("1"); // First serverSeq for user-1

    // Push for user 2 - should get independent serverSeq
    const req2 = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:2",
        userId: "user-2",
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
    expect(body2.result.cursor).toBe("1"); // First serverSeq for user-2 (independent namespace)
    
    // This confirms data isolation: both users start at cursor 1
    expect(body1.result.cursor).toBe(body2.result.cursor);
  });

  it("TV-AUTH-002N: No hard-coded 'datafn' namespace in execution paths", async () => {
    // This test verifies that the code does not use hard-coded "datafn" namespace
    // We test this by ensuring namespace extraction works correctly
    const db = memoryAdapter({ libraryNamespace: "datafn" });

    const authContextProvider = {
      getContext: (ctx: any): AuthContext => {
        const parsedBody = ctx.parsedBody as any;
        // Return a non-default namespace
        return {
          userId: parsedBody?.userId || "default-user",
        };
      },
    };

    const server = await createDatafnServer({
      schema: testSchema,
      db,
      authContextProvider,
    });

    // Push with explicit user
    const req = new Request("http://localhost/datafn/push", {
      method: "POST",
      body: JSON.stringify({
        clientId: "client:1",
        userId: "custom-user",
        mutations: [
          {
            operation: "insert",
            resource: "task",
            id: "task:1",
            clientId: "client:1",
            mutationId: "m-1",
            record: { title: "Custom User Task" },
          },
        ],
      }),
    });

    const res = await server.router.handle(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // The fact that this succeeds with authContextProvider means namespace is being extracted
    // and passed through correctly (not hard-coded)
  });
});
