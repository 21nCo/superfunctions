#!/usr/bin/env node
// Embeds the runtime templates (templates/typescript/runtime.ts, templates/python/runtime.py) into the
// generator as strings, so each runtime stays a type-checked source file while dist needs no file reads.
// `--check` exits 1 when an embedded copy is stale.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimes = [
  { template: "templates/typescript/runtime.ts", target: "src/targets/typescript/runtime-source.ts", name: "RUNTIME_SOURCE" },
  { template: "templates/python/runtime.py", target: "src/targets/python/runtime-source.ts", name: "PYTHON_RUNTIME_SOURCE" },
];
let stale = false;
for (const { template, target, name } of runtimes) {
  const source = readFileSync(path.join(root, template), "utf8");
  const contents = `// Generated from ${template} by scripts/embed-runtime.mjs. Do not edit.\nexport const ${name} = ${JSON.stringify(source)};\n`;
  const file = path.join(root, target);
  if (!process.argv.includes("--check")) writeFileSync(file, contents);
  else if (readFileSync(file, "utf8") !== contents) {
    console.error(`${target} is stale: run node scripts/embed-runtime.mjs`);
    stale = true;
  }
}
if (stale) process.exit(1);
