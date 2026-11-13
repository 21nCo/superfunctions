import { describe, expect, it } from "vitest";
import { RingBuffer } from "../src/utils/ring-buffer.js";

const entry = (id: number, timestamp = id) => ({ id, timestamp });
const ids = (entries: Array<{ id: number }>) => entries.map((item) => item.id);

describe("RingBuffer bounds", () => {
  it("keeps the newest entries in insertion order once full", () => {
    const buffer = new RingBuffer<ReturnType<typeof entry>>(3);
    for (let id = 1; id <= 7; id += 1) buffer.push(entry(id));
    expect(buffer.size).toBe(3);
    expect(ids(buffer.toArray())).toEqual([5, 6, 7]);
  });

  it("holds exactly capacity entries at the boundary and evicts one at a time", () => {
    const buffer = new RingBuffer<ReturnType<typeof entry>>(2);
    buffer.push(entry(1));
    buffer.push(entry(2));
    expect(ids(buffer.toArray())).toEqual([1, 2]);
    buffer.push(entry(3));
    expect(ids(buffer.toArray())).toEqual([2, 3]);
  });

  it("stores nothing with capacity 0", () => {
    const buffer = new RingBuffer<ReturnType<typeof entry>>(0);
    buffer.push(entry(1));
    expect(buffer.size).toBe(0);
    expect(buffer.toArray()).toEqual([]);
  });

  it("rejects a negative, fractional or non-numeric capacity", () => {
    for (const capacity of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new RingBuffer(capacity)).toThrow(RangeError);
    }
  });

  it("restarts cleanly after clear()", () => {
    const buffer = new RingBuffer<ReturnType<typeof entry>>(2);
    for (let id = 1; id <= 3; id += 1) buffer.push(entry(id));
    buffer.clear();
    expect(buffer.size).toBe(0);
    buffer.push(entry(9));
    expect(ids(buffer.toArray())).toEqual([9]);
  });
});

describe("RingBuffer window query", () => {
  const filled = () => {
    const buffer = new RingBuffer<ReturnType<typeof entry>>(10);
    for (const timestamp of [100, 200, 200, 300, 400]) buffer.push(entry(buffer.size + 1, timestamp));
    return buffer;
  };

  it("returns everything without bounds", () => {
    expect(ids(filled().query())).toEqual([1, 2, 3, 4, 5]);
    expect(ids(filled().query({}))).toEqual([1, 2, 3, 4, 5]);
  });

  it("includes entries exactly at since and at until", () => {
    expect(ids(filled().query({ since: 200, until: 300 }))).toEqual([2, 3, 4]);
    expect(ids(filled().query({ since: 200 }))).toEqual([2, 3, 4, 5]);
    expect(ids(filled().query({ until: 200 }))).toEqual([1, 2, 3]);
  });

  it("excludes entries one millisecond outside the window", () => {
    expect(ids(filled().query({ since: 201, until: 299 }))).toEqual([]);
    expect(ids(filled().query({ since: 101, until: 399 }))).toEqual([2, 3, 4]);
  });

  it("matches a single instant when since equals until", () => {
    expect(ids(filled().query({ since: 200, until: 200 }))).toEqual([2, 3]);
  });

  it("matches nothing for an inverted window and accepts infinite bounds", () => {
    expect(filled().query({ since: 300, until: 200 })).toEqual([]);
    expect(ids(filled().query({ since: Number.NEGATIVE_INFINITY, until: Number.POSITIVE_INFINITY }))).toHaveLength(5);
  });

  it("does not lose entries when the wall clock stepped backwards", () => {
    const buffer = new RingBuffer<ReturnType<typeof entry>>(5);
    for (const timestamp of [500, 100, 600]) buffer.push(entry(buffer.size + 1, timestamp));
    expect(ids(buffer.query({ since: 50, until: 150 }))).toEqual([2]);
  });

  it("only queries entries that are still buffered", () => {
    const buffer = new RingBuffer<ReturnType<typeof entry>>(2);
    for (const timestamp of [100, 200, 300]) buffer.push(entry(timestamp, timestamp));
    expect(ids(buffer.query({ since: 0, until: 1000 }))).toEqual([200, 300]);
  });

  it("rejects NaN and non-number bounds", () => {
    expect(() => filled().query({ since: Number.NaN })).toThrow(RangeError);
    expect(() => filled().query({ until: "300" as unknown as number })).toThrow(RangeError);
  });
});
