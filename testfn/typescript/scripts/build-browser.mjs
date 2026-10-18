import { build } from "esbuild";
import { transformAsync } from "@babel/core";
import presetEnv from "@babel/preset-env";
import { parse } from "acorn";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["scripts/browser-entry.mjs"],
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
  globalName: "TestFnBrowser",
  alias: { "fake-indexeddb": fileURLToPath(new URL("native-indexeddb.mjs", import.meta.url)) },
  metafile: true,
});
if (Object.keys(bundle.metafile.inputs).some((path) => path.includes("node_modules/fake-indexeddb/"))) {
  throw new Error("The browser distribution must use native IndexedDB");
}
const result = await transformAsync(bundle.outputFiles[0].text, {
  babelrc: false,
  configFile: false,
  presets: [[presetEnv.default ?? presetEnv, { targets: { chrome: "24", firefox: "16", safari: "10", edge: "12" }, modules: false }]],
  comments: false,
  compact: true,
});
if (!result?.code) throw new Error("Browser transformation produced no code");
parse(result.code, { ecmaVersion: 5 });
await mkdir(new URL("../dist/browser/", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/browser/indexeddb.js", import.meta.url), result.code + "\n");
const require = createRequire(import.meta.url);
const licenses = await Promise.all(["core-js", "@babel/core", "esbuild"].map(async (name) => {
  const directory = dirname(require.resolve(name + "/package.json"));
  return name + "\n" + await readFile(join(directory, "LICENSE"), "utf8").catch(() => readFile(join(directory, "LICENSE.md"), "utf8"));
}));
await writeFile(new URL("../dist/browser/LICENSES.txt", import.meta.url), licenses.join("\n\n"));
console.log("Native IndexedDB browser bundle emitted and parsed as ES5");
