/**
 * Array parameters are encoded by the adapter, so injected drivers only bind strings and numbers.
 * The encoding must stay byte-identical to what pg sends for a JavaScript array.
 */
import { describe, expect, it } from "vitest";
import pgUtils from "pg/lib/utils.js";
import { textArrayParam } from "../src/postgres-schema";
import { buildSearchQuery } from "../src/postgres-sql";

const samples: string[][] = [
  [],
  ["title"],
  ["title", "body"],
  [""],
  ['quote"d', "back\\slash", "comma,brace{}", "NULL", "space d", "ünï 🔎", "new\nline"],
];

describe("textArrayParam", () => {
  it.each(samples.map((sample) => [JSON.stringify(sample), sample] as const))("matches pg's encoding of %s", (_label, sample) => {
    expect(textArrayParam(sample)).toBe(pgUtils.prepareValue(sample));
  });

  it("binds the search field filter as a string, not an array", () => {
    const { values } = buildSearchQuery("notes", "q", { fields: ["title", 'a"b'], limit: 5 });
    expect(values).toEqual(["q", '{"title","a\\"b"}', 5]);
    expect(values.every((value) => typeof value === "string" || typeof value === "number")).toBe(true);
  });
});
