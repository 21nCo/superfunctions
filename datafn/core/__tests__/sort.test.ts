/**
 * Sort utilities tests
 * Tests TV-SRT-001, TV-SRT-002 from TEST_VECTORS.md
 */

import { describe, it, expect } from "vitest";
import {
  compareIds,
  compareRecords,
  compareSortValues,
  parseSortTerms,
  sortRecords,
} from "../src/sort.js";

describe("parseSortTerms (TV-SRT-001)", () => {
  it("bare field → asc", () => expect(parseSortTerms(["name"])).toEqual([{ field: "name", direction: "asc" }]));
  it("field:asc", () => expect(parseSortTerms(["name:asc"])).toEqual([{ field: "name", direction: "asc" }]));
  it("field:desc", () => expect(parseSortTerms(["name:desc"])).toEqual([{ field: "name", direction: "desc" }]));
  it("-field → desc", () => expect(parseSortTerms(["-createdAt"])).toEqual([{ field: "createdAt", direction: "desc" }]));
  it("structured sort term", () => expect(parseSortTerms([{ field: "updatedAt", direction: "desc" }])).toEqual([{ field: "updatedAt", direction: "desc" }]));
  it("multiple terms", () => expect(parseSortTerms(["-createdAt", "name"])).toEqual([
    { field: "createdAt", direction: "desc" },
    { field: "name", direction: "asc" },
  ]));
  it("undefined → []", () => expect(parseSortTerms(undefined)).toEqual([]));
  it("[] → []", () => expect(parseSortTerms([])).toEqual([]));
  it("rejects invalid directions", () => expect(() => parseSortTerms(["name:sideways"])).toThrow());
  it("rejects malformed structured terms", () => {
    expect(() => parseSortTerms([{ direction: "asc" } as never])).toThrow("Invalid sort field");
  });
  it("rejects an explicit null structured direction", () => {
    expect(() => parseSortTerms([{ field: "name", direction: null } as never])).toThrow(
      'Invalid sort direction "null"',
    );
  });
});

describe("sortRecords (TV-SRT-002)", () => {
  const records = [
    { id: "3", name: "Charlie", age: 30 },
    { id: "1", name: "Alice", age: 30 },
    { id: "2", name: "Bob", age: 25 },
  ];

  it("sorts by field asc with id tie-breaker", () => {
    const sorted = sortRecords(records, parseSortTerms(["age:asc"]));
    expect(sorted[0].id).toBe("2"); // Bob, age 25
    expect(sorted[1].id).toBe("1"); // Alice, age 30 (id tie-breaker)
    expect(sorted[2].id).toBe("3"); // Charlie, age 30
  });

  it("sorts descending", () => {
    const sorted = sortRecords(records, parseSortTerms(["name:desc"]));
    expect(sorted[0].name).toBe("Charlie");
    expect(sorted[1].name).toBe("Bob");
    expect(sorted[2].name).toBe("Alice");
  });

  it("null values sort after non-null in ascending", () => {
    const recs = [
      { id: "1", score: null },
      { id: "2", score: 5 },
      { id: "3", score: null },
    ];
    const sorted = sortRecords(recs, [{ field: "score", direction: "asc" }]);
    expect(sorted[0].score).toBe(5);
    expect(sorted[1].score).toBeNull();
    expect(sorted[2].score).toBeNull();
  });

  it("empty terms → id tie-breaker only", () => {
    const sorted = sortRecords(records, []);
    expect(sorted[0].id).toBe("1");
    expect(sorted[1].id).toBe("2");
    expect(sorted[2].id).toBe("3");
  });

  it("does not mutate original array", () => {
    const original = [...records];
    sortRecords(records, parseSortTerms(["name:desc"]));
    expect(records).toEqual(original);
  });
});

