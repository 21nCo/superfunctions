#!/usr/bin/env node
// Embeds templates/typescript/runtime.ts into the generator as a string, so the
// runtime stays a type-checked source file while dist needs no file reads.
// `--check` exits 1 when the embedded copy is stale.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "templates/typescript/runtime.ts"), "utf8");
const target = path.join(root, "src/targets/typescript/runtime-source.ts");
const contents = `// Generated from templates/typescript/runtime.ts by scripts/embed-runtime.mjs. Do not edit.\nexport const RUNTIME_SOURCE = ${JSON.stringify(source)};\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== contents) {
    console.error("src/targets/typescript/runtime-source.ts is stale: run node scripts/embed-runtime.mjs");
    process.exit(1);
  }
} else {
  writeFileSync(target, contents);
}
