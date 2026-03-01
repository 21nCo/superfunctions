/**
 * PHASE_07 Performance Tests
 * TV-PER-001: Batch serverSeq allocation (one getNextServerSeqBatch call per push)
 * TV-PER-002: Batch relation DB calls (<5 calls for 50-item relate)
 * TV-PER-003: Targeted relation filter via findRecords (not getRecords full scan)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDatafnServer } from "../src/server.js";
import { memoryAdapter } from "@superfunctions/db/adapters";
import { executePush } from "../src/execution/sync/push.js";
import { ChangeTrackingService } from "../src/execution/sync/change-tracking.js";
import { evaluateFilter } from "../src/execution/query/filters.js";
import type { DatafnSchema } from "@datafn/core";

// ---------------------------------------------------------------------------
// Shared schema: projects (one) → tasks (many) via projectId FK
// ---------------------------------------------------------------------------
const oneManySchema: DatafnSchema = {
  resources: [
    {
      name: "projects",
      version: 1,
      idPrefix: "project",
      fields: [
        { name: "name", type: "string" as const, required: true },
      ],
    },
    {
      name: "tasks",
      version: 1,
      idPrefix: "task",
      fields: [
        { name: "title", type: "string" as const, required: true },
        { name: "projectId", type: "string" as const, required: false },
      ],
    },
  ],
  relations: [
    {
      from: "projects",
      relation: "tasks",
      to: "tasks",
      type: "one-many" as const,
      fkField: "projectId",
    },
  ],
};

function makeMemoryIdempotencyStore() {
  const store = new Map<string, any>();
  return {
    get: vi.fn(async (clientId: string, mutationId: string) =>
      store.get(`${clientId}:${mutationId}`),
    ),
    set: vi.fn(async (clientId: string, mutationId: string, result: any) => {
      store.set(`${clientId}:${mutationId}`, result);
    }),
  };
}

// ---------------------------------------------------------------------------
// TV-PER-001: Batch serverSeq allocation
// ---------------------------------------------------------------------------
describe("PER-001: Batch serverSeq allocation", () => {
  it("TV-PER-001: push 50 mutations calls getNextServerSeqBatch once with count=50", async () => {
    const db = memoryAdapter({ libraryNamespace: "datafn" });
    await db.initialize();
    const idempotencyStore = makeMemoryIdempotencyStore();

    // Spy before constructing ChangeTrackingService inside executePush
    const batchSpy = vi.spyOn(
      ChangeTrackingService.prototype,
      "getNextServerSeqBatch",
    );

    const mutations = Array.from({ length: 50 }, (_, i) => ({
      clientId: "client-perf",
      mutationId: `mut-perf-${i}`,
      operation: "insert",
      resource: "tasks",
      id: `task-perf-${i}`,
      record: { title: `Task ${i}` },
    }));

    const result = await executePush(
      { clientId: "client-perf", mutations },
      oneManySchema,
      db,
      idempotencyStore,
      "datafn",
    );

    expect(result.ok).toBe(true);
    expect(result.applied).toHaveLength(50);

    // PER-001: exactly one batch allocation call, with the full count
    const batchCalls = batchSpy.mock.calls;
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0][0]).toBe(50);

    batchSpy.mockRestore();
  });

  it("TV-PER-001 (edge): empty push does not call getNextServerSeqBatch", async () => {
    const db = memoryAdapter({ libraryNamespace: "datafn" });
    await db.initialize();
    const idempotencyStore = makeMemoryIdempotencyStore();
    const batchSpy = vi.spyOn(
      ChangeTrackingService.prototype,
      "getNextServerSeqBatch",
    );

    const result = await executePush(
      { clientId: "client-perf", mutations: [] },
      oneManySchema,
      db,
      idempotencyStore,
      "datafn",
    );

    expect(result.ok).toBe(true);
    expect(batchSpy.mock.calls).toHaveLength(0);

    batchSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// TV-PER-002: Batch relation DB calls (one-many relate → single updateMany)
// ---------------------------------------------------------------------------
describe("PER-004: Batch relation DB calls", () => {
  let db: any;
  let server: any;
  const BATCH_SIZE = 50;

  beforeEach(async () => {
    db = memoryAdapter({ libraryNamespace: "datafn" });
    await db.initialize();

    // Seed one project and 50 tasks
    await db.create({
      model: "projects",
      data: { id: "project-batch", name: "Batch Project" },
      namespace: "datafn",
    });
    for (let i = 0; i < BATCH_SIZE; i++) {
      await db.create({
        model: "tasks",
        data: { id: `task-batch-${i}`, title: `Task ${i}` },
        namespace: "datafn",
      });
    }

    server = await createDatafnServer({ allowUnknownResources: true, schema: oneManySchema, db });
  });

  it("TV-PER-002: one-many relate with 50 items uses 1 updateMany, not 50 update calls", async () => {
    // Spy AFTER seeding and server creation so seed writes don't pollute counts
    const updateSpy = vi.spyOn(db, "update");
    const updateManySpy = vi.spyOn(db, "updateMany");

    const taskRefs = Array.from({ length: BATCH_SIZE }, (_, i) => ({
      $ref: `task-batch-${i}`,
    }));

    const req = new Request("http://localhost/datafn/mutation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "projects",
        version: "1",
        clientId: "client-batch",
        mutationId: "mut-relate-batch",
        operation: "relate",
        id: "project-batch",
        relations: { tasks: taskRefs },
      }),
    });

    const res = await server.router.handle(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    // PER-004: updateMany called once for task FK updates (batch path)
    const updateManyCalls = (updateManySpy.mock.calls as any[]).filter(
      (c) => c[0]?.model === "tasks",
    );
    // PER-004: update NOT called for individual task FK updates
    const updateCalls = (updateSpy.mock.calls as any[]).filter(
      (c) => c[0]?.model === "tasks",
    );

    expect(updateManyCalls).toHaveLength(1);
    expect(updateCalls).toHaveLength(0);

    // Verify all 50 target IDs are in the updateMany where clause
    const whereValue = updateManyCalls[0][0].where?.find(
      (w: any) => w.field === "id" && w.operator === "in",
    )?.value;
    expect(whereValue).toHaveLength(BATCH_SIZE);

    updateSpy.mockRestore();
    updateManySpy.mockRestore();
  });

  it("TV-PER-002 (negative): single-item relate still works (sequential path)", async () => {
    const updateSpy = vi.spyOn(db, "update");
    const updateManySpy = vi.spyOn(db, "updateMany");

    const req = new Request("http://localhost/datafn/mutation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "projects",
        version: "1",
        clientId: "client-single",
        mutationId: "mut-relate-single",
        operation: "relate",
        id: "project-batch",
        relations: { tasks: [{ $ref: "task-batch-0" }] },
      }),
    });

    const res = await server.router.handle(req, {});
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    // Single item: falls back to sequential update (not updateMany)
    const updateManyCalls = (updateManySpy.mock.calls as any[]).filter(
      (c) => c[0]?.model === "tasks",
    );
    const updateCalls = (updateSpy.mock.calls as any[]).filter(
      (c) => c[0]?.model === "tasks",
    );

    expect(updateManyCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(1);

    updateSpy.mockRestore();
    updateManySpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// TV-PER-003: Targeted relation filter uses findRecords, not getRecords
// ---------------------------------------------------------------------------
describe("PER-005: Targeted relation filter (findRecords)", () => {
  it("TV-PER-003: one-many $any filter calls findRecords, not getRecords", () => {
    const mockTasks = [
      { id: "task-1", title: "Task A", projectId: "project-1" },
      { id: "task-2", title: "Task B", projectId: "project-1" },
    ];

    const store = {
      getRecord: vi.fn((_resource: string, _id: string) => null),
      getRecords: vi.fn((_resource: string) => mockTasks),
      findRecords: vi.fn(
        (_resource: string, _field: string, _value: unknown) => mockTasks,
      ),
      getJoinRows: vi.fn((_key: string) => []),
    };

    const project = { id: "project-1", name: "Test Project" };
    // Filter: projects where ANY related task has title = "Task A"
    const filter = { tasks: { $any: { title: "Task A" } } };

    const result = evaluateFilter(
      project,
      filter,
      "projects",
      oneManySchema,
      store,
    );

    expect(result).toBe(true);

    // PER-005: findRecords used for targeted one-many lookup
    expect(store.findRecords).toHaveBeenCalledWith(
      "tasks",       // target resource
      "projectId",   // FK field
      "project-1",   // parent record id
    );

    // PER-005: getRecords NOT called — no full table scan
    expect(store.getRecords).not.toHaveBeenCalled();
  });

  it("TV-PER-003: many-one inverse filter calls findRecords on source resource", () => {
    // many-one relation: task →(manyOne) project, with inverse name for querying from projects
    // findRelationBidirectional requires `inverse` field to resolve from the "to" side
    const manyOneSchema: DatafnSchema = {
      resources: [
        {
          name: "tasks",
          version: 1,
          fields: [
            { name: "title", type: "string" as const, required: true },
            { name: "projectId", type: "string" as const, required: false },
          ],
        },
        {
          name: "projects",
          version: 1,
          fields: [{ name: "name", type: "string" as const, required: true }],
        },
      ],
      relations: [
        {
          from: "tasks",
          relation: "project",
          to: "projects",
          type: "many-one" as const,
          fkField: "projectId",
          inverse: "ownedTasks", // name used when filtering from the "projects" side
        },
      ],
    };

    const mockTasks = [
      { id: "task-1", title: "Task A", projectId: "project-1" },
    ];

    const store = {
      getRecord: vi.fn((_resource: string, _id: string) => null),
      getRecords: vi.fn((_resource: string) => []),
      findRecords: vi.fn(
        (_resource: string, _field: string, _value: unknown) => mockTasks,
      ),
      getJoinRows: vi.fn((_key: string) => []),
    };

    const project = { id: "project-1", name: "Test Project" };
    // Filter from "projects" side using the inverse relation name
    const filter = { ownedTasks: { $any: { title: "Task A" } } };

    evaluateFilter(project, filter, "projects", manyOneSchema, store);

    // PER-005: many-one inverse (projects as "to") uses findRecords on source ("tasks")
    expect(store.findRecords).toHaveBeenCalledWith(
      "tasks",       // source resource (rel.from)
      "projectId",   // FK field
      "project-1",   // parent record id
    );
    expect(store.getRecords).not.toHaveBeenCalled();
  });
});
