#!/usr/bin/env node
// Packs the McpFn packages whose build, tsup config and tests load repository
// scripts the way publish-tag.yml does (MCP-13): each package is installed on
// its own with `npm install --workspaces=false --package-lock=false` in its
// directory, so the repository root has no node_modules, and then
// scripts/pack-release-package.mjs builds (with the bundled-SDK verifier),
// typechecks, tests and packs it. Workspace checks use the hoisted root
// install and cannot see a script that resolves a dependency from the root.
//
// The copy is a fresh tree outside the checkout with the package's tracked
// files and the release scripts at their repository paths.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const PACKAGES = [
  ["mcpfn/core", "mcpfn-core"],
  ["mcpfn/auth", "mcpfn-auth"],
];
const RELEASE_FILES = [
  "package.json",
  "release-packages.json",
  "superfunctions.owners.json",
  "scripts/owners.mjs",
  "scripts/assert-bare-release.mjs",
  "scripts/pack-release-package.mjs",
  "scripts/resolve-release-tag.mjs",
  "scripts/verify-mcpfn-bundled-sdk.mjs",
  "scripts/verify-mcpfn-bundled-sdk.d.mts",
];
// npm run exports npm_config_* settings of the outer workspace install, and a
// Git hook exports GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE: the isolated
// install, the scratch repository and the packer's git lookup must not reach
// the caller's checkout through them.
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(npm_|GIT_)/i.test(name)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd, env: { ...env, ...extraEnv }, encoding: "utf8", stdio: "pipe", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 || result.error) {
    throw new Error(`${[command, ...args].join(" ")} failed in ${cwd} (status ${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const isolatedRoot = mkdtempSync(path.join(tmpdir(), "mcpfn-isolated-release-"));
try {
  const tracked = run("git", ["ls-files", "-z", "--", ...RELEASE_FILES, ...PACKAGES.map(([packagePath]) => packagePath)], repoRoot)
    .split("\0")
    .filter(Boolean);
  for (const file of tracked) {
    mkdirSync(path.dirname(path.join(isolatedRoot, file)), { recursive: true });
    copyFileSync(path.join(repoRoot, file), path.join(isolatedRoot, file));
  }
  // pack-release-package.mjs records the commit it packs. The scratch
  // repository ignores the caller's global and system Git config (commit
  // signing, hooks, templates), so a signer that is unavailable here cannot
  // stop the commit.
  const scratchGit = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
  run("git", ["init", "--quiet"], isolatedRoot, scratchGit);
  run("git", ["add", "--all"], isolatedRoot, scratchGit);
  run("git", ["-c", "user.name=mcpfn-release-gate", "-c", "user.email=mcpfn-release-gate@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", "isolated release"], isolatedRoot, scratchGit);
  const packed = [];
  for (const [packagePath, slug] of PACKAGES) {
    const cwd = path.join(isolatedRoot, packagePath);
    const { version } = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8"));
    // The workflow's install, under CI's lifecycle policy (npm ci
    // --ignore-scripts, then a rebuild of the trusted esbuild binding only).
    run(npm, ["install", "--workspaces=false", "--package-lock=false", "--ignore-scripts", "--no-audit", "--no-fund"], cwd);
    run(npm, ["rebuild", "esbuild", "--workspaces=false"], cwd);
    // The workflow reads the packed tarball from GITHUB_OUTPUT.
    const output = path.join(isolatedRoot, `${slug}.github-output`);
    run(process.execPath, ["scripts/pack-release-package.mjs", `${slug}-v${version}`], isolatedRoot, { GITHUB_OUTPUT: output });
    const tarball = /^tarball=(.+)$/m.exec(readFileSync(output, "utf8"))?.[1];
    if (!tarball || !existsSync(tarball)) throw new Error(`${slug}-v${version} produced no tarball`);
    rmSync(path.dirname(tarball), { recursive: true, force: true });
    packed.push(`${slug}-v${version}: ${path.basename(tarball)}`);
  }
  console.log(JSON.stringify({ ok: true, packed }));
} finally {
  rmSync(isolatedRoot, { recursive: true, force: true });
}
