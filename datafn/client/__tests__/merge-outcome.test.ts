/**
 * DATA-15: the "created" flag a local merge reports to live queries is
 * scoped per client, never lingers, and survives debounce coalescing.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { DatafnSchema } from "@datafn/core";
import { createDatafnClient } from "../src/client.js";
import { MemoryStorageAdapter } from "../src/adapters/memoryStorage.js";
import { rememberMergeCreated, takeMergeCreated } from "../src/offline/mutate.js";

const schema: DatafnSchema = {
  resources: [
    {
      name: "notes",
      version: 1,
      fields: [
        { name: "title", type: "string", required: false },
        { name: "body", type: "string", required: false },
      ],
    },
  ],
  relations: [],
};

const clients: Array<{ destroy?: () => Promise<void> | void }> = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.destroy?.();
});

async function setup() {
  const storage = new MemoryStorageAdapter(["notes"]);
  await storage.upsertRecord("notes", { id: "notes:1", title: "One" });
  await storage.setHydrationState("notes", "hydrating");
  await storage.setHydrationState("notes", "ready");
  const client = createDatafnClient({
    schema,
    clientId: "outcome-client",
    storage,
    sync: { mode: "local-only", offlinability: true },
  });
  clients.push(client as any);
  const events: any[] = [];
  client.subscribe((event: any) => {
    if (event.type === "mutation_applied") events.push(event);
  });
  return { client, storage, events };
}

describe("merge outcomes", () => {
  it("keeps the outcomes of clients that share a store and a mutation id apart", () => {
    const storage = new MemoryStorageAdapter(["notes"]);
    rememberMergeCreated(storage, "client-a", "m1", true);
    rememberMergeCreated(storage, "client-b", "m1", false);
    expect(takeMergeCreated(storage, "client-a", "m1")).toBe(true);
    expect(takeMergeCreated(storage, "client-b", "m1")).toBe(false);
    expect(takeMergeCreated(storage, "client-a", "m1")).toBeUndefined();
  });

  it("does not keep the outcome of a silent merge", async () => {
    const { client, storage, events } = await setup();
    await client.table("notes").mutate({
      operation: "merge",
      id: "notes:2",
      record: { title: "Two" },
      mutationId: "m-silent",
      silent: true,
    } as any);
    expect(events).toEqual([]);
    expect(await storage.getRecord("notes", "notes:2")).toMatchObject({ title: "Two" });
    expect(takeMergeCreated(storage, "outcome-client", "m-silent")).toBeUndefined();
  });

  it("reports a creation for coalesced merges when the first one created the record", async () => {
    const { client, storage, events } = await setup();
    const notes = client.table("notes");
    const first = notes.mutate({
      operation: "merge",
      id: "notes:new",
      record: { title: "New" },
      mutationId: "m-create",
      debounceKey: "notes:new",
      debounceMs: 20,
    } as any);
    const second = notes.mutate({
      operation: "merge",
      id: "notes:new",
      record: { body: "text" },
      mutationId: "m-edit",
      debounceKey: "notes:new",
      debounceMs: 20,
    } as any);
    await Promise.all([first, second]);
    await client.flush?.("notes:new");
    await new Promise((resolve) => setTimeout(resolve, 60));

    const merges = events.filter((event) => event.resource === "notes" && event.action === "merge");
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ mutationId: "m-create", created: true });
    expect(takeMergeCreated(storage, "outcome-client", "m-edit")).toBeUndefined();
  });
});
