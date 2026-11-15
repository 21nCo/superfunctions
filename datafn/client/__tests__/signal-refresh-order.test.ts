/**
 * DATA-15: a per-record re-read never overwrites a newer full read, and
 * re-reads do not overlap each other.
 */
import { describe, expect, it } from "vitest";
import type { DatafnSchema } from "@datafn/core";
import { EventBus } from "../src/events/bus.js";
import { SignalRegistry } from "../src/signals/querySignal.js";

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

type Pending = { query: any; resolve: (value: unknown) => void };

function controllableClient() {
  const pending: Pending[] = [];
  const client = {
    query(query: any) {
      return new Promise((resolve) => pending.push({ query, resolve }));
    },
  };
  return { client, pending };
}

const isIdProbe = (query: any) => JSON.stringify(query.filters ?? {}).includes('"$in"');
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function bodyMerge(bus: EventBus, id: string, record: Record<string, unknown>) {
  bus.emit({
    type: "mutation_applied",
    resource: "notes",
    ids: [id],
    action: "merge",
    record,
    created: false,
    timestampMs: Date.now(),
  } as any);
}

async function openSignal() {
  const { client, pending } = controllableClient();
  const bus = new EventBus();
  const registry = new SignalRegistry(client, bus, schema);
  const signal = registry.getSignal<any[]>({ resource: "notes", version: 1, sort: ["title"] });
  const values: any[][] = [];
  signal.subscribe((value) => {
    if (value !== undefined) values.push(value);
  });
  pending.shift()!.resolve({
    data: [
      { id: "notes:a", title: "A", body: "1" },
      { id: "notes:b", title: "B", body: "1" },
    ],
  });
  await tick(0);
  return { signal, bus, pending, values };
}

describe("per-record re-reads", () => {
  it("drops a re-read that a later full read overtook", async () => {
    const { signal, bus, pending, values } = await openSignal();
    bodyMerge(bus, "notes:a", { body: "2" });
    await tick();
    const reread = pending.shift()!;
    expect(isIdProbe(reread.query)).toBe(true);

    const full = signal.refresh();
    const fullRead = pending.shift()!;
    expect(isIdProbe(fullRead.query)).toBe(false);
    fullRead.resolve({
      data: [
        { id: "notes:b", title: "B", body: "1" },
        { id: "notes:a", title: "Z", body: "3" },
      ],
    });
    await full;
    reread.resolve({ data: [{ id: "notes:a", title: "A", body: "2" }] });
    await tick(0);

    expect(values.at(-1)).toEqual([
      { id: "notes:b", title: "B", body: "1" },
      { id: "notes:a", title: "Z", body: "3" },
    ]);
  });

  it("waits for a running re-read before starting the next read", async () => {
    const { bus, pending, values } = await openSignal();
    bodyMerge(bus, "notes:a", { body: "2" });
    await tick();
    const first = pending.shift()!;
    expect(isIdProbe(first.query)).toBe(true);

    // A second change while the first re-read runs does not start another read.
    bodyMerge(bus, "notes:a", { body: "3" });
    await tick();
    expect(pending).toHaveLength(0);

    first.resolve({ data: [{ id: "notes:a", title: "A", body: "2" }] });
    await tick();
    const second = pending.shift()!;
    expect(isIdProbe(second.query)).toBe(true);
    second.resolve({ data: [{ id: "notes:a", title: "A", body: "3" }] });
    await tick(0);
    expect(values.at(-1)!.find((r) => r.id === "notes:a")!.body).toBe("3");
  });
});

describe("edits during a full read", () => {
  it("re-reads after an edit to a record the running full read may bring in", async () => {
    const { client, pending } = controllableClient();
    const bus = new EventBus();
    const registry = new SignalRegistry(client, bus, schema);
    const signal = registry.getSignal<any[]>({
      resource: "notes",
      version: 1,
      filters: { title: "A" },
      sort: ["title"],
    });
    const values: any[][] = [];
    signal.subscribe((value) => {
      if (value !== undefined) values.push(value);
    });
    pending.shift()!.resolve({ data: [{ id: "notes:a", title: "A", body: "1" }] });
    await tick(0);

    // notes:b now matches the filter; the full read it triggers captures body 1.
    bus.emit({
      type: "mutation_applied",
      resource: "notes",
      ids: ["notes:b"],
      action: "merge",
      record: { title: "A" },
      created: false,
      timestampMs: Date.now(),
    } as any);
    await tick();
    const membershipRead = pending.shift()!;
    expect(isIdProbe(membershipRead.query)).toBe(false);

    // A body edit to notes:b while that read runs.
    bodyMerge(bus, "notes:b", { body: "2" });
    await tick();
    membershipRead.resolve({
      data: [
        { id: "notes:a", title: "A", body: "1" },
        { id: "notes:b", title: "A", body: "1" },
      ],
    });
    await tick();

    const followUp = pending.shift();
    expect(followUp).toBeDefined();
    followUp!.resolve({
      data: [
        { id: "notes:a", title: "A", body: "1" },
        { id: "notes:b", title: "A", body: "2" },
      ],
    });
    await tick(0);
    expect(values.at(-1)!.find((r) => r.id === "notes:b")!.body).toBe("2");
  });
});
