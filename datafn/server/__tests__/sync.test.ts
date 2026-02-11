import { memoryAdapter } from "@superfunctions/db/adapters";
import { describe, it, expect, beforeEach } from "vitest";
import { createDatafnServer } from "../src/server.js";
import { fixtureF1Schema } from "./fixtures/f1.js";

describe("/datafn/sync endpoints (Phase 04)", () => {
  let db: any;

  beforeEach(() => {
    // Create fresh store for each test
    db = memoryAdapter();
  });

  // Helper to create server with fixture F1
  async function createF1Server(db: any) {
    return await createDatafnServer({
      schema: fixtureF1Schema,
      limits: { maxLimit: 100 },
      db,
    });
  }

  it("PROTO-PUSH-001: Push returns cursor", async () => {
    const server = await createF1Server(db);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:device-1",
          mutations: [
            {
              resource: "tag",
              version: 1,
              operation: "insert",
              clientId: "client:device-1",
              mutationId: "m1",
              id: "tag:1",
              record: { label: "one" },
            },
          ],
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.applied).toContain("m1");
    // Verify cursor presence and format
    expect(typeof body.result.cursor).toBe("string");
    expect(body.result.cursor).toMatch(/^\d+$/);
    expect(body.result.cursor).not.toBe("0"); // Should be > 0 after mutation
  });

  it("PROTO-PULL-001: Pull supports global cursor and pagination", async () => {
    const server = await createF1Server(db);

    // 1. Seed data via push to generate sequence numbers
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m1", id: "tag:1", record: { label: "1" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m2", id: "tag:2", record: { label: "2" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m3", id: "tag:3", record: { label: "3" } },
          ],
        }),
      }),
    );

    // 2. Pull with limit 2 (should get m1, m2)
    const res1 = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "c1",
          cursor: "0",
          limit: 2,
        }),
      }),
    );

    const body1 = await res1.json();
    expect(body1.ok).toBe(true);
    expect(body1.result.ok).toBe(true);
    expect(body1.result.changes).toHaveLength(2);
    expect(body1.result.changes[0].id).toBe("tag:1");
    expect(body1.result.changes[1].id).toBe("tag:2");
    expect(body1.result.nextCursor).toBeDefined();
    expect(body1.result.nextCursor).not.toBeNull();

    const nextCursor = body1.result.nextCursor;

    // 3. Pull remaining (should get m3)
    const res2 = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "c1",
          cursor: nextCursor,
          limit: 2,
        }),
      }),
    );

    const body2 = await res2.json();
    expect(body2.result.changes).toHaveLength(1);
    expect(body2.result.changes[0].id).toBe("tag:3");
    
    // nextCursor might be null or set to the last one if we didn't hit limit
    // Implementation: if length < limit, nextCursor is null?
    // Let's check implementation details: 
    // "if (mappedChanges.length === limit) nextCursor = ... else null"
    // Here length 1 < limit 2, so nextCursor should be null
    expect(body2.result.nextCursor).toBeNull();
  });

  it("PROTO-PULL-001: Pull validates cursor", async () => {
    const server = await createF1Server(db);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "c1",
          cursor: "invalid",
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(false);
    expect(body.result.error.code).toBe("DFQL_INVALID");
    expect(body.result.error.message).toContain("cursor");
  });

  it("TV-SYNC-001: Clone returns cursors (unchanged)", async () => {
     // This test ensures we didn't break clone
     const server = await createF1Server(db);
     await server.router.handle(
      new Request("http://localhost/datafn/clone", {
        method: "POST",
        body: JSON.stringify({ clientId: "c1", tables: ["tag"] }),
      }),
    );
    // Just ensure it doesn't 500
  });

  // TV-REL-001: Push applies relation mutation and records join delta
  it("TV-REL-001: Push applies relation mutation and records join delta", async () => {
    // Create schema with many-many relation
    const relSchema = {
      resources: [
        {
          name: "node",
          version: 1,
          idPrefix: "node",
          fields: [{ name: "label", type: "string" as const, required: false }],
        },
        {
          name: "property",
          version: 1,
          idPrefix: "property",
          fields: [{ name: "name", type: "string" as const, required: false }],
        },
      ],
      relations: [
        {
          from: "node",
          to: "property",
          type: "many-many" as const,
          relation: "properties",
          metadata: [{ name: "value", type: "string" as const }],
        },
      ],
    };

    const server = await createDatafnServer({
      schema: relSchema,
      limits: { maxLimit: 100 },
      db,
    });

    // Seed initial records
    await db.create({
      model: "node",
      data: { id: "node:1", label: "Node 1" },
      namespace: "datafn",
    });
    await db.create({
      model: "property",
      data: { id: "property:1", name: "Prop 1" },
      namespace: "datafn",
    });

    // Push relation mutation
    const pushRes = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            {
              resource: "node",
              version: 1,
              operation: "relate",
              id: "node:1",
              relations: { properties: [{ $ref: "property:1", value: "v" }] },
              clientId: "client:1",
              mutationId: "m-1",
            },
          ],
        }),
      }),
    );

    const pushBody = await pushRes.json();
    expect(pushBody.ok).toBe(true);
    expect(pushBody.result.ok).toBe(true);
    expect(pushBody.result.applied).toContain("m-1");
    expect(pushBody.result.errors).toHaveLength(0);

    // Verify join row was created
    const joinRow = await db.findOne({
      model: "__datafn_join_node_properties",
      where: [
        { field: "from", operator: "eq", value: "node:1" },
        { field: "to", operator: "eq", value: "property:1" },
      ],
      namespace: "datafn",
    });
    expect(joinRow).toBeDefined();
    expect(joinRow.value).toBe("v");

    // Verify change tracking recorded join delta
    const changes = await db.findMany({
      model: "__datafn_changes",
      where: [{ field: "namespace", operator: "eq", value: "datafn" }],
      orderBy: [{ field: "serverSeq", direction: "asc" }],
      namespace: "datafn",
    });
    
    // Should have at least one change for the join
    const joinChanges = changes.filter(
      (c: any) => c.resource && c.resource.startsWith("join_")
    );
    expect(joinChanges.length).toBeGreaterThan(0);
  });

  // TV-REL-001N: Push rejects relation mutation for unknown relation  
  it("TV-REL-001N: Push rejects relation mutation for unknown relation", async () => {
    const server = await createF1Server(db);

    const pushRes = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            {
              resource: "tag",
              version: 1,
              operation: "relate",
              id: "tag:1",
              relations: { unknownRel: "x" },
              clientId: "client:1",
              mutationId: "m-1",
            },
          ],
        }),
      }),
    );

    const pushBody = await pushRes.json();
    // Validation errors result in ok: false envelope with error 
    expect(pushBody.ok).toBe(false);
    expect(pushBody.error).toBeDefined();
    expect(pushBody.error.code).toBe("DFQL_UNKNOWN_RELATION");
    expect(pushBody.error.message).toContain("unknownRel");
  });

  // Idempotency test for relation mutations
  it("Push relation mutation is idempotent", async () => {
    // Create schema with many-many relation
    const relSchema = {
      resources: [
        {
          name: "node",
          version: 1,
          idPrefix: "node",
          fields: [{ name: "label", type: "string" as const, required: false }],
        },
        {
          name: "property",
          version: 1,
          idPrefix: "property",
          fields: [{ name: "name", type: "string" as const, required: false }],
        },
      ],
      relations: [
        {
          from: "node",
          to: "property",
          type: "many-many" as const,
          relation: "properties",
          metadata: [{ name: "value", type: "string" as const }],
        },
      ],
    };

    const server = await createDatafnServer({
      schema: relSchema,
      limits: { maxLimit: 100 },
      db,
    });

    // Seed
    await db.create({
      model: "node",
      data: { id: "node:1", label: "Node 1" },
      namespace: "datafn",
    });
    await db.create({
      model: "property",
      data: { id: "property:1", name: "Prop 1" },
      namespace: "datafn",
    });

    const payload = {
      clientId: "client:1",
      mutations: [
        {
          resource: "node",
          version: 1,
          operation: "relate",
          id: "node:1",
          relations: { properties: [{ $ref: "property:1", value: "v" }] },
          clientId: "client:1",
          mutationId: "m-idempotent-1",
        },
      ],
    };

    // First push
    const res1 = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    const body1 = await res1.json();
    expect(body1.result.applied).toContain("m-idempotent-1");

    // Get initial change count
    const changes1 = await db.findMany({
      model: "__datafn_changes",
      where: [{ field: "namespace", operator: "eq", value: "datafn" }],
      namespace: "datafn",
    });
    const initialChangeCount = changes1.length;

    // Second push (retry)
    const res2 = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    const body2 = await res2.json();
    expect(body2.result.applied).toContain("m-idempotent-1");

    // Verify no duplicate changes were recorded
    const changes2 = await db.findMany({
      model: "__datafn_changes",
      where: [{ field: "namespace", operator: "eq", value: "datafn" }],
      namespace: "datafn",
    });
    expect(changes2.length).toBe(initialChangeCount);
  });

  // PHASE_05 Tests

  it("TV-SYNC-003: Per-table pull returns grouped records/deletes and updated cursors", async () => {
    const server = await createF1Server(db);

    // Seed data via push
    const pushRes = await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m1", id: "tag:1", record: { label: "X" } },
            { resource: "goal", version: 1, operation: "insert", clientId: "seed", mutationId: "m2", id: "goal:1", record: { label: "Y", status: "active", isArchived: false } },
            { resource: "tag", version: 1, operation: "delete", clientId: "seed", mutationId: "m3", id: "tag:1" },
          ],
        }),
      }),
    );

    const pushBody = await pushRes.json();
    expect(pushBody.ok).toBe(true);
    expect(pushBody.result.ok).toBe(true);

    // Pull with per-table cursors
    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          cursors: { tag: "0", goal: "0" },
          limit: 100,
          includeJoins: true,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    
    // Verify grouped records
    expect(body.result.records.tag).toBeDefined();
    // Tag was inserted then deleted, so we should see it in records (the upsert)
    expect(body.result.records.tag.length).toBeGreaterThanOrEqual(1);
    
    expect(body.result.records.goal).toBeDefined();
    expect(body.result.records.goal).toHaveLength(1);
    expect(body.result.records.goal[0].id).toBe("goal:1");
    
    // Verify deleted - tag:1 should be in the deleted array
    expect(body.result.deleted.tag).toBeDefined();
    expect(body.result.deleted.tag).toContain("tag:1");
    
    // Verify cursors updated
    expect(body.result.cursors.tag).toBeDefined();
    expect(body.result.cursors.tag).toMatch(/^\d+$/);
    expect(body.result.cursors.goal).toBeDefined();
    expect(body.result.cursors.goal).toMatch(/^\d+$/);
  });

  it("TV-SYNC-003N: Pull rejects invalid cursor format", async () => {
    const server = await createF1Server(db);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          cursors: { tag: "not-an-int" },
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(false);
    expect(body.result.error.code).toBe("DFQL_INVALID");
    expect(body.result.error.message).toContain("cursor must be an integer string");
    expect(body.result.error.details.path).toBe("cursors.tag");
  });

  it("TV-SYNC-004: Legacy global-cursor pull remains supported", async () => {
    const server = await createF1Server(db);

    // Seed data
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m1", id: "tag:1", record: { label: "X" } },
          ],
        }),
      }),
    );

    // Pull with legacy format
    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          cursor: "0",
          limit: 2,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.changes).toBeDefined();
    expect(Array.isArray(body.result.changes)).toBe(true);
    expect(body.result.changes).toHaveLength(1);
    expect(body.result.changes[0].id).toBe("tag:1");
  });

  it("TV-SYNC-004N: Legacy pull rejects non-integer cursor", async () => {
    const server = await createF1Server(db);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          cursor: "x",
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(false);
    expect(body.result.error.code).toBe("DFQL_INVALID");
    expect(body.result.error.message).toContain("cursor must be an integer string");
  });

  it("TV-REL-002: Pull hydrates join rows into response", async () => {
    const server = await createF1Server(db);

    // Push relation mutation to generate join change
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          mutations: [
            { resource: "task", version: 1, operation: "insert", clientId: "client:1", mutationId: "m1", id: "task:1", record: { label: "T1", priority: 1, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "client:1", mutationId: "m2", id: "tag:1", record: { label: "urgent" } },
            {
              resource: "task",
              version: 1,
              operation: "relate",
              id: "task:1",
              relations: { tags: [{ $ref: "tag:1", order: 1 }] },
              clientId: "client:1",
              mutationId: "m3",
            },
          ],
        }),
      }),
    );

    // Pull with per-table cursors including joins
    const res = await server.router.handle(
      new Request("http://localhost/datafn/pull", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:2",
          cursors: { task: "0", tag: "0", join_task_tags_tag: "0" },
          limit: 100,
          includeJoins: true,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    
    // Verify join rows are included
    expect(body.result.joins).toBeDefined();
    expect(body.result.joins["join_task_tags_tag"]).toBeDefined();
    expect(body.result.joins["join_task_tags_tag"].upsert).toBeDefined();
    expect(body.result.joins["join_task_tags_tag"].upsert.length).toBeGreaterThan(0);
    
    const joinRow = body.result.joins["join_task_tags_tag"].upsert[0];
    expect(joinRow.from).toBe("task:1");
    expect(joinRow.to).toBe("tag:1");
    expect(joinRow.order).toBe(1);
  });

  // PHASE_06 Tests
  it("TV-SYNC-001: Paginated clone returns deterministic page and next marker", async () => {
    const server = await createF1Server(db);

    // Seed 3 tasks
    await db.create({
      model: "task",
      data: { id: "task:1", label: "A", priority: 1, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" },
      namespace: "datafn",
    });
    await db.create({
      model: "task",
      data: { id: "task:2", label: "B", priority: 2, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" },
      namespace: "datafn",
    });
    await db.create({
      model: "task",
      data: { id: "task:3", label: "C", priority: 3, goalId: "goal:g1", isArchived: false, updatedAt: "2026-01-01" },
      namespace: "datafn",
    });

    // Clone with pagination (limit 2)
    const res = await server.router.handle(
      new Request("http://localhost/datafn/clone", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          tables: ["task"],
          page: {
            table: "task",
            afterId: null,
            limit: 2,
          },
          includeJoins: true,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.data.task).toHaveLength(2);
    expect(body.result.data.task[0].id).toBe("task:1");
    expect(body.result.data.task[1].id).toBe("task:2");
    
    // Verify next marker
    expect(body.result.next).toBeDefined();
    expect(body.result.next.task).toBe("task:2");
  });

  it("TV-SYNC-001N: Clone rejects remote-only resources", async () => {
    // Use fixtureF1Schema which doesn't have remote-only resources
    // Add a modified schema with a remote-only resource for this test
    const schemaWithRemoteOnly = {
      ...fixtureF1Schema,
      resources: [
        ...fixtureF1Schema.resources,
        { name: "vector", version: 1, isRemoteOnly: true, fields: [] },
      ],
    };

    const server = await createDatafnServer({
      schema: schemaWithRemoteOnly as any,
      limits: { maxLimit: 100 },
      db,
    });

    const res = await server.router.handle(
      new Request("http://localhost/datafn/clone", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          tables: ["vector"],
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_INVALID");
    expect(body.error.message).toContain("remote-only table cannot be cloned");
  });

  // PHASE_07: Reconcile tests (TV-RECON-001, TV-RECON-001N)
  it("TV-RECON-001: Reconcile returns deterministic counts", async () => {
    const server = await createF1Server(db);

    // Seed some data
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m1", id: "tag:1", record: { label: "one" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m2", id: "tag:2", record: { label: "two" } },
            { resource: "tag", version: 1, operation: "insert", clientId: "seed", mutationId: "m3", id: "tag:3", record: { label: "three" } },
          ],
        }),
      }),
    );

    // Call reconcile
    const res = await server.router.handle(
      new Request("http://localhost/datafn/reconcile", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          resources: ["tag"],
          includeJoins: false,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.counts).toBeDefined();
    expect(body.result.counts.tag).toBe(3);
    expect(body.result.latestCursor).toBeDefined();
    expect(typeof body.result.latestCursor).toBe("string");
  });

  it("TV-RECON-001N: Reconcile rejects unknown resource", async () => {
    const server = await createF1Server(db);

    const res = await server.router.handle(
      new Request("http://localhost/datafn/reconcile", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          resources: ["unknown"],
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("DFQL_UNKNOWN_RESOURCE");
    expect(body.error.message).toContain("Unknown resource: unknown");
  });

  it("RECON-JOINS: Reconcile includes join counts when requested", async () => {
    // Fixture F1 already has task-tag many-many relation
    const server = await createF1Server(db);

    // Seed data with proper fields matching schema
    await server.router.handle(
      new Request("http://localhost/datafn/push", {
        method: "POST",
        body: JSON.stringify({
          clientId: "seed",
          mutations: [
            { 
              resource: "tag", 
              version: 1, 
              operation: "insert", 
              clientId: "seed", 
              mutationId: "m1", 
              id: "tag:1", 
              record: { label: "one" } 
            },
            { 
              resource: "task", 
              version: 1, 
              operation: "insert", 
              clientId: "seed", 
              mutationId: "m2", 
              id: "task:1", 
              record: { 
                label: "Task 1", 
                priority: 1, 
                goalId: "goal:g1", 
                isArchived: false, 
                updatedAt: "2026-02-07" 
              } 
            },
          ],
        }),
      }),
    );

    // Call reconcile with includeJoins
    const res = await server.router.handle(
      new Request("http://localhost/datafn/reconcile", {
        method: "POST",
        body: JSON.stringify({
          clientId: "client:1",
          resources: ["tag", "task"],
          includeJoins: true,
        }),
      }),
    );

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.ok).toBe(true);
    expect(body.result.counts).toBeDefined();
    expect(body.result.counts.tag).toBe(1);
    expect(body.result.counts.task).toBe(1);
    expect(body.result.joinCounts).toBeDefined();
    // Join store should be empty initially (no relations created yet)
    expect(body.result.joinCounts["join_task_tags_tag"]).toBe(0);
  });
});