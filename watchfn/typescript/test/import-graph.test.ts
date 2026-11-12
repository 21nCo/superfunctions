import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Reads the built package (turbo runs `build` before `test`), because the
// shipped files decide what a consumer's import pulls in.
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(packageDir, "dist");
const FRAMEWORKS = /^(express|fastify|hono|next|@sveltejs\/kit|@superfunctions\/http-(express|fastify|hono|next|sveltekit))(\/|$)/;

// esbuild prints module specifiers as double-quoted strings in these four forms.
const SPECIFIER = /\bfrom\s*"([^"\n]+)"\s*;|\bimport\s*"([^"\n]+)"\s*;|\bimport\(\s*"([^"\n]+)"\s*\)|\brequire\(\s*"([^"\n]+)"\s*\)/g;

/** Every file reachable from an entry through relative imports, and the bare specifiers they import. */
function closure(entry: string): { files: string[]; bare: string[] } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
      const specifier = match.slice(1).find((group) => group !== undefined)!;
      if (specifier.startsWith(".")) visit(path.resolve(path.dirname(file), specifier));
      else bare.add(specifier);
    }
  };
  visit(path.join(dist, entry));
  return { files: [...files].map((file) => path.relative(dist, file)).sort(), bare: [...bare].sort() };
}

describe("package entry points", () => {
  it("builds every exported entry for ESM and CommonJS", () => {
    for (const entry of ["index", "sqlite", "collectors"]) {
      for (const suffix of [".js", ".cjs", ".d.ts", ".d.cts"]) expect(existsSync(path.join(dist, entry + suffix)), `${entry}${suffix}`).toBe(true);
    }
    // @superfunctions/http is ESM only, so the HTTP routes have no CommonJS build.
    expect(existsSync(path.join(dist, "http.js"))).toBe(true);
    expect(existsSync(path.join(dist, "http.d.ts"))).toBe(true);
    expect(existsSync(path.join(dist, "http.cjs"))).toBe(false);
  });

  it.each(["index.js", "index.cjs"])("keeps the minimal entry %s free of frameworks, HTTP, database and driver imports", (entry) => {
    const { bare, files } = closure(entry);
    // esbuild drops the `node:` prefix; either way it is the Node built-in.
    expect(bare).toEqual(["crypto"]);
    expect(files.some((file) => /^(http|sqlite|collectors)\./.test(file))).toBe(false);
  });

  it.each([
    ["sqlite.js", []],
    ["sqlite.cjs", []],
    ["http.js", ["@superfunctions/http"]],
    ["collectors.js", []],
  ])("limits %s to its declared dependencies", (entry, expected) => {
    const { bare } = closure(entry);
    expect(bare).toEqual(expected);
    expect(bare.some((specifier) => FRAMEWORKS.test(specifier))).toBe(false);
  });

  it("ships no source-checkout fallbacks", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
    const targets = JSON.stringify(manifest.exports);
    expect(targets).not.toMatch(/\.\/src\/|(?<!\.d)\.c?ts"/);
    expect(manifest.files).toEqual(["dist", "README.md"]);
    for (const entry of ["index.js", "index.cjs", "sqlite.js", "http.js", "collectors.js"]) {
      for (const file of closure(entry).files) {
        const source = readFileSync(path.join(dist, file), "utf8");
        expect(source, file).not.toMatch(/\.\.\/\.\.\/packages|\/src\/[\w/-]+\.ts["']/);
      }
    }
  });

  it("loads only its own files when CommonJS requires the minimal entry", () => {
    const script = `
      const before = new Set(Object.keys(require.cache));
      const watch = require(${JSON.stringify(path.join(dist, "index.cjs"))});
      if (typeof watch.createWatch !== "function") throw new Error("createWatch missing");
      console.log(JSON.stringify(Object.keys(require.cache).filter((file) => !before.has(file))));
    `;
    const loaded: string[] = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
    expect(loaded.map((file) => path.relative(dist, file))).toEqual(["index.cjs"]);
  });
});
