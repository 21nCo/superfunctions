import { existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const nodeBuiltins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

async function bundleForBrowser(entry: string) {
  const result = await build({
    absWorkingDir: packageDir,
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const metafile = result.metafile as Metafile;
  const imports = Object.values(metafile.inputs).flatMap((input) => input.imports.map((item) => item.path));
  return { text: result.outputFiles.map((file) => file.text).join("\n"), inputs: Object.keys(metafile.inputs), imports };
}

describe("browser bundles", () => {
  it.each(["src/browser.ts", "src/index.ts", "dist/browser.js", "dist/index.js"])(
    "%s bundles for the browser without Node modules",
    async (entry) => {
      if (entry.startsWith("dist/") && !existsSync(`${packageDir}/${entry}`)) {
        throw new Error(`${entry} is missing; run the package build before its tests`);
      }
      const bundle = await bundleForBrowser(entry);
      expect(bundle.imports.filter((path) => nodeBuiltins.has(path))).toEqual([]);
      expect(bundle.inputs.every((path) => path.startsWith("src/") || path.startsWith("dist/"))).toBe(true);
      expect(bundle.text).not.toMatch(/\brequire\(/);
    }
  );

  it.each(["src/browser.ts", "dist/browser.js"])("%s excludes server process handlers", async (entry) => {
    const bundle = await bundleForBrowser(entry);
    expect(bundle.text).not.toContain("registerProcessHandlers");
    expect(bundle.text).not.toMatch(/process\.(on|off|exit)\(/);
    expect(bundle.inputs.some((path) => path.includes("server"))).toBe(false);
    expect(bundle.text).toContain("captureBrowserErrors");
  });
});
