import * as fastUri from "fast-uri";
import { describe, expect, it } from "vitest";
import { parseUriReference, UriTable, type UriKey } from "../src/uri-reference.js";

// RFC 3986 section 5.4: every example resolves against this base.
const RFC_BASE = "http://a/b/c/d;p?q";
const RFC_EXAMPLES: Array<[reference: string, target: string]> = [
  // 5.4.1 normal examples.
  ["g:h", "g:h"],
  ["g", "http://a/b/c/g"],
  ["./g", "http://a/b/c/g"],
  ["g/", "http://a/b/c/g/"],
  ["/g", "http://a/g"],
  ["//g", "http://g"],
  ["?y", "http://a/b/c/d;p?y"],
  ["g?y", "http://a/b/c/g?y"],
  ["#s", "http://a/b/c/d;p?q#s"],
  ["g#s", "http://a/b/c/g#s"],
  ["g?y#s", "http://a/b/c/g?y#s"],
  [";x", "http://a/b/c/;x"],
  ["g;x", "http://a/b/c/g;x"],
  ["g;x?y#s", "http://a/b/c/g;x?y#s"],
  ["", "http://a/b/c/d;p?q"],
  [".", "http://a/b/c/"],
  ["./", "http://a/b/c/"],
  ["..", "http://a/b/"],
  ["../", "http://a/b/"],
  ["../g", "http://a/b/g"],
  ["../..", "http://a/"],
  ["../../", "http://a/"],
  ["../../g", "http://a/g"],
  // 5.4.2 abnormal examples.
  ["../../../g", "http://a/g"],
  ["../../../../g", "http://a/g"],
  ["/./g", "http://a/g"],
  ["/../g", "http://a/g"],
  ["g.", "http://a/b/c/g."],
  [".g", "http://a/b/c/.g"],
  ["g..", "http://a/b/c/g.."],
  ["..g", "http://a/b/c/..g"],
  ["./../g", "http://a/b/g"],
  ["./g/.", "http://a/b/c/g/"],
  ["g/./h", "http://a/b/c/g/h"],
  ["g/../h", "http://a/b/c/h"],
  ["g;x=1/./y", "http://a/b/c/g;x=1/y"],
  ["g;x=1/../y", "http://a/b/c/y"],
  ["g?y/./x", "http://a/b/c/g?y/./x"],
  ["g?y/../x", "http://a/b/c/g?y/../x"],
  ["g#s/./x", "http://a/b/c/g#s/./x"],
  ["g#s/../x", "http://a/b/c/g#s/../x"],
  ["http:g", "http:g"],
];

// Section 5.2.4 on rootless paths and section 5.2.3 merges under rootless, authority-less and relative bases: a ".."
// that removes the first segment of a rootless path keeps the "/" before the next one ("a/../b" is "/b").
const ROOTLESS_EXAMPLES: Array<[base: string, reference: string, target: string]> = [
  ["schema:a/../b", "", "schema:/b"],
  ["schema:a/..", "", "schema:/"],
  ["schema:a/b/../..", "", "schema:/"],
  ["schema:a/../../b", "", "schema:/b"],
  ["schema:a/./../b/", "", "schema:/b/"],
  ["schema:./a", "", "schema:a"],
  ["schema:../a", "", "schema:a"],
  ["schema:a/./b", "", "schema:a/b"],
  ["schema:a/b/..", "", "schema:a/"],
  ["custom:x/a/b", "../c", "custom:x/c"],
  ["custom:x/a/b", "../../c", "custom:/c"],
  ["custom:x/a/b", "../../../c", "custom:/c"],
  ["custom:x/a/", "../../c", "custom:/c"],
  ["custom:a", "b", "custom:b"],
  ["custom:a", "../b", "custom:b"],
  ["custom:a/b", "..", "custom:/"],
  ["custom:a/b/", "../..", "custom:/"],
  ["custom:", "a", "custom:a"],
  ["custom:", "../a", "custom:a"],
  ["custom:a/b/c", "/../x", "custom:/x"],
  ["custom:/a", "../b", "custom:/b"],
  ["//h", "a", "//h/a"],
  ["//h", "../a", "//h/a"],
  ["a/b", "../../c", "/c"],
  ["a/b", "../c", "/c"],
  ["a/b/c", "../d", "a/d"],
  // The rootless URIs the rows above must not meet.
  ["schema:b", "", "schema:b"],
  ["schema:b/", "", "schema:b/"],
  ["schema:", "", "schema:"],
  ["custom:c", "", "custom:c"],
  ["custom:x/c", "", "custom:x/c"],
  ["c", "", "c"],
];

const ROWS: Array<[base: string, reference: string, target: string]> = [...RFC_EXAMPLES.map(([reference, target]): [string, string, string] => [RFC_BASE, reference, target]), ...ROOTLESS_EXAMPLES];

const withoutFragment = (uri: string) => uri.replace(/#.*$/s, "");

describe("RFC 3986 reference resolution", () => {
  const table = new UriTable();
  const parse = (text: string) => parseUriReference(text) ?? expect.unreachable(`not a URI-reference: ${text}`);
  /** The key of `text` read on its own: the document base adds nothing to a URI or an absolute-path reference. */
  const keyOf = (text: string) => table.resolve(table.document, parse(text));
  const resolved = (base: string, reference: string): UriKey => table.resolve(keyOf(base), parse(reference));

  it.each(ROWS)("the oracle resolves %j + %j to %j", (base, reference, target) => {
    expect(fastUri.resolve(base, reference)).toBe(target);
  });

  it.each(ROWS)("resolves %j + %j to the key of %j", (base, reference, target) => {
    expect(resolved(base, reference).key).toBe(keyOf(withoutFragment(target)).key);
  });

  // Keys are equal exactly when the oracle's targets are: no two different URIs share a key, so "/b" and "b" never meet.
  it("gives one key to each URI the oracle tells apart, across every row", () => {
    const byKey = new Map<string, Set<string>>();
    for (const [base, reference] of ROWS) {
      const key = resolved(base, reference).key;
      byKey.set(key, (byKey.get(key) ?? new Set()).add(withoutFragment(fastUri.resolve(base, reference))));
    }
    expect(Array.from(byKey.values(), (targets) => Array.from(targets)).filter((targets) => targets.length > 1)).toEqual([]);
    expect(byKey.size).toBe(new Set(ROWS.map(([base, reference]) => withoutFragment(fastUri.resolve(base, reference)))).size);
  });
});
