import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalDigest, canonicalJson, sha256Hex } from "../src/index.js";

describe("canonical JSON", () => {
  it("sorts keys by code unit at every depth and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: undefined }, B: true, é: "x" })).toBe(
      '{"B":true,"a":{"d":[{"y":2,"z":1}]},"b":1,"é":"x"}'
    );
  });

  it("rejects values JSON cannot represent instead of silently changing them", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite number at \/value/);
    expect(() => canonicalJson({ when: new Date(0) })).toThrow(/non-plain object at \/when/);
    expect(() => canonicalJson({ big: 1n })).toThrow(/bigint at \/big/);
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
