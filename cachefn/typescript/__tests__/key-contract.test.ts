import { expect, it } from "vitest";
import { hashArgs } from "../src/utils/hash.js";
import { filterByPattern } from "../src/utils/pattern.js";
it("distinguishes values JSON serialization aliases", () => {
  const values = [undefined, null, NaN, Infinity, -Infinity, 0, -0, 1n, "1", 1, new Date(0), new Date(0).toISOString(), {}, {a: undefined}, [], Array(1), [undefined]];
  expect(new Set(values.map(v => hashArgs([v]))).size).toBe(values.length);
  expect(hashArgs([{a: 1, b: 2}])).toBe(hashArgs([{b: 2, a: 1}]));
});
it("rejects unsupported or cyclic inputs instead of silently aliasing them", () => {
  const cycle: any = {}; cycle.self = cycle;
  for (const value of [cycle, new Map(), new Set(), () => 1, Symbol("x")]) {
    expect(() => hashArgs([value])).toThrow(/keyGenerator/);
  }
});
it("matches every key with a stateful regex without mutating caller state", () => {
  const pattern = /^item/g; pattern.lastIndex = 2;
  expect(filterByPattern(["item1", "item2", "item3"], pattern)).toEqual(["item1", "item2", "item3"]);
  expect(pattern.lastIndex).toBe(2);
});

import { isExpired, getRemainingTTL } from "../src/strategies/ttl-manager.js";
it("treats an expiration timestamp of zero as expired", () => {
  const entry = {key: "epoch", value: 1, createdAt: 0, expiresAt: 0, hits: 0, lastAccess: 0};
  expect(isExpired(entry)).toBe(true);
  expect(getRemainingTTL(entry)).toBe(0);
});
