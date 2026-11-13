// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  CIRCULAR,
  MAX_DEPTH_MARKER,
  MAX_ENTRY_BYTES,
  MAX_KEYS,
  TRUNCATED,
  UNSERIALIZABLE,
  serializeEntry,
  truncateString,
  truncateToBytes,
  utf8Length,
} from "../src/utils/serialization.js";

const bytes = (value: unknown) => utf8Length(JSON.stringify(value));

describe("serialization closed set: one vector per form", () => {
  it("keeps JSON primitives", () => {
    expect(serializeEntry("text")).toBe("text");
    expect(serializeEntry(42.5)).toBe(42.5);
    expect(serializeEntry(true)).toBe(true);
    expect(serializeEntry(null)).toBe(null);
  });

  it("turns an Error into name, message, stack and own properties", () => {
    const error = Object.assign(new TypeError("bad input"), { code: "E_INPUT" });
    const value = serializeEntry(error) as Record<string, unknown>;
    expect(value).toMatchObject({ name: "TypeError", message: "bad input", code: "E_INPUT" });
    expect(value.stack).toContain("bad input");
    const bare = new Error("no stack");
    delete (bare as { stack?: string }).stack;
    expect(serializeEntry(bare)).toEqual({ name: "Error", message: "no stack" });
  });

  it("copies plain objects, null-prototype objects and arrays", () => {
    const bare = Object.assign(Object.create(null), { a: 1 });
    expect(serializeEntry({ a: [1, "two", { three: 3 }], bare })).toEqual({ a: [1, "two", { three: 3 }], bare: { a: 1 } });
  });

  it("caps container depth at five levels", () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { l6: "too deep" } } } } } };
    expect(serializeEntry(deep)).toEqual({ l1: { l2: { l3: { l4: { l5: MAX_DEPTH_MARKER } } } } });
    // The entry itself is level 1; level 5 is the deepest copied container.
    expect(serializeEntry([[[[["five"]]]]])).toEqual([[[[["five"]]]]]);
    expect(serializeEntry([[[[[["six"]]]]]])).toEqual([[[[[MAX_DEPTH_MARKER]]]]]);
    // An argument list at level 0 gives each argument all five levels.
    expect(serializeEntry([[[[[["six"]]]]]], 0)).toEqual([[[[[["six"]]]]]]);
  });

  it(`keeps at most ${MAX_KEYS} keys or items per container`, () => {
    const wide = Object.fromEntries(Array.from({ length: MAX_KEYS + 5 }, (_, index) => [`k${index}`, index]));
    const value = serializeEntry(wide) as Record<string, unknown>;
    expect(Object.keys(value)).toHaveLength(MAX_KEYS + 1);
    expect(value.k199).toBe(199);
    expect(value.k200).toBeUndefined();
    expect(value[TRUNCATED]).toBe("5 more");
    const list = serializeEntry(Array.from({ length: MAX_KEYS + 1 }, (_, index) => index)) as unknown[];
    expect(list).toHaveLength(MAX_KEYS + 1);
    expect(list.at(-2)).toBe(MAX_KEYS - 1);
    expect(list.at(-1)).toBe(TRUNCATED);
  });

  it(`never exceeds ${MAX_ENTRY_BYTES} bytes of UTF-8 JSON per entry`, () => {
    const long = "🙂".repeat(MAX_ENTRY_BYTES);
    const cut = serializeEntry(long) as string;
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(cut.endsWith(TRUNCATED)).toBe(true);
    // The cut never leaves half of a surrogate pair behind.
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);

    const wide = Array.from({ length: 150 }, (_, index) => ({ index, text: "x".repeat(200), nested: { more: "y".repeat(50) } }));
    const value = serializeEntry({ wide }) as { wide: unknown[] };
    expect(bytes(value)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
    expect(value.wide.at(-1)).toBe(TRUNCATED);
    expect(value.wide[0]).toEqual(wide[0]);

    // Escapes count at their encoded size.
    const escaped = serializeEntry("\u0000".repeat(MAX_ENTRY_BYTES));
    expect(bytes(escaped)).toBeLessThanOrEqual(MAX_ENTRY_BYTES);
  });

  it("marks a cycle back to an ancestor as [Circular] and keeps repeated siblings", () => {
    const shared = { value: 1 };
    const cyclic: Record<string, unknown> = { name: "root", a: shared, b: shared };
    cyclic.self = cyclic;
    const error = new Error("loop") as Error & { cause?: unknown };
    error.cause = error;
    expect(serializeEntry(cyclic)).toEqual({ name: "root", a: { value: 1 }, b: { value: 1 }, self: CIRCULAR });
    expect((serializeEntry(error) as Record<string, unknown>).cause).toBe(CIRCULAR);
  });

  it("describes DOM nodes as <tag#id.class>", () => {
    const element = document.createElement("button");
    element.id = "save";
    element.className = "primary  large";
    expect(serializeEntry(element)).toBe("<button#save.primary.large>");
    expect(serializeEntry(document.createElement("div"))).toBe("<div>");
    expect(serializeEntry(document.createElementNS("http://www.w3.org/2000/svg", "svg"))).toBe("<svg>");
    expect(serializeEntry(document.createTextNode("hi"))).toBe("<#text>");
    expect(serializeEntry({ target: element })).toEqual({ target: "<button#save.primary.large>" });
  });

  it("turns everything else into String(value)", () => {
    const date = new Date(0);
    class Point {
      toString() {
        return "Point(1, 2)";
      }
    }
    const fn = function named() {};
    const cases: Array<[unknown, string]> = [
      [undefined, "undefined"],
      [Number.NaN, "NaN"],
      [Number.POSITIVE_INFINITY, "Infinity"],
      [10n, "10"],
      [Symbol("tag"), "Symbol(tag)"],
      [fn, String(fn)],
      [date, String(date)],
      [/a+/g, "/a+/g"],
      [new Map([[1, 2]]), "[object Map]"],
      [new Point(), "Point(1, 2)"],
    ];
    for (const [input, expected] of cases) expect(serializeEntry(input)).toBe(expected);
  });

  it("never throws on hostile values", () => {
    const hostile = {
      get boom() {
        throw new Error("getter");
      },
    };
    const noString = { toString: undefined, valueOf: undefined, __proto__: { constructor: null } };
    const proxy = new Proxy({}, { getPrototypeOf: () => { throw new Error("trap"); } });
    expect(serializeEntry(hostile)).toEqual({ boom: UNSERIALIZABLE });
    expect(serializeEntry(noString)).toBe(UNSERIALIZABLE);
    expect(serializeEntry(proxy)).toBe(UNSERIALIZABLE);
  });

  it("keeps an own __proto__ key as data", () => {
    const input = JSON.parse('{"__proto__":{"polluted":true}}');
    const value = serializeEntry(input) as Record<string, unknown>;
    expect(Object.hasOwn(value, "__proto__")).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });
});

describe("string helpers", () => {
  it("truncateToBytes returns undefined when the marker cannot fit", () => {
    expect(truncateToBytes("abcdef", 3)).toBeUndefined();
    expect(truncateToBytes("short", 100)).toBe("short");
  });

  it("truncateString keeps the port's contract", () => {
    expect(truncateString("Hello", 10)).toBe("Hello");
    expect(truncateString("This is a very long string", 10)).toBe("This is...");
    expect(() => truncateString("x", -1)).toThrow(RangeError);
  });
});
