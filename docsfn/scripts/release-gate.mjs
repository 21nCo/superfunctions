#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const docsfnRoot = resolve(scriptDir, "..");
const repoRoot = resolve(docsfnRoot, "..");
const cliBin = resolve(docsfnRoot, "cli", "bin", "docsfn.js");
const gateTempRoot = resolve(docsfnRoot, ".tmp", "release-gate");

const fixtureRoots = {
  datafn: resolve(docsfnRoot, "test-fixtures", "repo", "datafn-docs"),
  searchfn: resolve(docsfnRoot, "test-fixtures", "repo", "searchfn-docs"),
};

const packageBuildMatrix = [
  { name: "@docsfn/core", prefix: resolve(docsfnRoot, "core") },
  { name: "@docsfn/provider-fs", prefix: resolve(docsfnRoot, "provider-fs") },
  { name: "@docsfn/react", prefix: resolve(docsfnRoot, "react") },
  { name: "@docsfn/svelte", prefix: resolve(docsfnRoot, "svelte") },
  { name: "@docsfn/next", prefix: resolve(docsfnRoot, "next") },
  { name: "@docsfn/sveltekit", prefix: resolve(docsfnRoot, "sveltekit") },
  { name: "@docsfn/cli", prefix: resolve(docsfnRoot, "cli") },
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

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeFieldPath(pkgRoot, value) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const trimmed = value.startsWith("./") ? value.slice(2) : value;
  return resolve(pkgRoot, trimmed);
}

