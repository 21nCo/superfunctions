import { describe, expect, it } from "vitest";
import { deserialize, estimateSize, serialize } from "../src/utils/serialize.js";
import { EventEmitter } from "../src/core/events.js";
import { cacheFn } from "../src/index.js";
const roundTrip = <T>(value: T): T => deserialize(serialize(value));

describe("serialization", () => {
  it("preserves dates, regexp state and undefined properties", () => {
    const regexp = new RegExp("a/b", "dg");
    regexp.lastIndex = 3;
    const value = { date: new Date(1000), regexp, absent: undefined };
    const copy = roundTrip(value);
    expect(copy).toEqual(value);
    expect(copy.date).toBeInstanceOf(Date);
    expect(copy.regexp.lastIndex).toBe(3);
    expect(Object.prototype.hasOwnProperty.call(copy, "absent")).toBe(true);
    expect(roundTrip(undefined)).toBeUndefined();
  });
  it("preserves reserved user fields and prototype-shaped keys as data", () => {
    const value = JSON.parse('{"__type":"Date","value":"x","__proto__":{"polluted":true},"format":"cachefn/1"}');
    const copy = roundTrip(value);
    expect(copy).toEqual(value);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(({} as any).polluted).toBeUndefined();
    expect(deserialize('{"__type":"undefined"}')).toEqual({ __type: "undefined" });
  });
  it("preserves non-JSON primitives, sparse arrays and collections", () => {
    const array = [undefined, , NaN, Infinity, -Infinity, -0, 42n];
    const copy = roundTrip(array);
    expect(copy).toEqual(array);
    expect(0 in copy).toBe(true);
    expect(1 in copy).toBe(false);
    expect(Object.is(copy[5], -0)).toBe(true);
    const map = new Map([[1, new Set(["a", undefined])]]);
    expect(roundTrip(map)).toEqual(map);
    const dictionary = Object.assign(Object.create(null), { item: undefined });
    expect(Object.getPrototypeOf(roundTrip(dictionary))).toBeNull();
    expect(Number.isNaN(roundTrip(new Date(NaN)).getTime())).toBe(true);
  });
  it("rejects circular/unsupported serialization but keeps memory stats usable", async () => {
    const cycle: any = { item: "hello" }; cycle.self = cycle;
    expect(() => serialize(cycle)).toThrow(/circular/);
    expect(() => serialize(() => 1)).toThrow(/Unsupported/);
    expect(() => serialize(Symbol("x"))).toThrow(/Unsupported/);
    expect(() => serialize({ [Symbol("x")]: 1 })).toThrow(/symbol-keyed/);
    expect(estimateSize(cycle)).toBeGreaterThan(0);
    expect(estimateSize({ get value() { throw new Error("getter"); } })).toBe(0);
    const cache = cacheFn({ name: "cycle" });
    await cache.set("cycle", cycle);
    expect((await cache.getStats()).memoryUsage).toBeGreaterThan(0);
    expect(await cache.get("cycle")).toBe(cycle);
  });
  it("validates tagged payloads and reads ordinary JSON", () => {
    expect(deserialize('{"value":1}')).toEqual({ value: 1 });
    expect(() => deserialize('{"format":"cachefn/1","value":["unknown"]}')).toThrow();
    expect(() => deserialize('{"format":"cachefn/1","value":["object",[["x"]]]}')).toThrow();
  });
});

describe("event delivery", () => {
  it("snapshots handlers before listeners change subscriptions", () => {
    const events = new EventEmitter(); const calls: string[] = [];
    const second = () => { calls.push("second"); };
    events.on("hit", () => {
      calls.push("first"); events.off("hit", second);
      events.on("hit", () => { calls.push("late"); });
    });
    events.on("hit", second); events.emit("hit", {});
    expect(calls).toEqual(["first", "second"]);
  });
  it("can remove an empty event name independently", () => {
    const events = new EventEmitter(); const calls: string[] = [];
    events.on("", () => { calls.push("empty"); });
    events.on("hit", () => { calls.push("hit"); });
    events.removeAllListeners(""); events.emit("", {}); events.emit("hit", {});
    expect(calls).toEqual(["hit"]);
  });
});
