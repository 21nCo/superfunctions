import { describe, expect, it, vi } from "vitest";
import type { DatafnSchema } from "@datafn/core";
import { executeQuery } from "../query.js";
import { MemoryStorageAdapter } from "../adapters/memoryStorage.js";
import type { DatafnRemoteAdapter } from "../client.js";

const schema: DatafnSchema = {
  resources: [
    {
      name: "tasks",
      version: 1,
      fields: [{ name: "title", type: "string", required: false }],
    },
  ],
  relations: [],
};

const remotePage = {
  data: [
    { id: "task:1", title: "Open" },
    { id: "task:2", title: "Open" },
    { id: "task:3", title: "Open" },
  ],
  nextCursor: "after-task:3",
  count: 10,
};

function remoteReturning(result: unknown): DatafnRemoteAdapter {
  return {
    query: vi.fn().mockResolvedValue({ ok: true, result }),
    mutation: vi.fn(),
    transact: vi.fn(),
    seed: vi.fn(),
    clone: vi.fn(),
    pull: vi.fn(),
    push: vi.fn(),
    reconcile: vi.fn(),
  };
}

async function hydratingStorage(): Promise<MemoryStorageAdapter> {
  const storage = new MemoryStorageAdapter(["tasks"]);
  await storage.setHydrationState("tasks", "hydrating");
  return storage;
}

async function pendingChange(
  storage: MemoryStorageAdapter,
  mutationId: string,
  mutation: Record<string, unknown>,
): Promise<void> {
  await storage.changelogAppend({
    clientId: "client:1",
    mutationId,
    timestampMs: 1,
    mutation: { resource: "tasks", ...mutation },
  });
}

describe("Query overlay on a limited first page", () => {
  it("shows a pending local edit in place and keeps the remote cursor", async () => {
    const storage = await hydratingStorage();
    await storage.upsertRecord("tasks", { id: "task:2", title: "Open, edited" });
    await pendingChange(storage, "mutation:edit", {
      operation: "merge",
      id: "task:2",
      record: { title: "Open, edited" },
    });

    const result = await executeQuery(
      remoteReturning(remotePage),
      { resource: "tasks", sort: ["id:asc"], limit: 3 },
      storage,
      [],
      schema,
    );

    expect(result).toEqual({
      data: [
        { id: "task:1", title: "Open" },
        { id: "task:2", title: "Open, edited" },
        { id: "task:3", title: "Open" },
      ],
      nextCursor: "after-task:3",
      count: 10,
    });
  });

  it("removes rows deleted locally or edited out of the filter, and adds no local rows", async () => {
    const storage = await hydratingStorage();
    await storage.upsertRecord("tasks", { id: "task:3", title: "Done" });
    await storage.upsertRecord("tasks", { id: "task:0", title: "Open" });
    await storage.upsertRecord("tasks", { id: "task:untracked", title: "Open" });
    await pendingChange(storage, "mutation:delete", {
      operation: "delete",
      id: "task:1",
    });
    await pendingChange(storage, "mutation:edit", {
      operation: "merge",
      id: "task:3",
      record: { title: "Done" },
    });
    await pendingChange(storage, "mutation:create", {
      operation: "insert",
      id: "task:0",
      record: { title: "Open" },
    });

    const result = await executeQuery(
      remoteReturning(remotePage),
      {
        resource: "tasks",
        filters: { title: "Open" },
        sort: ["id:asc"],
        offset: 0,
        limit: 3,
      },
      storage,
      [],
      schema,
    );

    expect(result).toEqual({
      data: [{ id: "task:2", title: "Open" }],
      nextCursor: "after-task:3",
      count: 10,
    });
  });

  it("returns the remote page unchanged when no row on it has a pending change", async () => {
    const storage = await hydratingStorage();
    await storage.upsertRecord("tasks", { id: "task:0", title: "Open" });
    await pendingChange(storage, "mutation:create", {
      operation: "insert",
      id: "task:0",
      record: { title: "Open" },
    });

    const result = await executeQuery(
      remoteReturning(remotePage),
      { resource: "tasks", sort: ["id:asc"], limit: 3 },
      storage,
      [],
      schema,
    );

    expect(result).toEqual(remotePage);
  });

  it("leaves offset and cursor pages to the remote result", async () => {
    const storage = await hydratingStorage();
    await pendingChange(storage, "mutation:delete", {
      operation: "delete",
      id: "task:1",
    });

    await expect(executeQuery(
      remoteReturning(remotePage),
      { resource: "tasks", sort: ["id:asc"], offset: 3, limit: 3 },
      storage,
      [],
      schema,
    )).resolves.toEqual(remotePage);
    await expect(executeQuery(
      remoteReturning(remotePage),
      {
        resource: "tasks",
        sort: ["id:asc"],
        limit: 3,
        cursor: { after: { id: "task:0" } },
      },
      storage,
      [],
      schema,
    )).resolves.toEqual(remotePage);
  });
});
