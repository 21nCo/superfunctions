#!/usr/bin/env node
// Regenerates the Swift token files committed under uifn/swift, or with
// --check fails when any of them differs from the generated output.
//
// Requires built @uifn/tokens and @uifn/theme:
//   npx turbo run build --filter=@uifn/theme
//   node uifn/swift/scripts/generate-tokens.mjs [--check]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { generateSwiftTokens } = require("@uifn/tokens");
const { FIRST_PARTY_THEMES } = require("@uifn/theme");

const swiftRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(swiftRoot, "../..");
const check = process.argv.includes("--check");

const defaultThemeFile = path.join(swiftRoot, "Sources/UIFnSwiftUI/Tokens/UIFnTheme+UIFn.swift");
const defaultTheme = generateSwiftTokens(
  {
    light: FIRST_PARTY_THEMES["uifn-light"],
    dark: FIRST_PARTY_THEMES["uifn-dark"],
    highContrastLight: FIRST_PARTY_THEMES["uifn-high-contrast-light"],
    highContrastDark: FIRST_PARTY_THEMES["uifn-high-contrast-dark"],
  },
  { name: "uifn", regenerateCommand: "node uifn/swift/scripts/generate-tokens.mjs" }
);

let stale = false;
const relative = (file) => path.relative(repoRoot, file);
let current;
try {
  current = readFileSync(defaultThemeFile, "utf8");
} catch {
  current = undefined;
}
if (current === defaultTheme) {
  console.log(`${relative(defaultThemeFile)} is up to date.`);
} else if (check) {
  console.error(`${relative(defaultThemeFile)} is out of date; run node uifn/swift/scripts/generate-tokens.mjs.`);
  stale = true;
} else {
  writeFileSync(defaultThemeFile, defaultTheme);
  console.log(`Wrote ${relative(defaultThemeFile)}.`);
}

// A consumer-supplied light and dark theme, generated through the CLI into the
// test target so the tests prove generated code compiles outside the package.
const fixtures = path.relative(repoRoot, path.join(swiftRoot, "scripts/fixtures"));
const cli = path.join(path.dirname(require.resolve("@uifn/tokens")), "../bin/uifn-swift-tokens.cjs");
const cliArgs = [
  cli,
  "--name", "sample",
  "--light", path.join(fixtures, "sample-light.json"),
  "--dark", path.join(fixtures, "sample-dark.json"),
  "--access", "internal",
  "--import", "UIFnSwiftUI",
  "--out", relative(path.join(swiftRoot, "Tests/UIFnSwiftUITests/Generated/UIFnTheme+Sample.swift")),
  ...(check ? ["--check"] : []),
];
try {
  execFileSync(process.execPath, cliArgs, { cwd: repoRoot, stdio: "inherit" });
} catch {
  stale = true;
}

if (stale) process.exit(1);
