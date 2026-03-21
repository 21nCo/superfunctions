#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const docsfnRoot = resolve(scriptDir, "..");
const repoRoot = resolve(docsfnRoot, "..");
const fixturesRoot = resolve(docsfnRoot, "test-fixtures", "repo");
const tempRoot = resolve(docsfnRoot, ".tmp", "migration-check");
const cliPrefix = resolve(docsfnRoot, "cli");
const cliBin = resolve(cliPrefix, "bin", "docsfn.js");

const fixtureSpecs = [
  {
    id: "datafn-docs",
    root: resolve(fixturesRoot, "datafn-docs"),
    title: "DataFn Docs",
    expectedRoutes: ["/docs", "/docs/documentation/server/routes"],
    expectedTopLabels: [
      "DataFn",
      "Documentation",
      "Concepts",
      "Client",
      "Server",
      "Sync",
      "Migrations",
      "Use Cases",
      "Storage",
      "Plugins",
    ],
    requireTabs: true,
    requireMermaid: true,
  },
  {
    id: "searchfn-docs",
    root: resolve(fixturesRoot, "searchfn-docs"),
    title: "SearchFn Docs",
    expectedRoutes: ["/docs", "/docs/reference/client"],
    expectedTopLabels: [
      "SearchFn",
      "Getting Started",
      "Architecture",
      "Reference",
      "Integrations",
      "Operations",
    ],
    requireTabs: false,
    requireMermaid: true,
  },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const env = options.env ?? process.env;

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });

    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${command} ${args.join(" ")} failed with exit code ${String(code)}`)
      );
    });
  });
}

async function walkFiles(root, results = []) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(absolutePath, results);
      continue;
    }
    results.push(absolutePath);
  }
  return results;
}

async function gatherCompatibilitySignals(fixtureRoot) {
  const docsRoot = resolve(fixtureRoot, "content", "docs");
  const files = await walkFiles(docsRoot);
  const markdownFiles = files.filter((filePath) => filePath.endsWith(".md") || filePath.endsWith(".mdx"));
  const controlFiles = files.filter((filePath) => filePath.endsWith("meta.json"));

  let tabsCount = 0;
  let mermaidCount = 0;
  for (const filePath of markdownFiles) {
    const content = await readFile(filePath, "utf8");
    tabsCount += (content.match(/<\s*Tabs\b/g) ?? []).length;
    tabsCount += (content.match(/<\s*Tab\b/g) ?? []).length;
    mermaidCount += (content.match(/```mermaid/g) ?? []).length;
  }

  return {
    controlFiles: controlFiles.length,
    tabsCount,
    mermaidCount,
  };
}

function createFixtureConfig(fixture) {
  return {
    schemaVersion: 1,
    site: {
      title: fixture.title,
      basePath: "/docs",
      canonicalUrl: "https://example.com",
    },
    compat: {
      preset: "fumadocs-v15",
    },
    content: {
      root: fixture.root,
      docsDir: "content/docs",
      pagesDir: "pages",
      blogDir: "blog",
      apiDir: "api",
      assetsDir: "public",
      metaFileName: "meta.json",
    },
    search: {
      enabled: true,
      scopes: ["docs", "api", "blog"],
      bodyIndexing: "summary",
    },
    auth: {
      enabled: false,
      mode: "public",
    },
    analytics: {
      enabled: false,
      provider: "watchfn",
      respectDnt: true,
    },
  };
}

function extractSidebarTopLabels(manifest) {
  const items = manifest.sidebars?.default?.items;
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .filter((item) => item && typeof item === "object" && typeof item.text === "string")
    .map((item) => item.text);
}

async function runFixtureCheck(fixture) {
  const fixtureOutDir = resolve(tempRoot, "out", fixture.id);
  const configPath = resolve(tempRoot, "config", `${fixture.id}.config.mjs`);

  await mkdir(dirname(configPath), { recursive: true });
  await mkdir(fixtureOutDir, { recursive: true });

  const config = createFixtureConfig(fixture);
  await writeFile(configPath, `export default ${JSON.stringify(config, null, 2)};\n`, "utf8");

  await run("node", [
    cliBin,
    "build",
    "--root",
    fixture.root,
    "--config",
    configPath,
    "--out-dir",
    fixtureOutDir,
  ]);

  const diagnostics = JSON.parse(await readFile(resolve(fixtureOutDir, "diagnostics.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve(fixtureOutDir, "manifest.json"), "utf8"));
  const compatReport = JSON.parse(await readFile(resolve(fixtureOutDir, "compat-report.json"), "utf8"));
  const compatibilitySignals = await gatherCompatibilitySignals(fixture.root);

  const errorDiagnostics = diagnostics.filter((diagnostic) => diagnostic?.severity === "error");

  assert(errorDiagnostics.length === 0, `${fixture.id}: expected zero error diagnostics`);
  assert(compatReport.preset === "fumadocs-v15", `${fixture.id}: compat preset must be fumadocs-v15`);
  assert(
    Array.isArray(compatReport.unsupportedSyntax) && compatReport.unsupportedSyntax.length === 0,
    `${fixture.id}: unsupported compatibility syntax remains`
  );

  for (const route of fixture.expectedRoutes) {
    assert(manifest.routes?.[route], `${fixture.id}: missing expected route ${route}`);
  }

  const topLabels = extractSidebarTopLabels(manifest);
  const expected = fixture.expectedTopLabels;
  const actualPrefix = topLabels.slice(0, expected.length);
  assert(
    JSON.stringify(actualPrefix) === JSON.stringify(expected),
    `${fixture.id}: sidebar top-level labels mismatch (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actualPrefix)})`
  );

  assert(compatibilitySignals.controlFiles > 0, `${fixture.id}: no meta.json control files found`);
  if (fixture.requireTabs) {
    assert(compatibilitySignals.tabsCount > 0, `${fixture.id}: expected Tabs/Tab compatibility syntax in fixture`);
  }
  if (fixture.requireMermaid) {
    assert(compatibilitySignals.mermaidCount > 0, `${fixture.id}: expected mermaid fences in fixture`);
  }

  return {
    fixture: fixture.id,
    routes: fixture.expectedRoutes,
    topLabels: actualPrefix,
    compatibilitySignals,
  };
}

async function main() {
  await rm(tempRoot, { recursive: true, force: true });
  await mkdir(tempRoot, { recursive: true });

  console.log("[migration-check] ensuring docsfn CLI is built");
  await run("npm", ["--prefix", cliPrefix, "run", "build"], { cwd: repoRoot });

  const summaries = [];
  for (const fixture of fixtureSpecs) {
    console.log(`[migration-check] checking ${fixture.id}`);
    const summary = await runFixtureCheck(fixture);
    summaries.push(summary);
  }

  console.log("\n[migration-check] parity checks passed for canonical fixtures:");
  for (const summary of summaries) {
    console.log(`- ${summary.fixture}`);
    console.log(`  routes: ${summary.routes.join(", ")}`);
    console.log(`  sidebar labels: ${summary.topLabels.join(" | ")}`);
    console.log(
      `  compatibility signals: meta.json=${summary.compatibilitySignals.controlFiles}, tabs=${summary.compatibilitySignals.tabsCount}, mermaid=${summary.compatibilitySignals.mermaidCount}`
    );
  }
}

main().catch((error) => {
  console.error(`\n[migration-check] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
