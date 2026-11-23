import { describe, expect, it, vi } from "vitest";
import type { DatafnSchema } from "@datafn/core";
import { executeQuery } from "../query.js";
import { MemoryStorageAdapter } from "../adapters/memoryStorage.js";
import { handleOfflineMutation } from "../offline/mutate.js";
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
        { name: "code", type: "string", required: false, readonly: true },
        { name: "profile", type: "object", required: false },
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

  it("clears fields a pending replace leaves out, as the server does, and a pending null merge", async () => {
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
      { id: "task:1", title: "Open", note: "remote", status: "doing", code: "C1", profile: { a: 1 } },
      { id: "task:2", title: "Open", note: "remote" },
    ])).resolves.toEqual({
      data: [
        { id: "task:1", title: "Replaced", note: null, status: "todo", code: "C1" },
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

  it("recreates a record merged after a pending delete without its old values", async () => {
    const storage = await hydratingStorage();
    await pendingChange(storage, "mutation:delete", { operation: "delete", id: "task:1" });
    await pendingChange(storage, "mutation:recreate", {
      operation: "merge",
      id: "task:1",
      record: { profile: { newMember: "new" } },
    });

    await expect(limitedPage(storage, [
      { id: "task:1", title: "Open", status: "doing", profile: { oldMember: "old" } },
    ])).resolves.toEqual({
      // The writer's recreate: returned fields it leaves out are cleared, defaults applied.
      data: [{ id: "task:1", status: "todo", profile: { newMember: "new" } }],
      nextCursor: "after-page",
    });
  });

  it("drops a row whose pending write fails a filter on a field the server did not return", async () => {
    const storage = await hydratingStorage();
    // The cache already holds the written value; it must not mask the change.
    await storage.upsertRecord("tasks", { id: "task:1", title: "Open", status: "done" });
    await pendingChange(storage, "mutation:status", {
      operation: "merge",
      id: "task:1",
      record: { status: "done" },
    });

    await expect(limitedPage(
      storage,
      [{ id: "task:1", title: "Open" }, { id: "task:2", title: "Open" }],
      { select: ["id", "title"], filters: { status: "doing", title: "Open" } },
    )).resolves.toEqual({
      data: [{ id: "task:2", title: "Open" }],
      nextCursor: "after-page",
    });
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

  it("removes relation-page rows moved to another parent from either side", async () => {
    const storage = new MemoryStorageAdapter(["folders", "notes"]);
    await storage.setHydrationState("folders", "hydrating");
    const change = (mutationId: string, mutation: Record<string, unknown>) =>
      storage.changelogAppend({ clientId: "client:1", mutationId, timestampMs: 1, mutation });
    await change("mutation:reparent", {
      resource: "notes",
      operation: "relate",
      id: "note:1",
      relations: { folder: "folder:2" },
    });
    await change("mutation:adopt", {
      resource: "folders",
      operation: "relate",
      id: "folder:2",
      relations: { notes: "note:2" },
    });
    const rows = [
      { id: "note:1", title: "A", folderId: "folder:1" },
      { id: "note:2", title: "B", folderId: "folder:1" },
      { id: "note:3", title: "C", folderId: "folder:1" },
    ];

    await expect(executeQuery(
      remoteReturning({ data: rows, nextCursor: "after-note:3" }),
      { resource: "folders", relation: "notes", id: "folder:1", limit: 3 },
      storage,
      [],
      relationSchema,
    )).resolves.toEqual({ data: [rows[2]], nextCursor: "after-note:3" });

    await storage.setHydrationState("notes", "hydrating");
    await expect(executeQuery(
      remoteReturning({ data: rows, nextCursor: "after-note:3" }),
      { resource: "notes", filters: { folderId: "folder:1" }, sort: ["id:asc"], limit: 3 },
      storage,
      [],
      relationSchema,
    )).resolves.toEqual({ data: [rows[2]], nextCursor: "after-note:3" });
  });

  it("follows a many-many link by logical edge, whichever side spelled it", async () => {
    const tagSchema: DatafnSchema = {
      resources: [
        { name: "projects", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        { name: "tags", version: 1, fields: [{ name: "label", type: "string", required: false }] },
      ],
      relations: [
        { from: "projects", to: "tags", type: "many-many", relation: "tags", inverse: "projects" },
      ],
    };
    const storage = new MemoryStorageAdapter(["projects", "tags"]);
    await storage.setHydrationState("projects", "hydrating");
    const change = (mutationId: string, mutation: Record<string, unknown>) =>
      storage.changelogAppend({ clientId: "client:1", mutationId, timestampMs: 1, mutation });
    await change("mutation:unlink", {
      resource: "projects",
      operation: "unrelate",
      id: "project:1",
      relations: { tags: ["tag:1", "tag:2"] },
    });
    await change("mutation:relink", {
      resource: "tags",
      operation: "relate",
      id: "tag:1",
      relations: { projects: "project:1" },
    });

    await expect(executeQuery(
      remoteReturning({
        data: [{ id: "tag:1", label: "one" }, { id: "tag:2", label: "two" }],
        nextCursor: "after-tag:2",
      }),
      { resource: "projects", relation: "tags", id: "project:1", limit: 2 },
      storage,
      [],
      tagSchema,
    )).resolves.toEqual({ data: [{ id: "tag:1", label: "one" }], nextCursor: "after-tag:2" });
  });

  it("keeps a row when a changed condition also reads a field the server did not return", async () => {
    const storage = await hydratingStorage();
    await storage.upsertRecord("tasks", { id: "task:1", title: "Closed", status: "done" });
    await pendingChange(storage, "mutation:status", {
      operation: "merge",
      id: "task:1",
      record: { status: "done" },
    });

    await expect(limitedPage(
      storage,
      [{ id: "task:1" }],
      { select: ["id"], filters: { $or: [{ status: "doing" }, { title: "Open" }] } },
    )).resolves.toEqual({ data: [{ id: "task:1" }], nextCursor: "after-page" });
  });

  it("follows the folded foreign key, never recreating a deleted holder", async () => {
    const storage = new MemoryStorageAdapter(["folders", "notes"]);
    await storage.setHydrationState("notes", "hydrating");
    await storage.setHydrationState("folders", "hydrating");
    const change = (mutationId: string, mutation: Record<string, unknown>) =>
      storage.changelogAppend({ clientId: "client:1", mutationId, timestampMs: 1, mutation });
    await change("m1", { resource: "notes", operation: "relate", id: "note:1", relations: { folder: "folder:2" } });
    await change("m2", { resource: "notes", operation: "delete", id: "note:2" });
    await change("m3", { resource: "notes", operation: "relate", id: "note:2", relations: { folder: "folder:1" } });
    await change("m4", { resource: "notes", operation: "unrelate", id: "note:3", relations: { folder: "folder:1" } });
    await change("m5", { resource: "notes", operation: "merge", id: "note:3", record: { folderId: "folder:1" } });
    const rows = [
      { id: "note:1", title: "A", folderId: "folder:1" },
      { id: "note:2", title: "B", folderId: "folder:1" },
      { id: "note:3", title: "C", folderId: "folder:1" },
    ];
    const page = (query: Record<string, unknown>) => executeQuery(
      remoteReturning({ data: rows, nextCursor: "after-note:3" }),
      { limit: 3, ...query },
      storage,
      [],
      relationSchema,
    );

    const expected = { data: [rows[2]], nextCursor: "after-note:3" };
    await expect(page({ resource: "notes", filters: { "folder.id": "folder:1" } }))
      .resolves.toEqual(expected);
    await expect(page({ resource: "folders", relation: "notes", id: "folder:1" }))
      .resolves.toEqual(expected);
  });

  it("drops a row whose pending write moves its local timestamp out of the filter", async () => {
    const storage = await hydratingStorage();
    await storage.changelogAppend({
      clientId: "client:1",
      mutationId: "mutation:title",
      timestampMs: 200,
      mutation: { resource: "tasks", operation: "merge", id: "task:1", record: { title: "New" } },
    });
    const stampedSchema: DatafnSchema = {
      ...effectsSchema,
      resources: [{ ...effectsSchema.resources[0], capabilities: ["timestamps"] }],
    };

    await expect(limitedPage(
      storage,
      [{ id: "task:1", title: "Old", updatedAt: 100 }, { id: "task:2", updatedAt: 100 }],
      { filters: { updatedAt: { $lt: 150 } } },
      stampedSchema,
    )).resolves.toEqual({ data: [{ id: "task:2", updatedAt: 100 }], nextCursor: "after-page" });
  });

  it("follows the effective projection for fields the server left unset", async () => {
    const storage = await hydratingStorage();
    await pendingChange(storage, "mutation:edit", {
      operation: "merge",
      id: "task:1",
      record: { note: "n", profile: { items: [{ label: "A", secret: "hidden" }] }, typoTitle: "x" },
    });
    const row = { id: "task:1", title: "Open" };

    await expect(limitedPage(storage, [row], { select: [] })).resolves.toEqual({
      data: [{ ...row, note: "n", profile: { items: [{ label: "A", secret: "hidden" }] } }],
      nextCursor: "after-page",
    });
    await expect(limitedPage(storage, [row], { omit: ["secret"] })).resolves.toEqual({
      data: [{ ...row, note: "n", profile: { items: [{ label: "A" }] } }],
      nextCursor: "after-page",
    });
  });

  it("shows foreign keys and relation-page fields only where the projection returns them", async () => {
    const storage = new MemoryStorageAdapter(["folders", "notes"]);
    await storage.setHydrationState("notes", "hydrating");
    await storage.setHydrationState("folders", "hydrating");
    const change = (mutationId: string, mutation: Record<string, unknown>) =>
      storage.changelogAppend({ clientId: "client:1", mutationId, timestampMs: 1, mutation });
    await change("m1", { resource: "notes", operation: "relate", id: "note:1", relations: { folder: "folder:1" } });
    await change("m2", { resource: "notes", operation: "merge", id: "note:1", record: { title: "Named" } });
    const row = { id: "note:1", folder: { id: "folder:1" } };
    const page = (query: Record<string, unknown>) => executeQuery(
      remoteReturning({ data: [row], nextCursor: "after-note:1" }),
      { limit: 1, ...query },
      storage,
      [],
      relationSchema,
    );

    await expect(page({ resource: "notes", select: ["*", "folder.*"] })).resolves.toEqual({
      data: [{ ...row, title: "Named" }],
      nextCursor: "after-note:1",
    });
    // A relation page materializes its targets with "*", like the server.
    await expect(page({ resource: "folders", relation: "notes", id: "folder:1" })).resolves.toEqual({
      data: [{ ...row, title: "Named" }],
      nextCursor: "after-note:1",
    });
    await expect(page({ resource: "folders", relation: "notes", id: "folder:1", select: ["title"] }))
      .resolves.toEqual({ data: [{ ...row, title: "Named" }], nextCursor: "after-note:1" });
  });
});

const folderSchema: DatafnSchema = {
  resources: [
    { name: "folders", version: 1, fields: [{ name: "name", type: "string", required: false }] },
    {
      name: "notes",
      version: 1,
      fields: [
        { name: "title", type: "string", required: false },
        { name: "folderId", type: "string", required: false },
        { name: "profile", type: "object", required: false },
      ],
    },
  ],
  relations: [
    { from: "notes", to: "folders", type: "many-one", relation: "folder", inverse: "notes", fkField: "folderId" },
  ],
};

async function hydrating(...resources: string[]): Promise<MemoryStorageAdapter> {
  const storage = new MemoryStorageAdapter(["folders", "notes"]);
  for (const resource of resources) await storage.setHydrationState(resource, "hydrating");
  return storage;
}

let seq = 0;
/** A pending change written by the real offline writer: changelog plus optimistic apply. */
async function offlineWrite(
  storage: MemoryStorageAdapter,
  schema: DatafnSchema,
  mutation: Record<string, unknown>,
): Promise<void> {
  seq += 1;
  await handleOfflineMutation(
    storage,
    schema,
    { clientId: "client:1", mutationId: `mutation:${seq}`, ...mutation },
    1000 + seq,
  );
}

async function page(
  storage: MemoryStorageAdapter,
  schema: DatafnSchema,
  query: Record<string, unknown>,
  rows: Record<string, unknown>[],
): Promise<Array<Record<string, unknown>>> {
  const result = (await executeQuery(
    remoteReturning({ data: rows, nextCursor: "next" }),
    { limit: rows.length, ...query },
    storage,
    [],
    schema,
  )) as { data: Array<Record<string, unknown>>; nextCursor: unknown };
  expect(result.nextCursor).toBe("next");
  return result.data;
}

describe("Limited first page: pending changes replayed by the offline writer", () => {
  it("hydration: drops the old parent from a single-target page after a pending reparent", async () => {
    const storage = await hydrating("notes", "folders");
    await storage.upsertRecord("notes", { id: "note:1", title: "A", folderId: "folder:1" });
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "relate", id: "note:1", relations: { folder: "folder:2" },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "notes", id: "note:1", relation: "folder" },
      [{ id: "folder:1", name: "Old" }],
    );
    expect(data).toEqual([]);
  });

  it("hydration: drops a child from the parent page after an empty forward unrelate", async () => {
    const storage = await hydrating("notes", "folders");
    await storage.upsertRecord("notes", { id: "note:1", title: "A", folderId: "folder:1" });
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "unrelate", id: "note:1", relations: { folder: [] },
    });
    expect((await storage.getRecord("notes", "note:1"))?.folderId ?? null).toBeNull();
    const data = await page(
      storage, folderSchema,
      { resource: "folders", id: "folder:1", relation: "notes" },
      [{ id: "note:1", title: "A", folderId: "folder:1" }, { id: "note:2", title: "B", folderId: "folder:1" }],
    );
    expect(data.map((row) => row.id)).toEqual(["note:2"]);
  });

  it("filter-dependencies: a sibling-only nested merge keeps a row the server matched", async () => {
    const storage = await hydrating("notes");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { profile: { note: "x" } },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "notes", filters: { "profile.status": "open" }, select: ["id", "title"] },
      [{ id: "note:1", title: "A" }],
    );
    expect(data.map((row) => row.id)).toEqual(["note:1"]);
  });

  it("filter-dependencies: a nested write that stops a match drops the row", async () => {
    const storage = await hydrating("notes");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { profile: { status: "closed" } },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "notes", filters: { "profile.status": "open" } },
      [{ id: "note:1", title: "A", profile: { status: "open" } }, { id: "note:2", title: "B", profile: { status: "open" } }],
    );
    expect(data.map((row) => row.id)).toEqual(["note:2"]);
  });

  it("filter-dependencies: a moved foreign key inside $or drops the row", async () => {
    const storage = await hydrating("notes");
    await storage.upsertRecord("notes", { id: "note:1", title: "Draft", folderId: "folder:1" });
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "relate", id: "note:1", relations: { folder: "folder:2" },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "notes", filters: { $or: [{ "folder.id": "folder:1" }, { title: "Pinned" }] } },
      [{ id: "note:1", title: "Draft", folderId: "folder:1" }, { id: "note:2", title: "Pinned", folderId: "folder:3" }],
    );
    expect(data.map((row) => row.id)).toEqual(["note:2"]);

    // Still matching through the other branch: the row stays.
    await storage.upsertRecord("notes", { id: "note:3", title: "Pinned", folderId: "folder:1" });
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "relate", id: "note:3", relations: { folder: "folder:2" },
    });
    const pinned = await page(
      storage, folderSchema,
      { resource: "notes", filters: { $or: [{ "folder.id": "folder:1" }, { title: "Pinned" }] } },
      [{ id: "note:3", title: "Pinned", folderId: "folder:1" }],
    );
    expect(pinned.map((row) => row.id)).toEqual(["note:3"]);
  });

  it("projection-shape: never overwrites an expansion whose key is the written foreign key", async () => {
    const ownerSchema: DatafnSchema = {
      resources: [
        { name: "users", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        { name: "notes", version: 1, fields: [{ name: "title", type: "string", required: false }] },
      ],
      relations: [
        { from: "notes", to: "users", type: "many-one", relation: "owner", fkField: "owner" },
      ],
    };
    const storage = new MemoryStorageAdapter(["users", "notes"]);
    await storage.setHydrationState("notes", "hydrating");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:owner", timestampMs: 1,
      mutation: { resource: "notes", operation: "relate", id: "note:1", relations: { owner: "user:2" } },
    });
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:title", timestampMs: 2,
      mutation: { resource: "notes", operation: "merge", id: "note:1", record: { title: "Edited" } },
    });
    const row = { id: "note:1", title: "A", owner: { id: "user:1", name: "Ada" } };
    const data = await page(storage, ownerSchema, { resource: "notes", select: ["*", "owner.*"] }, [row]);
    expect(data).toEqual([{ ...row, title: "Edited" }]);
  });

  it("projection-shape: a nested select through a plain field returns it as the server does", async () => {
    const storage = await hydrating("notes");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1",
      record: { profile: { address: { city: "Pune", zip: "411001" } } },
    });
    // The server's materializeSelect skips a nested token whose head is not a relation.
    const data = await page(
      storage, folderSchema,
      { resource: "notes", select: ["id", "profile.address.city"] },
      [{ id: "note:1" }],
    );
    expect(data).toEqual([{ id: "note:1" }]);
  });

  it("projection-shape: omit id keeps nested ids, as the server's applyOmit does", async () => {
    const storage = await hydrating("notes");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1",
      record: { profile: { id: "profile:1", owner: { id: "user:1", name: "A" } } },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "notes", omit: ["id", "name"] },
      [{ id: "note:1", title: "A" }],
    );
    expect(data).toEqual([
      { id: "note:1", title: "A", profile: { id: "profile:1", owner: { id: "user:1" } } },
    ]);
  });

  it("replace-discards-preserved-effects: a replace clears a declared foreign key, as the server's buildReplaceRecord does", async () => {
    const storage = await hydrating("notes");
    await storage.upsertRecord("notes", { id: "note:1", title: "A", folderId: "folder:1" });
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "relate", id: "note:1", relations: { folder: "folder:2" },
    });
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "replace", id: "note:1", record: { title: "B" },
    });
    // buildReplaceRecord resets every declared, writable field the payload leaves out.
    const data = await page(
      storage, folderSchema,
      { resource: "notes" },
      [{ id: "note:1", title: "A", folderId: "folder:1" }],
    );
    expect(data).toEqual([{ id: "note:1", title: "B" }]);
  });

  it("replace-discards-preserved-effects: a replace after a pending trash keeps the row trashed", async () => {
    const trashSchema: DatafnSchema = {
      ...folderSchema,
      resources: folderSchema.resources.map((resource) =>
        resource.name === "notes" ? { ...resource, capabilities: ["trash"] } : resource),
    };
    const storage = await hydrating("notes");
    await storage.upsertRecord("notes", { id: "note:1", title: "A" });
    await offlineWrite(storage, trashSchema, { resource: "notes", operation: "trash", id: "note:1" });
    await offlineWrite(storage, trashSchema, {
      resource: "notes", operation: "replace", id: "note:1", record: { title: "B" },
    });
    const data = await page(storage, trashSchema, { resource: "notes" }, [{ id: "note:1", title: "A" }, { id: "note:2", title: "C" }]);
    expect(data.map((row) => row.id)).toEqual(["note:2"]);
  });

  it("malformed-entry-disables-page: an unreadable entry for another id leaves valid effects in place", async () => {
    const storage = await hydrating("notes");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:bad", timestampMs: 1,
      mutation: { resource: "notes", operation: "relate", id: "note:9", relations: { folder: 42 } },
    });
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { title: "Edited" },
    });
    await offlineWrite(storage, folderSchema, { resource: "notes", operation: "delete", id: "note:2" });
    const data = await page(
      storage, folderSchema, { resource: "notes" },
      [{ id: "note:1", title: "A" }, { id: "note:2", title: "B" }, { id: "note:3", title: "C" }],
    );
    expect(data).toEqual([{ id: "note:1", title: "Edited" }, { id: "note:3", title: "C" }]);
  });

  it("audit-attribution: shows the actor the real offline writer stamps", async () => {
    const auditSchema: DatafnSchema = {
      ...folderSchema,
      resources: folderSchema.resources.map((resource) =>
        resource.name === "notes" ? { ...resource, capabilities: ["audit"] } : resource),
    };
    const storage = await hydrating("notes");
    await storage.upsertRecord("notes", { id: "note:1", title: "A" });
    await offlineWrite(storage, auditSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { title: "Edited" },
    });
    const local = await storage.getRecord("notes", "note:1");
    const data = await page(
      storage, auditSchema, { resource: "notes" },
      [{ id: "note:1", title: "A", updatedBy: "user:server" }],
    );
    expect(data[0].updatedBy).toBe(local?.updatedBy);
    expect(data[0].title).toBe("Edited");
  });

  it("replace-discards-preserved-effects: a replace keeps an undeclared foreign key and the note on its folder's page", async () => {
    const generatedFkSchema: DatafnSchema = {
      ...folderSchema,
      resources: folderSchema.resources.map((resource) =>
        resource.name === "notes"
          ? { ...resource, fields: resource.fields.filter((field) => field.name !== "folderId") }
          : resource),
    };
    const storage = await hydrating("notes", "folders");
    await offlineWrite(storage, generatedFkSchema, {
      resource: "notes", operation: "replace", id: "note:1", record: { title: "Renamed" },
    });
    const data = await page(
      storage, generatedFkSchema,
      { resource: "folders", id: "folder:1", relation: "notes" },
      [{ id: "note:1", title: "A" }],
    );
    expect(data).toEqual([{ id: "note:1", title: "Renamed" }]);
  });

  it("hydration: a state change queued after a delete does not bring the row back", async () => {
    const trashSchema: DatafnSchema = {
      ...folderSchema,
      resources: folderSchema.resources.map((resource) =>
        resource.name === "notes" ? { ...resource, capabilities: ["trash", "archivable"] } : resource),
    };
    const storage = await hydrating("notes");
    for (const [mutationId, operation] of [["m:delete", "delete"], ["m:restore", "restore"], ["m:archive", "archive"]]) {
      await storage.changelogAppend({
        clientId: "client:1", mutationId, timestampMs: 1,
        mutation: { resource: "notes", operation, id: "note:1" },
      });
    }
    const data = await page(
      storage, trashSchema, { resource: "notes", metadata: { includeTrashed: true, includeArchived: true } },
      [{ id: "note:1", title: "A" }, { id: "note:2", title: "B" }],
    );
    expect(data.map((row) => row.id)).toEqual(["note:2"]);
  });

  it("filter-dependencies: relation-page filters belong to the anchor, not the targets", async () => {
    const storage = await hydrating("notes", "folders");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { title: "Draft" },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "folders", id: "folder:1", relation: "notes", filters: { title: "Open" } },
      [{ id: "note:1", title: "Open" }],
    );
    expect(data).toEqual([{ id: "note:1", title: "Draft" }]);
  });

  it("filter-dependencies: a written null settles a nested condition the server did not return", async () => {
    const storage = await hydrating("notes");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { profile: null },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "notes", filters: { "profile.status": "open" }, select: ["id", "title"] },
      [{ id: "note:1", title: "A" }, { id: "note:2", title: "B" }],
    );
    expect(data.map((row) => row.id)).toEqual(["note:2"]);
  });

  it("projection-shape: a relate moves a readonly foreign key and a bare scalar relation id", async () => {
    const readonlySchema: DatafnSchema = {
      resources: [
        { name: "users", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        {
          name: "notes",
          version: 1,
          fields: [
            { name: "title", type: "string", required: false },
            { name: "owner", type: "string", required: false, readonly: true },
          ],
        },
      ],
      relations: [{ from: "notes", to: "users", type: "many-one", relation: "owner", fkField: "owner" }],
    };
    const storage = new MemoryStorageAdapter(["users", "notes"]);
    await storage.setHydrationState("notes", "hydrating");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:owner", timestampMs: 1,
      mutation: { resource: "notes", operation: "relate", id: "note:1", relations: { owner: "user:2" } },
    });
    const data = await page(
      storage, readonlySchema,
      { resource: "notes", select: ["id", "owner"], filters: { owner: "user:1" } },
      [{ id: "note:1", owner: "user:1" }, { id: "note:2", owner: "user:1" }],
    );
    expect(data).toEqual([{ id: "note:2", owner: "user:1" }]);
    const unfiltered = await page(
      storage, readonlySchema, { resource: "notes", select: ["id", "owner"] }, [{ id: "note:1", owner: "user:1" }],
    );
    expect(unfiltered).toEqual([{ id: "note:1", owner: "user:2" }]);
  });

  it("malformed-entry-disables-page: an entry the page cannot decode leaves that row as returned", async () => {
    const storage = new MemoryStorageAdapter(["tasks"]);
    await storage.setHydrationState("tasks", "hydrating");
    await pendingChange(storage, "mutation:bad-date", {
      operation: "merge", id: "task:1", record: { dueAt: "not-a-date" },
    });
    await pendingChange(storage, "mutation:edit", {
      operation: "merge", id: "task:2", record: { title: "Edited" },
    });
    await pendingChange(storage, "mutation:partial", {
      operation: "unrelate", id: "task:3", relations: { first: "task:1", second: 42 },
    });
    const result = await executeQuery(
      remoteReturning({ data: [{ id: "task:1", title: "A" }, { id: "task:2", title: "B" }], nextCursor: "next" }),
      { resource: "tasks", limit: 2 },
      storage,
      [],
      schema,
    );
    expect(result).toEqual({
      data: [{ id: "task:1", title: "A" }, { id: "task:2", title: "Edited" }],
      nextCursor: "next",
    });
  });

  it("hydration: ancestor inactivity stays as the server computed it", async () => {
    const inheritSchema: DatafnSchema = {
      ...folderSchema,
      resources: folderSchema.resources.map((resource) =>
        resource.name === "folders" ? { ...resource, capabilities: ["trash"] } : resource),
      relations: [{ ...folderSchema.relations![0], inheritsInactive: true }],
    };
    const storage = await hydrating("notes");
    await offlineWrite(storage, inheritSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { title: "B" },
    });
    const data = await page(
      storage, inheritSchema, { resource: "notes", metadata: { includeAncestorInactive: true } },
      [{ id: "note:1", title: "A", folderId: "folder:1", isAncestorInactive: true }],
    );
    expect(data).toEqual([{ id: "note:1", title: "B", folderId: "folder:1", isAncestorInactive: true }]);
  });

  it("replace-discards-preserved-effects: a replace resets writable archive state and clears unselected filtered fields", async () => {
    const archiveSchema: DatafnSchema = {
      ...folderSchema,
      resources: folderSchema.resources.map((resource) =>
        resource.name === "notes"
          ? {
            ...resource,
            capabilities: ["archivable"],
            fields: [...resource.fields, { name: "note", type: "string", required: false }],
          }
          : resource),
    };
    const storage = await hydrating("notes");
    await storage.upsertRecord("notes", { id: "note:1", title: "A" });
    await offlineWrite(storage, archiveSchema, { resource: "notes", operation: "archive", id: "note:1" });
    await offlineWrite(storage, archiveSchema, {
      resource: "notes", operation: "replace", id: "note:1", record: { title: "B" },
    });
    const rows = [{ id: "note:1", title: "A" }, { id: "note:2", title: "C" }];
    expect(await page(storage, archiveSchema, { resource: "notes" }, rows))
      .toEqual([{ id: "note:1", title: "B", isArchived: false }, { id: "note:2", title: "C" }]);
    // The server matched note:1 on its unselected note; the replace cleared it.
    expect((await page(
      storage, archiveSchema,
      { resource: "notes", select: ["id", "title"], filters: { note: "open" } },
      rows,
    )).map((row) => row.id)).toEqual(["note:2"]);
  });

  it("filter-dependencies: an explicit nested $eq keeps a row a sibling merge leaves matching", async () => {
    const storage = await hydrating("notes");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { profile: { note: "x" } },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "notes", filters: { "profile.status": { $eq: "open" } } },
      [{ id: "note:1", title: "A", profile: { status: "open" } }],
    );
    expect(data).toEqual([{ id: "note:1", title: "A", profile: { status: "open", note: "x" } }]);
  });

  it("projection-shape: the last token decides between a scalar relation id and its expansion", async () => {
    const ownerSchema: DatafnSchema = {
      resources: [
        { name: "users", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        { name: "notes", version: 1, fields: [{ name: "title", type: "string", required: false }] },
      ],
      relations: [{ from: "notes", to: "users", type: "many-one", relation: "owner", fkField: "owner" }],
    };
    const storage = new MemoryStorageAdapter(["users", "notes"]);
    await storage.setHydrationState("notes", "hydrating");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:owner", timestampMs: 1,
      mutation: { resource: "notes", operation: "relate", id: "note:1", relations: { owner: "user:2" } },
    });
    expect(await page(storage, ownerSchema, { resource: "notes", select: ["owner.*", "owner"] }, [{ id: "note:1", owner: "user:1" }]))
      .toEqual([{ id: "note:1", owner: "user:2" }]);
  });

  it("malformed-entry-disables-page: an undecodable value leaves other edits to the same row", async () => {
    const storage = new MemoryStorageAdapter(["tasks"]);
    await storage.setHydrationState("tasks", "hydrating");
    await pendingChange(storage, "mutation:bad-date", {
      operation: "merge", id: "task:1", record: { dueAt: "not-a-date" },
    });
    await pendingChange(storage, "mutation:edit", {
      operation: "merge", id: "task:1", record: { title: "Edited" },
    });
    const result = await executeQuery(
      remoteReturning({ data: [{ id: "task:1", title: "A" }], nextCursor: "next" }),
      { resource: "tasks", limit: 1 },
      storage,
      [],
      schema,
    );
    expect(result).toEqual({ data: [{ id: "task:1", title: "Edited" }], nextCursor: "next" });
  });
});