function parsePeerRangeTokens(range) {
  return String(range)
    .split("||")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

async function verifyPackageMetadataAndArtifacts() {
  const packageJsons = {};

  for (const item of packageBuildMatrix) {
    const packageJsonPath = resolve(item.prefix, "package.json");
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
    packageJsons[item.name] = {
      path: packageJsonPath,
      root: item.prefix,
      json: parsed,
    };

    for (const field of ["main", "module", "types"]) {
      const outputPath = normalizeFieldPath(item.prefix, parsed[field]);
      if (outputPath) {
        assert(await fileExists(outputPath), `${item.name}: missing ${field} output at ${outputPath}`);
      }
    }
  }

  assert(
    packageJsons["@docsfn/core"].json.name === "@docsfn/core",
    "core package name must be @docsfn/core"
  );

  const reactPeers = packageJsons["@docsfn/react"].json.peerDependencies ?? {};
  const reactRangeTokens = parsePeerRangeTokens(reactPeers.react ?? "");
  const reactDomRangeTokens = parsePeerRangeTokens(reactPeers["react-dom"] ?? "");
  assert(
    reactRangeTokens.includes("^18.0.0") && reactRangeTokens.includes("^19.0.0"),
    "@docsfn/react peerDependencies.react must include ^18.0.0 and ^19.0.0"
  );
  assert(
    reactDomRangeTokens.includes("^18.0.0") && reactDomRangeTokens.includes("^19.0.0"),
    "@docsfn/react peerDependencies.react-dom must include ^18.0.0 and ^19.0.0"
  );

  const nextPeers = packageJsons["@docsfn/next"].json.peerDependencies ?? {};
  assert(
    String(nextPeers.next ?? "").includes("^15.0.0"),
    "@docsfn/next peerDependencies.next must include ^15.0.0"
  );

  const sveltePeers = packageJsons["@docsfn/svelte"].json.peerDependencies ?? {};
  const svelteRangeTokens = parsePeerRangeTokens(sveltePeers.svelte ?? "");
  assert(
    svelteRangeTokens.includes("^4.0.0") && svelteRangeTokens.includes("^5.0.0"),
    "@docsfn/svelte peerDependencies.svelte must include ^4.0.0 and ^5.0.0"
  );

  const svelteKitPeers = packageJsons["@docsfn/sveltekit"].json.peerDependencies ?? {};
  assert(
    String(svelteKitPeers["@sveltejs/kit"] ?? "").includes("^2.0.0"),
    "@docsfn/sveltekit peerDependencies.@sveltejs/kit must include ^2.0.0"
  );
}

async function runBuildMatrix() {
  for (const item of packageBuildMatrix) {
    console.log(`[release-gate] build ${item.name}`);
    await run("npm", ["--prefix", item.prefix, "run", "build"], { cwd: repoRoot });
  }
}

async function runTestMatrix() {
  console.log("[release-gate] core test matrix");
  await run("npm", ["--prefix", resolve(docsfnRoot, "core"), "run", "test", "--", "--run"], {
    cwd: repoRoot,
  });

  console.log("[release-gate] provider test matrix");
  await run("npm", ["--prefix", resolve(docsfnRoot, "provider-fs"), "run", "test", "--", "--run"], {
    cwd: repoRoot,
  });

  console.log("[release-gate] adapter parity test");
  await run("npm", ["exec", "--", "vitest", "run", "docsfn/sveltekit/src/route-helpers.test.ts"], {
    cwd: repoRoot,
  });
}

async function runFixtureBuilds() {
  await mkdir(gateTempRoot, { recursive: true });

  console.log("[release-gate] validate canonical fixtures");
  await run("node", [cliBin, "validate", "--root", fixtureRoots.datafn], { cwd: repoRoot });
  await run("node", [cliBin, "validate", "--root", fixtureRoots.searchfn], { cwd: repoRoot });

  console.log("[release-gate] build canonical fixtures");
  await run("node", [cliBin, "build", "--root", fixtureRoots.datafn, "--out-dir", resolve(gateTempRoot, "datafn-default")], {
    cwd: repoRoot,
  });
  await run("node", [cliBin, "build", "--root", fixtureRoots.searchfn, "--out-dir", resolve(gateTempRoot, "searchfn-default")], {
    cwd: repoRoot,
  });
}

async function runExampleBuilds() {
  const nextExamplePrefix = resolve(docsfnRoot, "examples", "next-docs-site");
  const svelteExamplePrefix = resolve(docsfnRoot, "examples", "sveltekit-docs-site");

  console.log("[release-gate] build Next example against searchfn-docs");
  await run("npm", ["--prefix", nextExamplePrefix, "run", "build"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DOCSFN_FIXTURE_ROOT: "../../test-fixtures/repo/searchfn-docs",
    },
  });

  console.log("[release-gate] build Next example against datafn-docs");
  await run("npm", ["--prefix", nextExamplePrefix, "run", "build"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DOCSFN_FIXTURE_ROOT: "../../test-fixtures/repo/datafn-docs",
    },
  });

  console.log("[release-gate] build SvelteKit example against searchfn-docs");
  await run("npm", ["--prefix", svelteExamplePrefix, "run", "build"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DOCSFN_FIXTURE_ROOT: "../../test-fixtures/repo/searchfn-docs",
    },
  });

  console.log("[release-gate] build SvelteKit example against datafn-docs");
  await run("npm", ["--prefix", svelteExamplePrefix, "run", "build"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DOCSFN_FIXTURE_ROOT: "../../test-fixtures/repo/datafn-docs",
    },
  });
}

async function runMigrationParity() {
  console.log("[release-gate] migration parity checks");
  await run("node", [resolve(docsfnRoot, "scripts", "migration-check.mjs")], { cwd: repoRoot });
}

async function main() {
  await rm(gateTempRoot, { recursive: true, force: true });

  await runBuildMatrix();
  await verifyPackageMetadataAndArtifacts();
  await runTestMatrix();
  await runFixtureBuilds();
  await runExampleBuilds();
  await runMigrationParity();

  console.log("\n[release-gate] PASS: package builds, test layers, fixtures, examples, and migration parity all succeeded.");
}

main().catch((error) => {
  console.error(`\n[release-gate] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
