#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const forbiddenImplementationFiles = [
  "searchfn/adapters/src/postgres-sql.ts",
  "searchfn/adapters/src/postgres-schema.ts",
  "searchfn/adapters/src/meili-client.ts",
  "searchfn/adapters/src/elastic-client.ts",
  "searchfn/adapters/src/internal/errors.ts",
  "searchfn/adapters/src/internal/retry.ts",
];

const allowedCompatTestFiles = new Set([
  "conformance/legacy-guard.test.ts",
]);

function fail(message, details = {}) {
  console.error(
    JSON.stringify({
      ok: false,
      error: { code: "SEARCHFN_CANONICAL_SOURCE_NOT_ENFORCED", message, details },
    })
  );
  process.exit(1);
}

for (const relPath of forbiddenImplementationFiles) {
  if (existsSync(path.join(repoRoot, relPath))) {
    fail("non-canonical implementation file still exists", { file: relPath });
  }
}

const compatTestRoot = path.join(repoRoot, "searchfn/adapters/__tests__");
if (existsSync(compatTestRoot)) {
  const stack = [compatTestRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    for (const entry of readdirSync(current)) {
      const abs = path.join(current, entry);
      const info = statSync(abs);
      if (info.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.endsWith(".ts")) {
        continue;
      }
      const rel = path.relative(compatTestRoot, abs).replaceAll("\\", "/");
      if (!allowedCompatTestFiles.has(rel)) {
        fail("non-canonical compatibility tests remain", { file: `searchfn/adapters/__tests__/${rel}` });
      }
    }
  }
}

const compatSourceChecks = [
  "searchfn/adapters/src/memory.ts",
  "searchfn/adapters/src/indexeddb.ts",
  "searchfn/adapters/src/postgres.ts",
  "searchfn/adapters/src/meilisearch.ts",
  "searchfn/adapters/src/elasticsearch.ts",
  "searchfn/adapters/src/opensearch.ts",
  "searchfn/adapters/src/types.ts",
];

for (const relPath of compatSourceChecks) {
  const absPath = path.join(repoRoot, relPath);
  if (!existsSync(absPath)) {
    fail("compat source wrapper missing", { file: relPath });
  }
  const content = readFileSync(absPath, "utf8");
  if (!content.includes("@searchfn/adapter-") && !content.includes("@searchfn/adapter-contracts")) {
    fail("compat source is not delegating to canonical packages", { file: relPath });
  }
}

console.log(JSON.stringify({ ok: true }));