const treeSchema: DatafnSchema = {
  resources: [
    {
      name: "goals",
      version: 1,
      fields: [
        { name: "title", type: "string", required: false },
        { name: "parentId", type: "string", required: false },
        { name: "parentPath", type: "string", required: false },
      ],
    },
  ],
  relations: [
    { from: "goals", to: "goals", type: "htree", relation: "children", inverse: "parent", foreignKey: "parentId", pathField: "parentPath" },
  ],
};

const tagSchema: DatafnSchema = {
  resources: [
    { name: "tags", version: 1, fields: [{ name: "label", type: "string", required: false }] },
    { name: "notes", version: 1, fields: [{ name: "title", type: "string", required: false }] },
  ],
  relations: [{ from: "notes", to: "tags", type: "many-many", relation: "tags", inverse: "notes" }],
};

describe("Limited first page: server membership, three-valued filters and isolated entries", () => {
  it("hydration: a pending reparent under a known root removes the ancestors the anchor leaves", async () => {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "relate", id: "goal:c", relations: { parent: "goal:z" },
    });
    // Sorted by id, the old parent goal:a comes before the root goal:z.
    const rows = [
      { id: "goal:a", title: "Parent", parentId: "goal:z", parentPath: "goal:z" },
      { id: "goal:z", title: "Root", parentId: null, parentPath: "" },
    ];
    const data = await page(storage, treeSchema, { resource: "goals", id: "goal:c", relation: "parent", sort: ["id:asc"] }, rows);
    expect(data).toEqual([rows[1]]);
  });

  it("hydration: a pending detach of a returned ancestor removes the ancestors above it", async () => {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "unrelate", id: "goal:b", relations: { parent: "goal:a" },
    });
    const rows = [
      { id: "goal:a", title: "Root", parentPath: "" },
      { id: "goal:b", title: "Parent", parentPath: "goal:a" },
    ];
    const data = await page(storage, treeSchema, { resource: "goals", id: "goal:c", relation: "parent", select: ["id", "title", "parentPath"] }, rows);
    expect(data).toEqual([{ id: "goal:b", title: "Parent", parentPath: "" }]);
  });

  it("hydration: a parent that only a pending merge created is not a known root", async () => {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "merge", id: "goal:s", record: { title: "Sibling" },
    });
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "relate", id: "goal:c", relations: { parent: "goal:s" },
    });
    const rows = [{ id: "goal:a", title: "Root" }, { id: "goal:b", title: "Parent" }];
    expect(await page(
      storage, treeSchema, { resource: "goals", id: "goal:c", relation: "parent", select: ["id", "title"] }, rows,
    )).toEqual(rows);
  });

  it("hydration: a move inside the subtree keeps a row on a ** descendant page; a detach removes it", async () => {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "relate", id: "goal:x", relations: { children: ["goal:d"] },
    });
    const query = { resource: "goals", id: "goal:r", relation: "children", select: ["**"] };
    const rows = [
      { id: "goal:x", title: "X", parentId: "goal:r", parentPath: "goal:r" },
      { id: "goal:d", title: "D", parentId: "goal:y", parentPath: "goal:r-goal:y" },
    ];
    expect(await page(storage, treeSchema, query, rows)).toEqual([
      rows[0],
      { id: "goal:d", title: "D", parentId: "goal:x", parentPath: "goal:r-goal:x" },
    ]);
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "unrelate", id: "goal:d", relations: { parent: "goal:x" },
    });
    expect(await page(storage, treeSchema, query, rows)).toEqual([rows[0]]);
  });

  it("filter-dependencies: a path built on a parent the page does not hold never decides the anchor", async () => {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "relate", id: "goal:c", relations: { parent: "goal:n" },
    });
    const rows = [{ id: "goal:k", title: "K", parentId: "goal:c", parentPath: "goal:root-goal:c" }];
    expect(await page(
      storage, treeSchema,
      { resource: "goals", id: "goal:c", relation: "children", filters: { parentPath: { $startsWith: "goal:root" } } },
      rows,
    )).toEqual(rows);
  });

  it("hydration: an inverse htree page keeps ancestors the replay does not prove gone", async () => {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    const query = { resource: "goals", id: "goal:c", relation: "parent", sort: ["id:asc"], select: ["id", "title"] };
    const rows = [{ id: "goal:a", title: "Parent" }, { id: "goal:z", title: "Root" }];
    // The real root moves under goal:q; goal:a stays goal:c's parent.
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "relate", id: "goal:z", relations: { parent: "goal:q" },
    });
    expect(await page(storage, treeSchema, query, rows)).toEqual(rows);
    // goal:a moves under goal:s, an off-page child of goal:z; both stay ancestors.
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "relate", id: "goal:a", relations: { parent: "goal:s" },
    });
    expect(await page(storage, treeSchema, query, rows)).toEqual(rows);
    // A reparent of goal:c itself under a parent the page does not hold proves nothing either.
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "relate", id: "goal:c", relations: { parent: "goal:s" },
    });
    expect(await page(storage, treeSchema, query, rows)).toEqual(rows);
  });

  it("hydration: a pending detach removes every ancestor, and an untouched page keeps its order", async () => {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    const rows = [{ id: "goal:a", title: "Parent" }, { id: "goal:z", title: "Root" }];
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "merge", id: "goal:other", record: { title: "Elsewhere" },
    });
    const query = { resource: "goals", id: "goal:c", relation: "parent", sort: ["id:asc"] };
    expect(await page(storage, treeSchema, query, rows)).toEqual(rows);
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "unrelate", id: "goal:c", relations: { parent: "goal:a" },
    });
    expect(await page(storage, treeSchema, query, rows)).toEqual([]);
  });

  it("filter-dependencies: a relation id and its foreign key in one branch are both judged", async () => {
    const storage = await hydrating("notes");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { title: "Draft" },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "notes", filters: { $or: [{ "folder.id": "folder:2", folderId: "folder:1" }, { title: "Pinned" }] } },
      [{ id: "note:1", title: "Pinned", folderId: "folder:1" }, { id: "note:2", title: "Pinned", folderId: "folder:1" }],
    );
    expect(data.map((row) => row.id)).toEqual(["note:2"]);
  });

  it("filter-dependencies: an $or whose branches are all false drops the row, even with a hidden path", async () => {
    const storage = await hydrating("notes");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { title: "Done", profile: { status: "closed" } },
    });
    const filters = { $or: [{ title: "Open" }, { "profile.status": "open", "folder.name": "Inbox" }] };
    const data = await page(
      storage, folderSchema,
      { resource: "notes", filters, select: ["id", "title"] },
      [{ id: "note:1", title: "Open" }, { id: "note:2", title: "Open" }],
    );
    expect(data.map((row) => row.id)).toEqual(["note:2"]);
  });

  it("filter-dependencies: a replaced nested object settles its members, a merged one does not", async () => {
    const storage = await hydrating("notes");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "replace", id: "note:1", record: { title: "A", profile: { note: "x" } },
    });
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:2", record: { profile: { note: "x" } },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "notes", filters: { "profile.status": "open" }, select: ["id", "title"] },
      [{ id: "note:1", title: "A" }, { id: "note:2", title: "B" }],
    );
    expect(data.map((row) => row.id)).toEqual(["note:2"]);
  });

  it("filter-dependencies: a pending anchor write that fails the filter empties a relation page", async () => {
    const storage = await hydrating("notes", "folders");
    await offlineWrite(storage, folderSchema, {
      resource: "folders", operation: "merge", id: "folder:1", record: { name: "Archive" },
    });
    const rows = [{ id: "note:1", title: "A" }];
    expect(await page(
      storage, folderSchema, { resource: "folders", id: "folder:1", relation: "notes", filters: { name: "Inbox" } }, rows,
    )).toEqual([]);
    expect(await page(
      storage, folderSchema, { resource: "folders", id: "folder:1", relation: "notes", filters: { name: "Archive" } }, rows,
    )).toEqual(rows);
    await offlineWrite(storage, folderSchema, { resource: "folders", operation: "delete", id: "folder:1" });
    expect(await page(storage, folderSchema, { resource: "folders", id: "folder:1", relation: "notes" }, rows)).toEqual([]);
  });

  it("projection-shape: a many-many page selected with *# shows target edits and keeps the metadata", async () => {
    const storage = new MemoryStorageAdapter(["tags", "notes"]);
    await storage.setHydrationState("notes", "hydrating");
    await offlineWrite(storage, tagSchema, {
      resource: "tags", operation: "merge", id: "tag:1", record: { label: "New" },
    });
    const rows = [{ id: "tag:1", label: "Old", $relation_metadata: { from: "note:1", to: "tag:1" } }];
    expect(await page(storage, tagSchema, { resource: "notes", id: "note:1", relation: "tags", select: ["*#"] }, rows))
      .toEqual([{ ...rows[0], label: "New" }]);
  });

  it("projection-shape: a declared foreign key follows the token that wrote it last", async () => {
    const ownerSchema: DatafnSchema = {
      resources: [
        { name: "users", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        {
          name: "notes",
          version: 1,
          fields: [{ name: "title", type: "string", required: false }, { name: "owner", type: "string", required: false }],
        },
      ],
      relations: [{ from: "notes", to: "users", type: "many-one", relation: "owner", fkField: "owner" }],
    };
    const storage = new MemoryStorageAdapter(["users", "notes"]);
    await storage.setHydrationState("notes", "hydrating");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:owner", timestampMs: 1,
      mutation: { resource: "notes", operation: "relate", id: "note:1", relations: { owner: "user:2" } },
    });
    // The server's later "*" writes the scalar over the expansion.
    expect(await page(storage, ownerSchema, { resource: "notes", select: ["owner.*", "*"] }, [{ id: "note:1", title: "A", owner: "user:1" }]))
      .toEqual([{ id: "note:1", title: "A", owner: "user:2" }]);
    const expanded = { id: "note:1", title: "A", owner: { id: "user:1", name: "Ada" } };
    expect(await page(storage, ownerSchema, { resource: "notes", select: ["*", "owner.*"] }, [expanded]))
      .toEqual([expanded]);
  });

  it("replace-discards-preserved-effects: plain createdBy and updatedAt fields follow the ordinary replace rules", async () => {
    const plainSchema: DatafnSchema = {
      resources: [
        {
          name: "notes",
          version: 1,
          fields: [
            { name: "title", type: "string", required: false },
            { name: "createdBy", type: "string", required: false },
            { name: "updatedAt", type: "string", required: false },
          ],
        },
      ],
      relations: [],
    };
    const storage = new MemoryStorageAdapter(["notes"]);
    await storage.setHydrationState("notes", "hydrating");
    await offlineWrite(storage, plainSchema, {
      resource: "notes", operation: "replace", id: "note:1", record: { title: "B", createdBy: "user:2" },
    });
    expect(await page(
      storage, plainSchema, { resource: "notes" },
      [{ id: "note:1", title: "A", createdBy: "user:1", updatedAt: "2026-01-01" }],
    )).toEqual([{ id: "note:1", title: "B", createdBy: "user:2" }]);
  });

  it("malformed-entry-disables-page: an entry the writer rejects partway leaves no edge or field behind", async () => {
    const restrictSchema: DatafnSchema = {
      resources: [
        ...folderSchema.resources,
        { name: "pins", version: 1, fields: [{ name: "folderId", type: "string", required: false }] },
      ],
      relations: [
        { ...folderSchema.relations![0], onDelete: "setNull" },
        { from: "pins", to: "folders", type: "many-one", relation: "folder", inverse: "pins", fkField: "folderId", onDelete: "restrict" },
      ],
    };
    const storage = new MemoryStorageAdapter(["folders", "notes", "pins"]);
    await storage.setHydrationState("notes", "hydrating");
    await offlineWrite(storage, restrictSchema, {
      resource: "pins", operation: "insert", id: "pin:1", record: { folderId: "folder:1" },
    });
    // The server rejects the whole delete: a pin still references the folder.
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:delete-folder", timestampMs: 1,
      mutation: { resource: "folders", operation: "delete", id: "folder:1" },
    });
    await offlineWrite(storage, restrictSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { title: "Edited" },
    });
    const data = await page(
      storage, restrictSchema,
      { resource: "notes", filters: { folderId: "folder:1" } },
      [{ id: "note:1", title: "A", folderId: "folder:1" }, { id: "note:2", title: "B", folderId: "folder:1" }],
    );
    expect(data).toEqual([
      { id: "note:1", title: "Edited", folderId: "folder:1" },
      { id: "note:2", title: "B", folderId: "folder:1" },
    ]);
  });
  it("filter-dependencies: a nested member the query omits stays unknown after a sibling merge", async () => {
    const storage = await hydrating("notes");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { profile: { note: "x" } },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "notes", filters: { "profile.address.status": "open" }, omit: ["status"] },
      [{ id: "note:1", title: "A", profile: { address: { city: "Pune" } } }],
    );
    expect(data).toEqual([{ id: "note:1", title: "A", profile: { address: { city: "Pune" }, note: "x" } }]);
  });

  it("filter-dependencies: an array value is $in, as on the server, for rows and relation anchors", async () => {
    const storage = await hydrating("notes", "folders");
    await offlineWrite(storage, folderSchema, {
      resource: "folders", operation: "merge", id: "folder:1", record: { name: "Archive" },
    });
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { title: "Draft" },
    });
    const rows = [{ id: "note:1", title: "Open" }];
    expect(await page(
      storage, folderSchema,
      { resource: "folders", id: "folder:1", relation: "notes", filters: { name: ["Inbox", "Archive"] } }, rows,
    )).toEqual([{ id: "note:1", title: "Draft" }]);
    expect(await page(storage, folderSchema, { resource: "notes", filters: { title: ["Open", "Draft"] } }, rows))
      .toEqual([{ id: "note:1", title: "Draft" }]);
  });

  it("projection-shape: *# adds nothing on a relation page that is not many-many", async () => {
    const storage = await hydrating("notes", "folders");
    await offlineWrite(storage, folderSchema, {
      resource: "folders", operation: "merge", id: "folder:1", record: { name: "Renamed" },
    });
    const rows = [{ id: "folder:1" }];
    expect(await page(storage, folderSchema, { resource: "notes", id: "note:1", relation: "folder", select: ["id", "*#"] }, rows))
      .toEqual(rows);
  });

  it("malformed-entry-disables-page: a skipped replace does not settle fields for a later merge", async () => {
    const storage = await hydrating("notes");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:bad-replace", timestampMs: 1,
      mutation: { resource: "notes", operation: "replace", id: "note:1", record: { title: "A" }, relations: [] },
    });
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { profile: { note: "x" } },
    });
    const data = await page(
      storage, folderSchema,
      { resource: "notes", filters: { "profile.status": "open" }, select: ["id", "title"] },
      [{ id: "note:1", title: "A" }],
    );
    expect(data).toEqual([{ id: "note:1", title: "A" }]);
  });
  it("projection-shape: a polymorphic discriminator the server omits stays off the row", async () => {
    const polySchema: DatafnSchema = {
      resources: [
        { name: "users", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        { name: "teams", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        {
          name: "notes",
          version: 1,
          fields: [
            { name: "title", type: "string", required: false },
            { name: "ownerId", type: "string", required: false },
            { name: "ownerResource", type: "string", required: false },
          ],
        },
      ],
      relations: [{ from: "notes", to: ["users", "teams"], type: "many-one", relation: "owner", fkField: "ownerId", fkResourceField: "ownerResource" }],
    };
    const storage = new MemoryStorageAdapter(["users", "teams", "notes"]);
    await storage.setHydrationState("notes", "hydrating");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:owner", timestampMs: 1,
      mutation: { resource: "notes", operation: "relate", id: "note:1", relations: { owner: "users:2" } },
    });
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:title", timestampMs: 2,
      mutation: { resource: "notes", operation: "merge", id: "note:1", record: { title: "Edited" } },
    });
    expect(await page(storage, polySchema, { resource: "notes" }, [{ id: "note:1", title: "A" }]))
      .toEqual([{ id: "note:1", title: "Edited" }]);
  });

  it("malformed-entry-disables-page: a replace the server rejects for a missing required field is rolled back", async () => {
    const requiredSchema: DatafnSchema = {
      resources: [
        {
          name: "notes",
          version: 1,
          fields: [
            { name: "title", type: "string", required: true },
            { name: "profile", type: "object", required: false },
          ],
        },
      ],
      relations: [],
    };
    const storage = new MemoryStorageAdapter(["notes"]);
    await storage.setHydrationState("notes", "hydrating");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:replace", timestampMs: 1,
      mutation: { resource: "notes", operation: "replace", id: "note:1", record: { profile: { note: "x" } } },
    });
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:merge", timestampMs: 2,
      mutation: { resource: "notes", operation: "merge", id: "note:1", record: { title: "Edited" } },
    });
    expect(await page(
      storage, requiredSchema,
      { resource: "notes", filters: { "profile.status": "open" }, select: ["id", "title"] },
      [{ id: "note:1", title: "A" }],
    )).toEqual([{ id: "note:1", title: "Edited" }]);
  });
  it("hydration: htree pages read paths of ids that contain the separator", async () => {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    const root = "goals:0000-root";
    const parent = "goals:0000-parent";
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "unrelate", id: parent, relations: { parent: root },
    });
    const ancestors = [
      { id: root, title: "Root", parentPath: "" },
      { id: parent, title: "Parent", parentPath: root },
    ];
    expect(await page(
      storage, treeSchema, { resource: "goals", id: "goals:0000-leaf", relation: "parent", select: ["id", "title", "parentPath"] }, ancestors,
    )).toEqual([{ id: parent, title: "Parent", parentPath: "" }]);
    const children = [
      { id: parent, title: "Parent", parentPath: root },
      { id: "goals:0000-other", title: "Other", parentPath: root },
    ];
    expect(await page(
      storage, treeSchema, { resource: "goals", id: root, relation: "children", select: ["**"] }, children,
    )).toEqual([children[1]]);
  });

  it("hydration: a direct-children page drops a row moved under a parent it does not hold, or detached with its path omitted", async () => {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "relate", id: "goal:x", relations: { parent: "goal:n" },
    });
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "unrelate", id: "goal:y", relations: { parent: "goal:c" },
    });
    const rows = [
      { id: "goal:x", title: "X", parentId: "goal:c" },
      { id: "goal:y", title: "Y", parentId: "goal:c" },
      { id: "goal:z", title: "Z", parentId: "goal:c" },
    ];
    expect(await page(storage, treeSchema, { resource: "goals", id: "goal:c", relation: "children", omit: ["parentPath"] }, rows))
      .toEqual([rows[2]]);
  });

  it("hydration: the last of * and ** decides between direct children and descendants", async () => {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "relate", id: "goal:b", relations: { parent: "goal:a" },
    });
    const rows = [
      { id: "goal:a", title: "A", parentId: "goal:r", parentPath: "goal:r" },
      { id: "goal:b", title: "B", parentId: "goal:r", parentPath: "goal:r" },
    ];
    const ids = async (select: string[]) =>
      (await page(storage, treeSchema, { resource: "goals", id: "goal:r", relation: "children", select }, rows)).map((row) => row.id);
    expect(await ids(["**", "*"])).toEqual(["goal:a"]);
    expect(await ids(["*", "**"])).toEqual(["goal:a", "goal:b"]);
  });

  it("filter-dependencies: an htree path a pending merge or replace writes as given decides the filter", async () => {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "merge", id: "goal:1", record: { parentId: "goal:new", parentPath: "goal:new" },
    });
    await offlineWrite(storage, treeSchema, {
      resource: "goals", operation: "replace", id: "goal:2", record: { title: "Two" },
    });
    const rows = [
      { id: "goal:1", title: "One", parentId: "goal:old", parentPath: "goal:old" },
      { id: "goal:2", title: "Two", parentId: "goal:old", parentPath: "goal:old" },
      { id: "goal:3", title: "Three", parentId: "goal:old", parentPath: "goal:old" },
    ];
    expect((await page(storage, treeSchema, { resource: "goals", filters: { parentPath: "goal:old" } }, rows)).map((row) => row.id))
      .toEqual(["goal:3"]);
  });

  it("malformed-entry-disables-page: a declared required id never rejects a replace", async () => {
    const idSchema: DatafnSchema = {
      resources: [{
        name: "notes",
        version: 1,
        fields: [{ name: "id", type: "string", required: true }, { name: "title", type: "string", required: false }],
      }],
      relations: [],
    };
    const storage = new MemoryStorageAdapter(["notes"]);
    await storage.setHydrationState("notes", "hydrating");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:replace", timestampMs: 1,
      mutation: { resource: "notes", operation: "replace", id: "note:1", record: { title: "B" } },
    });
    expect(await page(storage, idSchema, { resource: "notes" }, [{ id: "note:1", title: "A" }]))
      .toEqual([{ id: "note:1", title: "B" }]);
  });

  it("projection-shape: an htree page hides a pending polymorphic owner, which the server omits from tree rows", async () => {
    const ownedTree: DatafnSchema = {
      resources: [
        { name: "users", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        { name: "teams", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        {
          name: "goals",
          version: 1,
          fields: [
            ...treeSchema.resources[0].fields,
            { name: "ownerId", type: "string", required: false },
            { name: "ownerResource", type: "string", required: false },
          ],
        },
      ],
      relations: [
        ...treeSchema.relations!,
        { from: "goals", to: ["users", "teams"], type: "many-one", relation: "owner", fkField: "ownerId", fkResourceField: "ownerResource" },
      ],
    };
    const storage = new MemoryStorageAdapter(["users", "teams", "goals"]);
    await storage.setHydrationState("goals", "hydrating");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:owner", timestampMs: 1,
      mutation: { resource: "goals", operation: "relate", id: "goal:x", relations: { owner: "users:2" } },
    });
    const rows = [{ id: "goal:x", title: "X", parentId: "goal:c", parentPath: "goal:c" }];
    // materializeSelect's final omit pass strips the anchor resource's many-one keys from relation rows.
    expect(await page(storage, ownedTree, { resource: "goals", id: "goal:c", relation: "children" }, rows))
      .toEqual(rows);
  });
});

