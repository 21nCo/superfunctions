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
      fields: [
        { name: "title", type: "string", required: false },
        { name: "note", type: "string", required: false },
        { name: "dueAt", type: "date", required: false },
      ],
    },
  ],
  relations: [],
};

const relationSchema: DatafnSchema = {
  resources: [
    {
      name: "folders",
      version: 1,
      fields: [{ name: "name", type: "string", required: false }],
    },
    {
      name: "notes",
      version: 1,
      fields: [
        { name: "title", type: "string", required: false },
        { name: "folderId", type: "string", required: false },
      ],
    },
  ],
  relations: [
    {
      from: "notes",
      to: "folders",
      type: "many-one",
      relation: "folder",
      inverse: "notes",
      fkField: "folderId",
    },
  ],
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

  it("decodes local dates and keeps omitted fields off a replaced row", async () => {
    const storage = await hydratingStorage();
    const dueAt = Date.UTC(2026, 0, 2);
    await storage.upsertRecord("tasks", {
      id: "task:2",
      title: "Open, edited",
      note: "kept local only",
      dueAt,
    });
    await pendingChange(storage, "mutation:edit", {
      operation: "merge",
      id: "task:2",
      record: { title: "Open, edited", dueAt },
    });

    const result = (await executeQuery(
      remoteReturning({
        data: [
          { id: "task:1", title: "Open", dueAt: Date.UTC(2026, 0, 1) },
          { id: "task:2", title: "Open", dueAt: Date.UTC(2026, 0, 1) },
        ],
        nextCursor: "after-task:2",
      }),
      { resource: "tasks", omit: ["note"], sort: ["id:asc"], limit: 2 },
      storage,
      [],
      schema,
    )) as { data: Array<Record<string, unknown>>; nextCursor: unknown };

    expect(result.nextCursor).toBe("after-task:2");
    expect(result.data.map((row) => row.id)).toEqual(["task:1", "task:2"]);
    expect(result.data[1]).not.toHaveProperty("note");
    expect(result.data[1].title).toBe("Open, edited");
    for (const row of result.data) expect(row.dueAt).toBeInstanceOf(Date);
    expect((result.data[1].dueAt as Date).getTime()).toBe(dueAt);
  });

  it("keeps the remote row shape and untouched fields when it overlays local fields", async () => {
    const storage = await hydratingStorage();
    // A partial local row: the pending merge reached storage before the clone.
    await storage.upsertRecord("tasks", { id: "task:2", note: "edited note" });
    await pendingChange(storage, "mutation:edit", {
      operation: "merge",
      id: "task:2",
      record: { note: "edited note" },
    });
    const remoteRow = {
      id: "task:2",
      title: "Open",
      note: "remote note",
      project: { id: "project:1", name: "Server-visible" },
      $relation_metadata: { role: "owner" },
    };

    const result = await executeQuery(
      remoteReturning({ data: [remoteRow], nextCursor: "after-task:2" }),
      { resource: "tasks", select: ["*", "project.*"], limit: 1 },
      storage,
      [],
      schema,
    );

    expect(result).toEqual({
      data: [{ ...remoteRow, note: "edited note" }],
      nextCursor: "after-task:2",
    });
  });

});

const effectsSchema: DatafnSchema = {
  resources: [
    {
      name: "tasks",
      version: 1,
      fields: [
        { name: "title", type: "string", required: false },
        { name: "note", type: "string", required: false, nullable: true },
        { name: "status", type: "string", required: false, default: "todo" },
      ],
    },
  ],
  relations: [],
};

async function limitedPage(
  storage: MemoryStorageAdapter,
  rows: Array<Record<string, unknown>>,
  query: Record<string, unknown> = {},
  querySchema: DatafnSchema = effectsSchema,
): Promise<unknown> {
  return executeQuery(
    remoteReturning({ data: rows, nextCursor: "after-page" }),
    { resource: "tasks", sort: ["id:asc"], limit: rows.length, ...query },
    storage,
    [],
    querySchema,
  );
}

