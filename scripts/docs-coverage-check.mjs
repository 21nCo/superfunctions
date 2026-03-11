#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/docs-coverage-check.mjs <docs-root>");
  process.exit(1);
}

const docsRoot = path.resolve(target);
const contentRoot = path.join(docsRoot, "content", "docs");

const requiredFiles = [
  "meta.json",
  "architecture.mdx",
  "reference/client.mdx",
  "reference/server.mdx",
  "reference/adapters/memory.mdx",
  "reference/adapters/indexeddb.mdx",
  "reference/adapters/postgres.mdx",
  "reference/adapters/meilisearch.mdx",
  "reference/adapters/elastic-opensearch.mdx",
  "integrations/datafn.mdx",
  "operations/setup.mdx",
  "operations/security.mdx",
  "operations/observability.mdx",
  "operations/troubleshooting.mdx",
];

let failed = false;

function assertFile(relativePath) {
  const fullPath = path.join(contentRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    console.error(`[FAIL] Missing file: ${relativePath}`);
    failed = true;
    return;
  }
  console.log(`[PASS] File exists: ${relativePath}`);
}

for (const file of requiredFiles) {
  assertFile(file);
}

function read(relativePath) {
  return fs.readFileSync(path.join(contentRoot, relativePath), "utf8");
}

function assertContainsAny(relativePath, expectedTokens) {
  const text = read(relativePath);
  const missing = expectedTokens.filter((token) => !text.includes(token));
  if (missing.length > 0) {
    console.error(`[FAIL] ${relativePath} missing tokens: ${missing.join(", ")}`);
    failed = true;
    return;
  }
  console.log(`[PASS] ${relativePath} contains required tokens`);
}

assertContainsAny("reference/adapters/postgres.mdx", ["Configuration matrix", "retries", "timeout"]);
assertContainsAny("reference/adapters/meilisearch.mdx", ["Configuration matrix", "retries", "timeout", "redacted"]);
assertContainsAny("reference/adapters/elastic-opensearch.mdx", ["Elasticsearch", "OpenSearch", "Configuration matrix", "retries", "timeout"]);
assertContainsAny("operations/security.mdx", ["redaction", "FORBIDDEN"]);
assertContainsAny("operations/troubleshooting.mdx", ["DFQL_INVALID", "LIMIT_EXCEEDED", "DFQL_ABORTED", "DFQL_UNSUPPORTED", "FORBIDDEN", "INTERNAL"]);

const mdxFiles = [];
function collectMdx(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMdx(full);
    } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
      mdxFiles.push(full);
    }
  }
}
collectMdx(contentRoot);

const fencePattern = /```(?:ts|tsx|typescript)\n([\s\S]*?)```/g;
for (const file of mdxFiles) {
  const content = fs.readFileSync(file, "utf8");
  let match;
  while ((match = fencePattern.exec(content)) !== null) {
    const code = match[1];
    const transpile = ts.transpileModule(code, {
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    });
    const diagnostics = transpile.diagnostics ?? [];
    if (diagnostics.length > 0) {
      console.error(`[FAIL] TS snippet diagnostics in ${path.relative(docsRoot, file)}`);
      for (const diag of diagnostics) {
        console.error(`  - ${ts.flattenDiagnosticMessageText(diag.messageText, "\n")}`);
      }
      failed = true;
    }
  }
}

if (failed) {
  console.error("Docs coverage check failed");
  process.exit(1);
}

console.log("Docs coverage check passed");
