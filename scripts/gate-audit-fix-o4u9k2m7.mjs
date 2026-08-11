#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const repoRoot = process.cwd();

function run(command) {
  try {
    execSync(command, { stdio: "pipe", encoding: "utf8" });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.stdout || error?.message || error) };
  }
}

function fileContains(path, pattern) {
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8").includes(pattern);
}

function collectFiles(paths) {
  const files = [];
  const missing = [];

  function visit(targetPath) {
    const absolutePath = join(repoRoot, targetPath);
    if (!existsSync(absolutePath)) {
      missing.push(targetPath);
      return;
    }

    const stats = statSync(absolutePath);
    if (stats.isDirectory()) {
      for (const entry of readdirSync(absolutePath, { withFileTypes: true })) {
        const nestedRelativePath = join(targetPath, entry.name);
        if (entry.isDirectory()) {
          visit(nestedRelativePath);
          continue;
        }
        if (entry.isFile()) {
          files.push(nestedRelativePath);
        }
      }
      return;
    }

    if (stats.isFile()) {
      files.push(targetPath);
    }
  }

  for (const targetPath of paths) {
    visit(targetPath);
  }

  return { files, missing };
}

function scanForPattern(pattern, paths) {
  const { files, missing } = collectFiles(paths);
  if (files.length === 0) {
    const problemPaths = missing.length > 0 ? missing : paths;
    return {
      ok: false,
      error: `No readable files found for paths: ${problemPaths.join(", ")}`,
    };
  }

  const matches = [];
  for (const targetPath of files) {
    const absolutePath = join(repoRoot, targetPath);
    const content = readFileSync(absolutePath, "utf8");
    const lines = content.split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      pattern.lastIndex = 0;
      if (!pattern.test(line)) {
        continue;
      }
      matches.push({
        path: targetPath,
        line: index + 1,
        preview: line.trim(),
      });
    }
  }

  if (matches.length === 0) {
    return {
      ok: false,
      error: `Pattern ${pattern} not found in ${files.map((file) => relative(repoRoot, join(repoRoot, file))).join(", ")}`,
    };
  }

  return { ok: true };
}

const checklist = [
  {
    package: "authfn",
    requirement: "Adopt shared oauth-flow orchestration",
    command: 'rg -n "@superfunctions/oauth-flow" authfn/ts-sdk/src/social-oauth',
    kind: "pattern",
    pattern: /@superfunctions\/oauth-flow/,
    paths: ["authfn/ts-sdk/src/social-oauth"],
  },
  {
    package: "plugfn",
    requirement: "Adopt shared oauth-flow + persistent state store wiring",
    command:
      'rg -n "@superfunctions/oauth-flow|DEPRECATED_PATH|removal in plugfn@0.2.0" plugfn/core/src/core/connection-manager.ts plugfn/core/src/auth/oauth-flow.ts',
    kind: "pattern",
    pattern: /@superfunctions\/oauth-flow|DEPRECATED_PATH|removal in plugfn@0\.2\.0/,
    paths: [
      "plugfn/core/src/core/connection-manager.ts",
      "plugfn/core/src/auth/oauth-flow.ts",
    ],
  },
  {
    package: "recfn",
    requirement: "Adopt shared oauth/token + extracted reuse packages",
    command:
      'rg -n "@superfunctions/oauth-flow|@superfunctions/webhooks|@superfunctions/envelope|@superfunctions/errors|@superfunctions/queue|@superfunctions/config|@superfunctions/metrics" recfn/server/src',
    kind: "pattern",
    pattern:
      /@superfunctions\/oauth-flow|@superfunctions\/webhooks|@superfunctions\/envelope|@superfunctions\/errors|@superfunctions\/queue|@superfunctions\/config|@superfunctions\/metrics/,
    paths: ["recfn/server/src"],
  },
  {
    package: "cifn",
    requirement: "Adopt extracted webhook/envelope/queue packages",
    command:
      'rg -n "@superfunctions/webhooks|@superfunctions/envelope|@superfunctions/errors|@superfunctions/queue" cifn/typescript/control-plane/src',
    kind: "pattern",
    pattern:
      /@superfunctions\/webhooks|@superfunctions\/envelope|@superfunctions\/errors|@superfunctions\/queue/,
    paths: ["cifn/typescript/control-plane/src"],
  },
  {
    package: "searchfn",
    requirement: "Consolidate adapter duplication with canonical source",
    command: "node scripts/check-searchfn-adapter-canonical.mjs",
    kind: "command",
  },
  {
    package: "packages/storage*",
    requirement: "Deduplicate S3-compatible adapter internals",
    command:
      'rg -n "@superfunctions/storage/internal/s3-compatible" packages/storage-s3/src/adapter.ts packages/storage-r2/src/adapter.ts packages/storage-minio/src/adapter.ts',
    kind: "pattern",
    pattern: /@superfunctions\/storage\/internal\/s3-compatible/,
    paths: [
      "packages/storage-s3/src/adapter.ts",
      "packages/storage-r2/src/adapter.ts",
      "packages/storage-minio/src/adapter.ts",
    ],
  },
];

const commandChecks = [
  "npm -w docs run check:coverage",
  "npm -w docs run check:snippets",
  "npm -w docs run check:links",
];

const commandResults = commandChecks.map((command) => ({ command, ...run(command) }));

const checklistResults = checklist.map((item) => {
  const result =
    item.kind === "pattern" ? scanForPattern(item.pattern, item.paths) : run(item.command);

  return {
    package: item.package,
    requirement: item.requirement,
    command: item.command,
    status: result.ok ? "done" : "pending",
    error: result.ok ? undefined : result.error,
  };
});

const pending = checklistResults.filter((item) => item.status !== "done");
const failedCommands = commandResults.filter((item) => !item.ok);

const docsGateDoc = join(
  repoRoot,
  ".conduct/specs/2026-03-12-audit-fix-o4u9k2m7-spec/RELEASE_GATE.md"
);
const gateDocPresent = existsSync(docsGateDoc);

const changelogTargets = [
  "packages/oauth-flow/CHANGELOG.md",
  "packages/oauth-testing/CHANGELOG.md",
  "plugfn/CHANGELOG.md",
  "recfn/server/CHANGELOG.md",
  "cifn/typescript/control-plane/CHANGELOG.md",
];
const missingChangelogs = changelogTargets.filter((targetPath) => !existsSync(join(repoRoot, targetPath)));

const deprecationNoticeOk = fileContains(
  join(repoRoot, "plugfn/core/src/auth/oauth-flow.ts"),
  "DEPRECATED_PATH"
);

const ok =
  pending.length === 0 &&
  failedCommands.length === 0 &&
  gateDocPresent &&
  missingChangelogs.length === 0 &&
  deprecationNoticeOk;

const payload = {
  ok,
  gate: "audit-fix-o4u9k2m7",
  packagesPassed: checklistResults
    .filter((item) => item.status === "done")
    .map((item) => item.package),
  checklist: checklistResults,
  commandResults,
  gateDocPresent,
  missingChangelogs,
  deprecationNoticeOk,
};

if (ok) {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

console.error(
  JSON.stringify({
    ...payload,
    error: {
      code: "RELEASE_GATE_BLOCKED",
      pendingPackages: pending.map((item) => item.package),
    },
  })
);
process.exit(1);
