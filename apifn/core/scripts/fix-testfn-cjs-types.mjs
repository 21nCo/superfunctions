#!/usr/bin/env node
// Runs after tsup. @testfn/core is ESM-only (type: module, no "require" condition), so the plain
// `import { … } from '@testfn/core'` that tsup writes into dist/testfn.d.cts fails with TS1479 in a
// CommonJS TypeScript consumer (module node16/nodenext). The CommonJS declarations only need
// @testfn/core's types, so they import them as types with resolution-mode "import" (TypeScript 5.3+).
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/testfn.d.cts");
const source = readFileSync(file, "utf8");
const IMPORT = /^import\s+(?:type\s+)?(\{[^}]*\})\s+from\s+(['"])@testfn\/core\2;?$/gm;

let rewritten = 0;
const output = source.replace(IMPORT, (_line, names) => {
  rewritten += 1;
  return `import type ${names} from '@testfn/core' with { 'resolution-mode': 'import' };`;
});

// Any other reference to @testfn/core would still resolve through "require" and fail the same way.
const unresolved = output
  .split("\n")
  .filter((line) => line.includes("@testfn/core") && !line.includes("'resolution-mode': 'import'"));
if (rewritten === 0 || unresolved.length > 0) {
  throw new Error(
    `dist/testfn.d.cts: expected only named imports from @testfn/core to rewrite, found ${rewritten} and left:\n${unresolved.join("\n")}`,
  );
}
writeFileSync(file, output);
console.log(`dist/testfn.d.cts: ${rewritten} @testfn/core import(s) now use resolution-mode "import"`);
