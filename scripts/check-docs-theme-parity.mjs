#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const apps = process.argv.slice(2);

if (apps.length === 0) {
  console.error("Usage: node scripts/check-docs-theme-parity.mjs <docs-app> [...docs-app]");
  process.exit(1);
}

const checks = [
  {
    file: path.join("app", "layout.tsx"),
    expected: "@superfunctions/docs-theme",
    message: "layout must import shared docs layout primitives",
  },
  {
    file: path.join("app", "layout.config.tsx"),
    expected: "@superfunctions/docs-theme",
    message: "layout config must import shared docs config helpers",
  },
  {
    file: path.join("app", "global.css"),
    expected: "@superfunctions/docs-theme/tokens.css or packages/docs-theme/src/tokens.css",
    message: "global.css must import shared token stylesheet",
  },
];

let hasError = false;

for (const appPath of apps) {
  for (const check of checks) {
    const filePath = path.join(appPath, check.file);

    if (!fs.existsSync(filePath)) {
      console.error(`[FAIL] ${filePath}: missing file`);
      hasError = true;
      continue;
    }

    const content = fs.readFileSync(filePath, "utf8");
    const hasExpectedTokenImport =
      check.file !== path.join("app", "global.css") ||
      content.includes("@superfunctions/docs-theme/tokens.css") ||
      content.includes("packages/docs-theme/src/tokens.css");

    if ((check.file === path.join("app", "global.css") && !hasExpectedTokenImport) ||
      (check.file !== path.join("app", "global.css") && !content.includes(check.expected))) {
      console.error(`[FAIL] ${filePath}: ${check.message}`);
      hasError = true;
      continue;
    }

    console.log(`[PASS] ${filePath}`);
  }
}

if (hasError) {
  console.error("Docs theme parity failure");
  process.exit(1);
}

console.log("Docs theme parity check passed");