describe("Limited first page: remote row plus pending mutation effects", () => {
  it("shows a pending value for a field the server left unset, unless projected away", async () => {
    const storage = await hydratingStorage();
    await storage.upsertRecord("tasks", { id: "task:1", title: "Open", note: "new" });
    await pendingChange(storage, "mutation:note", {
      operation: "merge",
      id: "task:1",
      record: { note: "new" },
    });
    const row = { id: "task:1", title: "Open" };

    await expect(limitedPage(storage, [row])).resolves.toEqual({
      data: [{ id: "task:1", title: "Open", note: "new" }],
      nextCursor: "after-page",
    });
    await expect(limitedPage(storage, [row], { omit: ["note"] })).resolves.toEqual({
      data: [row],
      nextCursor: "after-page",
    });
    await expect(limitedPage(storage, [row], { select: ["id", "title"] })).resolves.toEqual({
      data: [row],
      nextCursor: "after-page",
    });
  });

  it("clears fields a pending replace leaves out and a pending null merge clears", async () => {
    const storage = await hydratingStorage();
    await pendingChange(storage, "mutation:replace", {
      operation: "replace",
      id: "task:1",
      record: { title: "Replaced" },
    });
    await pendingChange(storage, "mutation:clear", {
      operation: "merge",
      id: "task:2",
      record: { note: null },
    });

    await expect(limitedPage(storage, [
      { id: "task:1", title: "Open", note: "remote", status: "doing" },
      { id: "task:2", title: "Open", note: "remote" },
    ])).resolves.toEqual({
      data: [
        { id: "task:1", title: "Replaced", status: "todo" },
        { id: "task:2", title: "Open", note: null },
      ],
      nextCursor: "after-page",
    });
  });

  it("keeps a still-matching server row whose cached copy is partial or stale", async () => {
    const storage = await hydratingStorage();
    // A note-only merge before the clone leaves a partial row with defaults.
    await storage.upsertRecord("tasks", { id: "task:1", note: "n1", status: "todo" });
    await storage.upsertRecord("tasks", { id: "task:2", title: "Stale", note: "n2" });
    await pendingChange(storage, "mutation:n1", {
      operation: "merge",
      id: "task:1",
      record: { note: "n1" },
    });
    await pendingChange(storage, "mutation:n2", {
      operation: "merge",
      id: "task:2",
      record: { note: "n2" },
    });
    const rows = [
      { id: "task:1", title: "Open", status: "doing" },
      { id: "task:2", title: "Open", status: "doing" },
    ];
    const expected = {
      data: [
        { id: "task:1", title: "Open", status: "doing", note: "n1" },
        { id: "task:2", title: "Open", status: "doing", note: "n2" },
      ],
      nextCursor: "after-page",
    };

    await expect(limitedPage(storage, rows, { filters: { title: "Open" } }))
      .resolves.toEqual(expected);
    await expect(limitedPage(storage, rows, { filters: { status: "doing" } }))
      .resolves.toEqual(expected);
    await expect(limitedPage(storage, rows)).resolves.toEqual(expected);
  });

  it("drops a row only when its own pending writes stop it matching the filter", async () => {
    const storage = await hydratingStorage();
    await pendingChange(storage, "mutation:status", {
      operation: "merge",
      id: "task:1",
      record: { status: "done" },
    });

    await expect(limitedPage(
      storage,
      [{ id: "task:1", title: "Open", status: "doing" }, { id: "task:2", status: "doing" }],
      { filters: { status: "doing" } },
    )).resolves.toEqual({
      data: [{ id: "task:2", status: "doing" }],
      nextCursor: "after-page",
    });
  });

  it("drops a row trashed locally unless the query includes trashed rows", async () => {
    const storage = await hydratingStorage();
    await pendingChange(storage, "mutation:trash", { operation: "trash", id: "task:1" });
    const trashSchema: DatafnSchema = {
      ...effectsSchema,
      resources: [{ ...effectsSchema.resources[0], capabilities: ["trash"] }],
    };
    const rows = [{ id: "task:1", title: "Open" }, { id: "task:2", title: "Open" }];

    const hidden = (await limitedPage(storage, rows, {}, trashSchema)) as {
      data: Array<Record<string, unknown>>;
    };
    expect(hidden.data.map((row) => row.id)).toEqual(["task:2"]);
    const shown = (await limitedPage(
      storage,
      rows,
      { metadata: { includeTrashed: true } },
      trashSchema,
    )) as { data: Array<Record<string, unknown>> };
    expect(shown.data.map((row) => row.id)).toEqual(["task:1", "task:2"]);
    expect(shown.data[0].trashedAt).toBe(1);
  });

  it("sets the row's own foreign key from a pending many-one relate or unrelate", async () => {
    const storage = new MemoryStorageAdapter(["folders", "notes"]);
    await storage.setHydrationState("notes", "hydrating");
    const change = (mutationId: string, mutation: Record<string, unknown>) =>
      storage.changelogAppend({ clientId: "client:1", mutationId, timestampMs: 1, mutation });
    await change("mutation:relate", {
      resource: "notes",
      operation: "relate",
      id: "note:1",
      relations: { folder: "folder:2" },
    });
    await change("mutation:unrelate", {
      resource: "notes",
      operation: "unrelate",
      id: "note:2",
      relations: { folder: "folder:1" },
    });

    const result = await executeQuery(
      remoteReturning({
        data: [
          { id: "note:1", title: "A", folderId: "folder:1" },
          { id: "note:2", title: "B", folderId: "folder:1" },
        ],
        nextCursor: "after-note:2",
      }),
      { resource: "notes", filters: { folderId: "folder:1" }, sort: ["id:asc"], limit: 2 },
      storage,
      [],
      relationSchema,
    );

    expect(result).toEqual({ data: [], nextCursor: "after-note:2" });
  });

  it("reads pending changes beyond the first 100 changelog entries", async () => {
    const storage = await hydratingStorage();
    for (let index = 0; index < 120; index += 1) {
      await pendingChange(storage, `mutation:other-${index}`, {
        operation: "merge",
        id: `task:other-${index}`,
        record: { note: "x" },
      });
    }
    await pendingChange(storage, "mutation:delete", { operation: "delete", id: "task:1" });

    await expect(limitedPage(storage, [{ id: "task:1" }, { id: "task:2" }]))
      .resolves.toEqual({ data: [{ id: "task:2" }], nextCursor: "after-page" });
  });

  it("applies pending target edits, deletes and unrelates to a limited relation page", async () => {
    const storage = new MemoryStorageAdapter(["folders", "notes"]);
    await storage.setHydrationState("folders", "hydrating");
    const change = (mutationId: string, mutation: Record<string, unknown>) =>
      storage.changelogAppend({ clientId: "client:1", mutationId, timestampMs: 1, mutation });
    await change("mutation:edit", {
      resource: "notes",
      operation: "merge",
      id: "note:1",
      record: { title: "Edited" },
    });
    await change("mutation:delete", { resource: "notes", operation: "delete", id: "note:2" });
    await change("mutation:unrelate", {
      resource: "folders",
      operation: "unrelate",
      id: "folder:1",
      relations: { notes: "note:3" },
    });

    const result = await executeQuery(
      remoteReturning({
        data: [
          { id: "note:1", title: "Remote", folderId: "folder:1" },
          { id: "note:2", title: "Remote", folderId: "folder:1" },
          { id: "note:3", title: "Remote", folderId: "folder:1" },
          { id: "note:4", title: "Remote", folderId: "folder:1" },
        ],
        nextCursor: "after-note:4",
      }),
      { resource: "folders", relation: "notes", id: "folder:1", limit: 4 },
      storage,
      [],
      relationSchema,
    );

    expect(result).toEqual({
      data: [
        { id: "note:1", title: "Edited", folderId: "folder:1" },
        { id: "note:4", title: "Remote", folderId: "folder:1" },
      ],
      nextCursor: "after-note:4",
    });
  });
});
