import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_JSON_VALUES, snapshotPlainData } from "../src/canonical.js";
import { canonicalDigest, canonicalJson, sha256Hex } from "../src/index.js";

describe("canonical JSON", () => {
  it("sorts keys by code unit at every depth and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined }, B: true, é: "x" })).toBe(
      '{"B":true,"a":{"d":[{"y":2,"z":1}]},"b":1,"é":"x"}'
    );
  });

  it("orders integer-like keys by code unit like every other key (RFC 8785)", () => {
    expect(canonicalJson({ b: 1, "10": 2, "9": 3, $ref: 4 })).toBe('{"$ref":4,"10":2,"9":3,"b":1}');
    expect(canonicalDigest({ b: 1, "10": 2, "9": 3 })).toBe(`sha256:${createHash("sha256").update('{"10":2,"9":3,"b":1}').digest("hex")}`);
  });

  it("keeps an own __proto__ key so distinct inputs never share a digest", () => {
    const withProto = JSON.parse('{"__proto__":{"a":1},"b":2}');
    expect(canonicalJson(withProto)).toBe('{"__proto__":{"a":1},"b":2}');
    expect(canonicalDigest(withProto)).not.toBe(canonicalDigest({ b: 2 }));
    expect(canonicalJson(Object.assign(Object.create(null), { z: 1, a: 2 }))).toBe('{"a":2,"z":1}');
  });

  it("rejects values JSON cannot represent instead of silently changing them", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite number at \/value/);
    expect(() => canonicalJson({ when: new Date(0) })).toThrow(/non-plain object at \/when/);
    expect(() => canonicalJson({ big: 1n })).toThrow(/bigint at \/big/);
  });

  it("rejects sparse array holes rather than emitting invalid JSON or the empty array's digest", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(() => canonicalJson({ list: [1, , 3] })).toThrow(/sparse array hole at \/list\/1/);
    expect(() => canonicalJson(new Array(1))).toThrow(/sparse array hole at \/0/);
    expect(() => canonicalJson([1, undefined])).toThrow(/undefined at \/1/);
    expect(canonicalJson([])).toBe("[]");
  });

  it("reads an array's length once, so an element getter that grows the array cannot extend the walk", () => {
    const list: unknown[] = [];
    let reads = 0;
    // Each read appends another such getter; stopped at 100 so a walk that rereads the length still ends.
    const grow = (index: number) =>
      Object.defineProperty(list, index, {
        enumerable: true,
        get() {
          reads += 1;
          if (reads < 100) grow(list.length);
          return "a";
        },
      });
    grow(0);
    expect(canonicalJson(list)).toBe('["a"]');
    expect(reads).toBe(1);
  });

  it("rejects lone surrogates in values and member names, and keeps surrogate pairs", () => {
    expect(() => canonicalJson({ a: "x\ud800" })).toThrow(/lone surrogate\) in a string at \/a/);
    expect(() => canonicalJson({ a: ["\udc00x"] })).toThrow(/in a string at \/a\/0/);
    expect(() => canonicalJson({ nested: { "\ud800": 1 } })).toThrow(/in a member name at \/nested$/);
    expect(() => canonicalDigest("\udfff\ud800")).toThrow(/lone surrogate/);
    expect(canonicalJson({ "🚀": "契約 🚀" })).toBe('{"🚀":"契約 🚀"}');
    expect(canonicalDigest("🚀")).toBe(`sha256:${createHash("sha256").update('"🚀"').digest("hex")}`);
  });
});

describe("sha256Hex", () => {
  it.each([
    ["empty", ""],
    ["abc", "abc"],
    ["two blocks", "a".repeat(64)],
    ["padding boundary", "b".repeat(55)],
    ["padding boundary + 1", "c".repeat(56)],
    ["unicode", "ApiFn – 契約 ✓ 🚀"],
    ["large", "0123456789abcdef".repeat(4096)],
  ])("matches node:crypto for %s input", (_name, input) => {
    expect(sha256Hex(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex"));
  });

  it("digests canonical JSON so key order never changes identity", () => {
    expect(canonicalDigest({ a: 1, b: [1, 2] })).toBe(canonicalDigest({ b: [1, 2], a: 1 }));
    expect(canonicalDigest({ a: 1, b: [1, 2] })).not.toBe(canonicalDigest({ a: 1, b: [2, 1] }));
    expect(canonicalDigest({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("snapshot value limit", () => {
  // Each array item is one value: the array counts it once, before reading it, and its copy does not count it again.
  it.each<[string, number, boolean]>([
    ["primitives", MAX_JSON_VALUES - 1, true],
    ["primitives", MAX_JSON_VALUES, false],
    ["empty objects", MAX_JSON_VALUES - 1, true],
    ["empty objects", MAX_JSON_VALUES, false],
  ])("an array of %s with %i items is accepted: %s", (kind, length, accepted) => {
    const snapshot = snapshotPlainData(Array.from({ length }, () => (kind === "primitives" ? 0 : {})));
    expect(snapshot.problems).toEqual(accepted ? [] : [{ pointer: "", reason: `exceeds ${MAX_JSON_VALUES} values`, limit: true }]);
  });
});
