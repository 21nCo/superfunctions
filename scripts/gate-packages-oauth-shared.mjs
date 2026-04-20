#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const oauthPackages = [
  "@superfunctions/oauth-core",
  "@superfunctions/oauth-http",
  "@superfunctions/oauth-storage",
  "@superfunctions/oauth-providers",
  "@superfunctions/oauth-flow",
  "@superfunctions/oauth-testing",
  "@superfunctions/oauth-router",
];

const docsInventory = [
  "packages/oauth-core/README.md",
  "packages/oauth-http/README.md",
  "packages/oauth-storage/README.md",
  "packages/oauth-providers/README.md",
  "packages/oauth-flow/README.md",
  "packages/oauth-testing/README.md",
  "packages/oauth-router/README.md",
  "docs/content/docs/authentication/oauth-storage.mdx",
  "docs/content/docs/authentication/oauth-flow.mdx",
  "docs/content/docs/authentication/oauth-providers.mdx",
  "docs/content/docs/authentication/oauth-router.mdx",
  "docs/content/docs/architecture/oauth-flow-architecture.mdx",
];

const navFile = "docs/content/docs/authentication/meta.json";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });

  return {
    ok: (result.status ?? 1) === 0,
    status: result.status ?? 1,
    command: [command, ...args].join(" "),
  };
}

function verifyDocsInventory() {
  const missingFiles = docsInventory.filter((file) => !existsSync(resolve(process.cwd(), file)));
  const nav = JSON.parse(readFileSync(resolve(process.cwd(), navFile), "utf8"));
  const navContainsRouter = Array.isArray(nav.pages) && nav.pages.includes("oauth-router");

  return {
    ok: missingFiles.length === 0 && navContainsRouter,
    missingFiles,
    navContainsRouter,
  };
}

const buildResult = run("npx", [
  "turbo",
  "run",
  "build",
  ...oauthPackages.flatMap((pkg) => ["--filter", pkg]),
]);

const testResults = oauthPackages.map((pkg) =>
  run("npm", ["test", "--workspace", pkg]),
);

const docsResult = verifyDocsInventory();

const payload = {
  ok: buildResult.ok && testResults.every((result) => result.ok) && docsResult.ok,
  build: buildResult,
  tests: testResults,
  docsInventory: docsResult,
};

if (payload.ok) {
  console.log(JSON.stringify(payload));
  process.exit(0);
}

console.error(JSON.stringify(payload));
process.exit(1);
