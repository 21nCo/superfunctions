import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const verifier = fileURLToPath(new URL("../scripts/verify-bundled-zod.mjs", import.meta.url));

it.each(["valid", "foreign", "modified"] as const)("verifies a separate package's bundled Zod provenance: %s", mode => {
  const root = mkdtempSync(join(tmpdir(), "mcpfn-zod-provenance-"));
  const packageRoot = join(root, "auth");
  const zodRoot = join(packageRoot, "node_modules", "zod");
  const content = "export const version = 'fixture';\n";
  const write = (file: string, value: string) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  try {
    write(join(packageRoot, "package.json"), JSON.stringify({ name: "auth-fixture", type: "module" }));
    write(join(zodRoot, "package.json"), JSON.stringify({ name: "zod", version: "4.6.6" }));
    const pinnedSource = join(zodRoot, "v4", "runtime.js");
    write(pinnedSource, content);
    // The foreign copy has identical bytes: only its provenance is wrong.
    const foreignSource = join(root, "node_modules", "zod", "v4", "runtime.js");
    write(foreignSource, content);
    for (const bundle of ["index.js.map", "index.cjs.map"]) {
      const map = join(packageRoot, "dist", bundle);
      const invalid = bundle === "index.cjs.map";
      write(map, JSON.stringify({
        sources: [relative(dirname(map), invalid && mode === "foreign" ? foreignSource : pinnedSource).replaceAll("\\", "/")],
        sourcesContent: [invalid && mode === "modified" ? "export const unexpected = true;\n" : content],
      }));
    }
    const run = () => execFileSync(process.execPath, [verifier, packageRoot], { encoding: "utf8", stdio: "pipe" });
    if (mode === "valid") expect(run()).toContain('"zodVersion":"4.6.6"');
    else expect(run).toThrow(mode === "foreign" ? "foreign Zod source" : "embedded bytes differ");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
