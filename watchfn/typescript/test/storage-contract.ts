import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWatch, type StorageAdapter, type StoredEvent, type Watch } from "../src/index.js";

/** Labels test output so memory-fixture results are never read as durable-adapter evidence. */
export type ContractEvidence = "memory-fixture" | "durable-sqlite";

export interface ContractHarness {
  storage: StorageAdapter;
  /** Durable adapters only: a fresh storage over a new connection to the same database. */
  reopen?: () => StorageAdapter;
  cleanup(): void | Promise<void>;
}

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

function event(id: string, minutes: number, type = "sdk.failure", attributes: StoredEvent["attributes"] = {}): StoredEvent {
  return { id, type, timestamp: at(minutes), receivedAt: at(minutes), attributes };
}

/**
 * The storage adapter contract, run through the public runtime and directly
 * against the adapter. Every adapter must pass it unchanged.
 */
export function describeStorageContract(evidence: ContractEvidence, create: () => ContractHarness | Promise<ContractHarness>): void {
  describe(`[${evidence}] storage adapter contract`, () => {
    let harness: ContractHarness;
    let watch: Watch;
    let ids: number;

    beforeEach(async () => {
      harness = await create();
      ids = 0;
      watch = createWatch({ storage: harness.storage, generateId: () => `evt-${++ids}`, now: () => T0 + 999 * 60_000 });
      await watch.start();
    });

    afterEach(async () => {
      await watch.stop();
      await harness.cleanup();
    });

    it(`[${evidence}] returns ingested events with every field as persisted`, async () => {
      const receipt = await watch.ingest({
        type: "sdk.failure",
        timestamp: at(1),
        attributes: { operation: "tasks.get", release: "1.2.0", status: 503, retryable: true },
        data: { message: "upstream unavailable", attempts: [1, 2], detail: null },
      });
      expect(receipt).toMatchObject({ ok: true, storage: harness.storage.kind, durable: harness.storage.durable });
      const plain = await watch.ingest({ type: "sdk.success" });
      expect(plain.ok).toBe(true);

      const result = await watch.query({ order: "asc" });
      expect(result).toEqual({
        truncated: false,
        events: [
          {
            id: "evt-1",
            type: "sdk.failure",
            timestamp: at(1),
            receivedAt: at(999),
            attributes: { operation: "tasks.get", release: "1.2.0", status: 503, retryable: true },
            data: { message: "upstream unavailable", attempts: [1, 2], detail: null },
          },
          { id: "evt-2", type: "sdk.success", timestamp: at(999), receivedAt: at(999), attributes: {} },
        ],
      });
      if (receipt.ok) expect(result.events[0]).toEqual(receipt.event);
    });

    it(`[${evidence}] filters by an inclusive from and an exclusive to`, async () => {
      for (const minute of [0, 1, 2, 3]) await watch.ingest({ type: "tick", timestamp: at(minute), attributes: { minute } });
      const { events } = await watch.query({ from: at(1), to: at(3), order: "asc" });
      expect(events.map((item) => item.attributes.minute)).toEqual([1, 2]);
      expect((await watch.query({ from: at(2), to: at(2) })).events).toEqual([]);
      expect((await watch.query({ from: new Date(T0 + 3 * 60_000) })).events.map((item) => item.attributes.minute)).toEqual([3]);
      expect((await watch.query({ to: T0 + 60_000 })).events.map((item) => item.attributes.minute)).toEqual([0]);
    });

    it(`[${evidence}] filters by one or several types`, async () => {
      await watch.ingestBatch([
        { type: "sdk.failure", timestamp: at(1) },
        { type: "sdk.success", timestamp: at(2) },
        { type: "infra.process", timestamp: at(3) },
      ]);
      expect((await watch.query({ type: "sdk.success" })).events.map((item) => item.type)).toEqual(["sdk.success"]);
      expect((await watch.query({ type: ["sdk.failure", "infra.process"], order: "asc" })).events.map((item) => item.type)).toEqual([
        "sdk.failure",
        "infra.process",
      ]);
    });

    it(`[${evidence}] matches attributes by exact value and type, all filters together`, async () => {
      await watch.ingestBatch([
        { type: "sdk.failure", timestamp: at(1), attributes: { operation: "tasks.get", release: "1.2.0", status: 503 } },
        { type: "sdk.failure", timestamp: at(2), attributes: { operation: "tasks.get", release: "1.3.0", status: "503" } },
        { type: "sdk.failure", timestamp: at(3), attributes: { operation: "tasks.list", release: "1.2.0", retryable: true } },
        { type: "sdk.failure", timestamp: at(4), attributes: { operation: "tasks.list", retryable: "true", note: "' OR 1=1 --" } },
      ]);
      const minutes = async (attributes: StoredEvent["attributes"]) =>
        (await watch.query({ attributes, order: "asc" })).events.map((item) => Date.parse(item.timestamp) - T0).map((ms) => ms / 60_000);

      expect(await minutes({ operation: "tasks.get" })).toEqual([1, 2]);
      expect(await minutes({ operation: "tasks.get", release: "1.2.0" })).toEqual([1]);
      expect(await minutes({ status: 503 })).toEqual([1]);
      expect(await minutes({ status: "503" })).toEqual([2]);
      expect(await minutes({ retryable: true })).toEqual([3]);
      expect(await minutes({ retryable: "true" })).toEqual([4]);
      expect(await minutes({ release: "1.2.0", retryable: true })).toEqual([3]);
      expect(await minutes({ note: "' OR 1=1 --" })).toEqual([4]);
      expect(await minutes({ note: "%" })).toEqual([]);
      expect(await minutes({ missing: "x" })).toEqual([]);
    });

    it(`[${evidence}] matches every finite number attribute exactly, including unsafe integers and fractions`, async () => {
      const values = [
        0,
        -1,
        42,
        2 ** 53 - 1,
        2 ** 53 + 2,
        -(2 ** 53 + 2),
        6211250849822136000,
        Number("9223372036854775807"), // 2**63 as a double
        -9223372036854775808,
        1e19,
        1e21,
        -1e21,
        1.7976931348623157e308,
        5e-324,
        12.345678901234567,
        0.1 + 0.2,
        0.3,
        -2.5,
        // Doubles SQLite's own JSON number parser rounds differently from JavaScript.
        1.4384785101172959e-305,
        3.1048720994651723e-229,
        4.6113222607176895e256,
        -4.6817947788043094e-226,
      ];
      await watch.ingestBatch(values.map((v, index) => ({ type: "num", timestamp: at(index), attributes: { v, index } })));
      for (const [index, v] of values.entries()) {
        const { events } = await watch.query({ attributes: { v }, order: "asc" });
        // 9223372036854775807 and 2**63 are the same double, so both events match either query.
        const expected = values.flatMap((other, i) => (other === v ? [i] : []));
        expect({ v, matched: events.map((item) => item.attributes.index) }).toEqual({ v, matched: expected });
        expect(events.every((item) => item.attributes.v === v)).toBe(true);
        expect(expected).toContain(index);
      }
      expect((await watch.query({ attributes: { v: 0.30000000000000004 } })).events.map((item) => item.attributes.index)).toEqual([15]);
      expect((await watch.query({ attributes: { v: -0 } })).events.map((item) => item.attributes.index)).toEqual([0]);
      expect((await watch.query({ attributes: { v: Number("6211250849822136001") } })).events.map((item) => item.attributes.index)).toEqual([6]);
      expect((await watch.query({ attributes: { v: 6211250849822137000 } })).events).toEqual([]);
      expect((await watch.query({ attributes: { v: "42" } })).events).toEqual([]);
    });

    it(`[${evidence}] matches every accepted string attribute exactly, including lone surrogates, NUL, quotes and backslashes`, async () => {
      const values = [
        "\uD800",
        "\uDBFF",
        "\uDC00",
        "x\uDC00y",
        "\uDC00\uD800",
        "\uD83D\uDE00",
        "\uFFFD",
        "😀 ok",
        "a\u0000b",
        "a",
        "\u0000",
        '"quoted"',
        "back\\slash",
        "\\u0041",
        "A",
        "\u2028\u007f\n\t",
        "",
        "Ä",
        "A\u0308",
      ];
      await watch.ingestBatch(values.map((s, index) => ({ type: "str", timestamp: at(index), attributes: { s, index } })));
      for (const [index, s] of values.entries()) {
        const { events } = await watch.query({ attributes: { s }, order: "asc" });
        expect({ s, matched: events.map((item) => item.attributes.index) }).toEqual({ s, matched: [index] });
        expect(events[0]?.attributes.s === s).toBe(true);
      }
      expect((await watch.query({ attributes: { s: "\uDFFF" } })).events).toEqual([]);
      expect((await watch.query({ attributes: { s: "x\uFFFDy" } })).events).toEqual([]);
    });

    it(`[${evidence}] filters string, number and boolean attributes on names containing . : and -`, async () => {
      const attributes = (n: number) => ({ "a.b": `s${n}`, "x:y-z": n, "flag.on:off-x": n % 2 === 0, a: "decoy", b: n });
      await watch.ingestBatch([0, 1, 2].map((n) => ({ type: "keys", timestamp: at(n), attributes: attributes(n) })));
      const matched = async (filter: StoredEvent["attributes"]) =>
        (await watch.query({ attributes: filter, order: "asc" })).events.map((item) => item.attributes.b);
      expect(await matched({ "a.b": "s1" })).toEqual([1]);
      expect(await matched({ "x:y-z": 2 })).toEqual([2]);
      expect(await matched({ "flag.on:off-x": true })).toEqual([0, 2]);
      expect(await matched({ "flag.on:off-x": false, "a.b": "s1", "x:y-z": 1 })).toEqual([1]);
      expect(await matched({ "a.b": "decoy" })).toEqual([]);
      expect(await matched({ "x:y-z": "2" })).toEqual([]);
      expect(await matched({ "flag.on:off-x": "true" })).toEqual([]);
    });

    it(`[${evidence}] orders by timestamp; desc is the exact reverse of asc, including ties`, async () => {
      await watch.ingest({ type: "tie", timestamp: at(5), attributes: { n: 1 } });
      await watch.ingest({ type: "tie", timestamp: at(4), attributes: { n: 2 } });
      await watch.ingest({ type: "tie", timestamp: at(5), attributes: { n: 3 } });
      const order = async (direction: "asc" | "desc") => (await watch.query({ order: direction })).events.map((item) => item.attributes.n);
      expect(await order("asc")).toEqual([2, 1, 3]);
      expect(await order("desc")).toEqual([3, 1, 2]);
      expect((await watch.query()).events.map((item) => item.attributes.n)).toEqual([3, 1, 2]);
    });

    it(`[${evidence}] applies the limit and reports truncation`, async () => {
      await watch.ingestBatch([1, 2, 3].map((minute) => ({ type: "tick", timestamp: at(minute) })));
      const limited = await watch.query({ limit: 2 });
      expect(limited.events.map((item) => item.timestamp)).toEqual([at(3), at(2)]);
      expect(limited.truncated).toBe(true);
      expect((await watch.query({ limit: 3 })).truncated).toBe(false);
    });

    it(`[${evidence}] writes a batch atomically: a conflicting id leaves nothing behind`, async () => {
      await harness.storage.write([event("dup", 1)]);
      await expect(harness.storage.write([event("fresh", 2), event("dup", 3)])).rejects.toThrow();
      await expect(harness.storage.write([event("twin", 2), event("twin", 3)])).rejects.toThrow();
      const stored = await harness.storage.query({ attributes: [], limit: 10, order: "asc" });
      expect(stored.map((item) => item.id)).toEqual(["dup"]);
    });

    it(`[${evidence}] refuses a direct write with a timestamp it could not return, atomically`, async () => {
      const first = "1970-01-01T00:00:00.000Z";
      const last = "9999-12-31T23:59:59.999Z";
      await harness.storage.write([{ ...event("first", 0), timestamp: first, receivedAt: first }]);
      await harness.storage.write([{ ...event("last", 0), timestamp: last, receivedAt: last }]);
      const invalid = ["1969-12-31T23:59:59.999Z", "-000001-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z", "not a date"];
      for (const bad of invalid) {
        await expect(harness.storage.write([event("ok", 1), { ...event("bad", 2), timestamp: bad }])).rejects.toThrow(RangeError);
        await expect(harness.storage.write([event("ok", 1), { ...event("bad", 2), receivedAt: bad }])).rejects.toThrow(RangeError);
      }
      const stored = await harness.storage.query({ attributes: [], limit: 10, order: "asc" });
      expect(stored.map((item) => [item.id, item.timestamp])).toEqual([
        ["first", first],
        ["last", last],
      ]);
    });

    it(`[${evidence}] returns detached copies that callers cannot use to change storage`, async () => {
      const receipt = await watch.ingest({ type: "copy", attributes: { k: "v" }, data: { nested: { n: 1 } } });
      if (!receipt.ok) throw new Error("ingest failed");
      receipt.event.attributes.k = "changed";
      const first = (await watch.query()).events[0]!;
      (first.data as { nested: { n: number } }).nested.n = 2;
      expect((await watch.query()).events[0]).toMatchObject({ attributes: { k: "v" }, data: { nested: { n: 1 } } });
    });

    if (evidence === "durable-sqlite") {
      it(`[${evidence}] keeps events across a stop and a new connection to the same database`, async () => {
        await watch.ingest({ type: "persisted", timestamp: at(7), attributes: { operation: "tasks.get" } });
        await watch.stop();
        const reopened = createWatch({ storage: harness.reopen!() });
        await reopened.start();
        const { events } = await reopened.query({ attributes: { operation: "tasks.get" } });
        expect(events).toEqual([{ id: "evt-1", type: "persisted", timestamp: at(7), receivedAt: at(999), attributes: { operation: "tasks.get" } }]);
        await reopened.stop();
      });
    } else {
      it(`[${evidence}] reports itself as not durable on every receipt`, async () => {
        const receipt = await watch.ingest({ type: "fixture" });
        expect(receipt).toMatchObject({ ok: true, storage: "memory", durable: false });
      });
    }
  });
}