describe("Limited first page: htree paths, hidden filter fields and undecodable values", () => {
  const nullableTree: DatafnSchema = {
    resources: [{
      name: "goals",
      version: 1,
      fields: [
        { name: "title", type: "string", required: false },
        { name: "parentId", type: "string", required: false, nullable: true },
        { name: "parentPath", type: "string", required: false, nullable: true },
      ],
    }],
    relations: treeSchema.relations,
  };
  const child = { id: "goal:x", title: "X", parentId: "goal:c", parentPath: "goal:c" };
  const childrenOf = { resource: "goals", id: "goal:c", relation: "children" };
  async function hydratingGoals(): Promise<MemoryStorageAdapter> {
    const storage = new MemoryStorageAdapter(["goals"]);
    await storage.setHydrationState("goals", "hydrating");
    return storage;
  }

  it("hydration: a direct-children page judges a pending merge by the path, not the parent key", async () => {
    const pathOnly = await hydratingGoals();
    await offlineWrite(pathOnly, nullableTree, {
      resource: "goals", operation: "merge", id: "goal:x", record: { parentPath: "goal:other" },
    });
    expect(await page(pathOnly, nullableTree, childrenOf, [child])).toEqual([]);

    const keyOnly = await hydratingGoals();
    await offlineWrite(keyOnly, nullableTree, {
      resource: "goals", operation: "merge", id: "goal:x", record: { parentId: "goal:other" },
    });
    expect(await page(keyOnly, nullableTree, childrenOf, [child])).toEqual([{ ...child, parentId: "goal:other" }]);
  });

  it("hydration: a returned child whose nullable parent key is null stays after an unrelated merge", async () => {
    const storage = await hydratingGoals();
    await offlineWrite(storage, nullableTree, {
      resource: "goals", operation: "merge", id: "goal:x", record: { title: "Renamed" },
    });
    const rows = [{ ...child, parentId: null }];
    expect(await page(storage, nullableTree, childrenOf, rows)).toEqual([{ ...rows[0], title: "Renamed" }]);
  });

  it("hydration: an inverse page is emptied when a pending write clears the anchor's path", async () => {
    const rows = [{ id: "goal:a", title: "Root", parentPath: "" }];
    const query = { resource: "goals", id: "goal:c", relation: "parent", select: ["id", "title", "parentPath"] };
    const replaced = await hydratingGoals();
    await offlineWrite(replaced, nullableTree, {
      resource: "goals", operation: "replace", id: "goal:c", record: { title: "C" },
    });
    expect(await page(replaced, nullableTree, query, rows)).toEqual([]);

    const cleared = await hydratingGoals();
    await offlineWrite(cleared, nullableTree, {
      resource: "goals", operation: "merge", id: "goal:c", record: { parentPath: null },
    });
    expect(await page(cleared, nullableTree, query, rows)).toEqual([]);
  });

  it("hydration: a child the replay makes ancestor-inactive leaves an inheriting htree page", async () => {
    const inheriting: DatafnSchema = {
      resources: [
        { name: "projects", version: 1, capabilities: ["archivable"], fields: [{ name: "name", type: "string", required: false }] },
        {
          name: "goals",
          version: 1,
          fields: [...treeSchema.resources[0].fields, { name: "projectId", type: "string", required: false }],
        },
      ],
      relations: [
        { ...treeSchema.relations![0], inheritsInactive: true },
        { from: "goals", to: "projects", type: "many-one", relation: "project", inverse: "goals", fkField: "projectId", inheritsInactive: true },
      ],
    } as DatafnSchema;
    const storage = new MemoryStorageAdapter(["projects", "goals"]);
    await storage.setHydrationState("goals", "hydrating");
    await offlineWrite(storage, inheriting, {
      resource: "projects", operation: "merge", id: "project:p", record: { name: "P" },
    });
    await offlineWrite(storage, inheriting, { resource: "projects", operation: "archive", id: "project:p" });
    const rows = [{ ...child, projectId: "project:p" }];
    expect(await page(storage, inheriting, childrenOf, rows)).toEqual([]);
    expect(await page(storage, inheriting, { ...childrenOf, metadata: { includeAncestorInactive: true } }, rows))
      .toEqual(rows);
  });

  it("filter-dependencies: a nested filter field the server or the query omits stays unknown after a sibling merge", async () => {
    const storage = await hydrating("notes");
    await offlineWrite(storage, folderSchema, {
      resource: "notes", operation: "merge", id: "note:1", record: { profile: { note: "x" } },
    });
    const rows = [{ id: "note:1", title: "A", profile: {} }];
    // The server omits the many-one key folderId at every depth.
    expect(await page(storage, folderSchema, { resource: "notes", filters: { "profile.folderId": "folder:1" } }, rows))
      .toEqual([{ ...rows[0], profile: { note: "x" } }]);
    expect(await page(
      storage, folderSchema, { resource: "notes", filters: { "profile.status": "open" }, omit: ["status"] }, rows,
    )).toEqual([{ ...rows[0], profile: { note: "x" } }]);
  });

  it("filter-dependencies: a row a pending delete and merge recreate is judged on fields the page hides", async () => {
    const storage = await hydratingStorage();
    await pendingChange(storage, "mutation:recreate-delete", { operation: "delete", id: "task:1" });
    await pendingChange(storage, "mutation:recreate-merge", { operation: "merge", id: "task:1", record: { note: "x" } });
    await pendingChange(storage, "mutation:sibling-merge", { operation: "merge", id: "task:2", record: { note: "y" } });
    const result = (await executeQuery(
      remoteReturning({ data: [{ id: "task:1" }, { id: "task:2" }], nextCursor: "next" }),
      { resource: "tasks", limit: 2, select: ["id"], filters: { title: "Open" } },
      storage,
      [],
      schema,
    )) as { data: Array<Record<string, unknown>> };
    expect(result.data.map((row) => row.id)).toEqual(["task:2"]);
  });

  it("filter-dependencies: a pending date the codec cannot read is unknown and keeps the server's value", async () => {
    const storage = await hydratingStorage();
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:bad-date", timestampMs: 1,
      mutation: { resource: "tasks", operation: "merge", id: "task:1", record: { dueAt: "not-a-date" } },
    });
    const dueAt = "2026-01-01T00:00:00.000Z";
    const rows = [{ id: "task:1", title: "Open", dueAt }];
    // The page is returned with its dates decoded.
    expect(await page(storage, schema, { resource: "tasks", filters: { dueAt } }, rows))
      .toEqual([{ ...rows[0], dueAt: new Date(dueAt) }]);
  });

  it("projection-shape: an htree page hides a pending foreign key named like its relation, as the server's omit pass does", async () => {
    const ownedTree: DatafnSchema = {
      resources: [
        { name: "users", version: 1, fields: [{ name: "name", type: "string", required: false }] },
        {
          name: "goals",
          version: 1,
          fields: [...treeSchema.resources[0].fields, { name: "owner", type: "string", required: false }],
        },
      ],
      relations: [
        ...treeSchema.relations!,
        { from: "goals", to: "users", type: "many-one", relation: "owner", fkField: "owner" },
      ],
    };
    const storage = new MemoryStorageAdapter(["users", "goals"]);
    await storage.setHydrationState("goals", "hydrating");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:owner", timestampMs: 1,
      mutation: { resource: "goals", operation: "relate", id: "goal:x", relations: { owner: "users:2" } },
    });
    expect(await page(storage, ownedTree, childrenOf, [child])).toEqual([child]);
    expect(await page(storage, ownedTree, { ...childrenOf, select: ["*", "**"] }, [child])).toEqual([child]);
  });

  it("hydration: a direct child's path names the anchor by its full id, and a malformed path proves nothing", async () => {
    const storage = await hydratingGoals();
    await offlineWrite(storage, nullableTree, {
      resource: "goals", operation: "merge", id: "goal:x", record: { title: "Renamed" },
    });
    // The root goal:c-extra holds the anchor goal:c.
    const rows = [{ id: "goal:x", title: "X", parentId: "goal:c", parentPath: "goal:c-extra-goal:c" }];
    expect(await page(storage, nullableTree, childrenOf, rows)).toEqual([{ ...rows[0], title: "Renamed" }]);

    const malformed = await hydratingGoals();
    await malformed.changelogAppend({
      clientId: "client:1", mutationId: "mutation:bad-path", timestampMs: 1,
      mutation: { resource: "goals", operation: "merge", id: "goal:x", record: { parentPath: 7 } },
    });
    expect((await page(malformed, nullableTree, childrenOf, [child])).map((row) => row.id)).toEqual(["goal:x"]);
  });

  it("filter-dependencies: a replace keeps hidden readonly and capability fields unknown", async () => {
    const stamped: DatafnSchema = {
      resources: [{
        name: "tasks",
        version: 1,
        capabilities: ["timestamps"],
        fields: [
          { name: "title", type: "string", required: false },
          { name: "code", type: "string", required: false, readonly: true },
        ],
      }],
      relations: [],
    } as DatafnSchema;
    const storage = await hydratingStorage();
    await pendingChange(storage, "mutation:replace-title", { operation: "replace", id: "task:1", record: { title: "x" } });
    const rows = [{ id: "task:1", title: "a" }];
    const query = { resource: "tasks", select: ["id", "title"] };
    expect((await page(storage, stamped, { ...query, filters: { createdAt: { $gte: 0 } } }, rows)).map((row) => row.id))
      .toEqual(["task:1"]);
    expect((await page(storage, stamped, { ...query, filters: { code: "A" } }, rows)).map((row) => row.id))
      .toEqual(["task:1"]);
  });

  it("filter-dependencies: a replaced nested value settles members the server also hides", async () => {
    const storage = await hydrating("notes");
    await storage.changelogAppend({
      clientId: "client:1", mutationId: "mutation:replace-profile", timestampMs: 1,
      mutation: { resource: "notes", operation: "replace", id: "note:1", record: { title: "A", profile: { note: "x" } } },
    });
    const rows = [{ id: "note:1", title: "A", profile: {} }];
    expect(await page(storage, folderSchema, { resource: "notes", filters: { "profile.folderId": "folder:1" } }, rows))
      .toEqual([]);
  });
});