describe("compareSortValues", () => {
  it("treats null and undefined as equal in both argument orders", () => {
    expect(compareSortValues(null, undefined)).toBe(0);
    expect(compareSortValues(undefined, null)).toBe(0);
  });

  it("puts null and undefined after values in both argument orders", () => {
    expect(compareSortValues(null, 1)).toBeGreaterThan(0);
    expect(compareSortValues(1, null)).toBeLessThan(0);
    expect(compareSortValues(undefined, "a")).toBeGreaterThan(0);
    expect(compareSortValues("a", undefined)).toBeLessThan(0);
  });

  it("compares numbers and numeric strings as numbers", () => {
    expect(compareSortValues("10", "9")).toBeGreaterThan(0);
    expect(compareSortValues("9", "10")).toBeLessThan(0);
    expect(compareSortValues("10", 9)).toBeGreaterThan(0);
    expect(compareSortValues(9, "10")).toBeLessThan(0);
    expect(compareSortValues("9", 9)).toBe(0);
    expect(compareSortValues(9, "9")).toBe(0);
    expect(compareSortValues("-1.5", "2e1")).toBeLessThan(0);
  });

  it("keeps text order for strings that are not numbers", () => {
    expect(compareSortValues("apple", "banana")).toBeLessThan(0);
    // "0x10" is text, not 16, so it sorts after the number 20.
    expect(compareSortValues("0x10", "20")).toBeGreaterThan(0);
    expect(compareSortValues("apple", "Banana")).toBeLessThan(0);
  });

  it("sorts numeric values before every non-numeric value", () => {
    expect(compareSortValues("10", "1a")).toBeLessThan(0);
    expect(compareSortValues("1a", "10")).toBeGreaterThan(0);
    expect(compareSortValues(2, "apple")).toBeLessThan(0);
    expect(compareSortValues("", "0")).toBeGreaterThan(0);
    expect(compareSortValues("0", "")).toBeLessThan(0);
  });

  it("is transitive on a mix of numeric and non-numeric strings", () => {
    const values = ["2", "10", "1a", "15a", "9", 9, "apple", true, "", "-1"];
    for (const a of values) {
      for (const b of values) {
        expect(Math.sign(compareSortValues(a, b)) + Math.sign(compareSortValues(b, a))).toBe(0);
        for (const c of values) {
          if (compareSortValues(a, b) <= 0 && compareSortValues(b, c) <= 0) {
            expect(compareSortValues(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });

  it("gives the same order whatever the input order", () => {
    const orders = [
      ["2", "10", "1a"],
      ["10", "1a", "2"],
      ["1a", "2", "10"],
    ];
    for (const order of orders) {
      const records = order.map((title) => ({ id: title, title }));
      expect(
        sortRecords(records, [{ field: "title", direction: "asc" }]).map((r) => r.title),
      ).toEqual(["2", "10", "1a"]);
    }
  });
});

describe("id tie-break", () => {
  it("uses plain code-unit order", () => {
    expect(compareIds("B", "a")).toBeLessThan(0);
    expect(compareIds("a", "B")).toBeGreaterThan(0);
    expect(compareIds("task:10", "task:9")).toBeLessThan(0);
    expect(compareIds("x", "x")).toBe(0);
  });

  it("orders ties by code unit, not locale", () => {
    const records = [
      { id: "b", rank: 1 },
      { id: "B", rank: 1 },
      { id: "a", rank: 1 },
      { id: "A", rank: 1 },
    ];
    expect(sortRecords(records, [{ field: "rank", direction: "asc" }]).map((r) => r.id)).toEqual([
      "A",
      "B",
      "a",
      "b",
    ]);
    expect(sortRecords(records, []).map((r) => r.id)).toEqual(["A", "B", "a", "b"]);
  });

  it("uses code-unit order for an explicit id sort term", () => {
    const records = [{ id: "9" }, { id: "10" }, { id: "a" }, { id: "B" }];
    expect(sortRecords(records, [{ field: "id", direction: "asc" }]).map((r) => r.id)).toEqual([
      "10",
      "9",
      "B",
      "a",
    ]);
    expect(sortRecords(records, [{ field: "id", direction: "desc" }]).map((r) => r.id)).toEqual([
      "a",
      "B",
      "9",
      "10",
    ]);
  });
});

describe("sortRecords with mixed values", () => {
  it("sorts null and undefined together after values, symmetrically", () => {
    const recs = [
      { id: "1", score: undefined },
      { id: "2", score: null },
      { id: "3", score: 2 },
      { id: "4", score: undefined },
      { id: "5", score: null },
    ];
    const asc = sortRecords(recs, [{ field: "score", direction: "asc" }]).map((r) => r.id);
    expect(asc).toEqual(["3", "1", "2", "4", "5"]);
    const reversedInput = sortRecords([...recs].reverse(), [{ field: "score", direction: "asc" }]).map((r) => r.id);
    expect(reversedInput).toEqual(asc);
    const desc = sortRecords(recs, [{ field: "score", direction: "desc" }]).map((r) => r.id);
    expect(desc).toEqual(["1", "2", "4", "5", "3"]);
  });

  it("sorts \"10\", \"9\" and 9 numerically", () => {
    const recs = [
      { id: "a", n: "10" },
      { id: "b", n: "9" },
      { id: "c", n: 9 },
      { id: "d", n: 100 },
    ];
    expect(sortRecords(recs, [{ field: "n", direction: "asc" }]).map((r) => r.id)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
    expect(sortRecords(recs, [{ field: "n", direction: "desc" }]).map((r) => r.id)).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
  });

  it("compareRecords matches sortRecords", () => {
    const recs = [
      { id: "2", n: "10" },
      { id: "1", n: null },
      { id: "3", n: 9 },
    ];
    const terms = [{ field: "n", direction: "asc" as const }];
    expect([...recs].sort((a, b) => compareRecords(a, b, terms))).toEqual(sortRecords(recs, terms));
  });
});

describe("compareSortValues numeric edge cases (DATA-15)", () => {
  it("parses every decimal form as a number", () => {
    for (const [text, value] of [["1.", 1], [".5", 0.5], ["1e3", 1000], ["-1.5e-2", -0.015], ["+7", 7]] as const) {
      expect(compareSortValues(text, value)).toBe(0);
    }
    for (const text of ["1.2.3", "e5", ".", "1e", "--1", "0x10"]) {
      expect(compareSortValues(text, 1)).toBe(1);
    }
  });

  it("sorts infinite numbers at the ends of the numbers", () => {
    const values = [Infinity, "abc", 5, -Infinity, "10", null];
    expect([...values].sort(compareSortValues)).toEqual([-Infinity, 5, "10", Infinity, "abc", null]);
  });

  it("rejects a long malformed digit run in linear time", () => {
    const malformed = `0${"00".repeat(50_000)}x`;
    const start = performance.now();
    expect(compareSortValues(malformed, 1)).toBe(1);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
