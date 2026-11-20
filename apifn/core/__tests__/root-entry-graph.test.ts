import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// `@testfn/core` is an optional peer: only `@apifn/core/testfn` may import it.
// These checks read the built output, so `turbo run test` builds the package first.
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(packageDir, "dist");

const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function specifiersOf(source: string): string[] {
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) found.add(match[1]!);
  }
  return [...found];
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = path.resolve(path.dirname(fromFile), specifier);
  // A declaration file's "./x.js" names "./x.d.ts" (and "./x.cjs" names "./x.d.cts").
  const declarations = /\.d\.c?ts$/.test(fromFile)
    ? [base.replace(/\.c?js$/, (ext) => (ext === ".cjs" ? ".d.cts" : ".d.ts")), `${base}.d.ts`, `${base}.d.cts`]
    : [];
  for (const candidate of [...declarations, base, `${base}.js`, `${base}.cjs`, `${base}.mjs`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${path.relative(packageDir, fromFile)} imports ${specifier}, which is not in dist`);
}

/** Every file reachable from `entry` through relative imports, and the bare specifiers they import. */
function walk(entry: string): { files: string[]; external: Set<string> } {
  const entryFile = path.join(distDir, entry);
  if (!existsSync(entryFile)) {
    throw new Error(`${path.relative(packageDir, entryFile)} is missing: run the package build first`);
  }
  const seen = new Set<string>();
  const external = new Set<string>();
  const pending = [entryFile];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) pending.push(resolveRelative(file, specifier));
      else external.add(specifier);
    }
  }
  return { files: [...seen].map((file) => path.relative(distDir, file)).sort(), external };
}

const importsTestfn = (external: Set<string>) =>
  [...external].filter((specifier) => specifier === "@testfn/core" || specifier.startsWith("@testfn/core/"));

describe("root entry import graph", () => {
  it.each(["index.js", "index.cjs", "index.d.ts", "index.d.cts"])(
    "dist/%s reaches no @testfn/core specifier",
    (entry) => {
      const { files, external } = walk(entry);
      expect(files).toContain(entry);
      // The root still imports its real runtime dependencies, so the walk is not empty.
      if (!entry.includes(".d.")) expect(external).toContain("zod-to-json-schema");
      expect(importsTestfn(external)).toEqual([]);
    },
  );

  it.each(["testfn.js", "testfn.cjs", "testfn.d.ts"])("dist/%s imports @testfn/core", (entry) => {
    expect(importsTestfn(walk(entry).external)).toEqual(["@testfn/core"]);
  });

  it("the root entry no longer exports ApifnTestAdapter", async () => {
    const root = await import(pathToFileURL(path.join(distDir, "index.js")).href);
    expect(root).not.toHaveProperty("ApifnTestAdapter");
    expect(root).toHaveProperty("generateOpenAPI");
  });
});
