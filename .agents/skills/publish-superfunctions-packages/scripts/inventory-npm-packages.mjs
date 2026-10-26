#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function output(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${command} exited ${result.status}`);
  }
  return result.stdout.trim();
}

function npmView(spec, fields, cwd) {
  const result = run("npm", ["view", spec, ...fields, "--json"], { cwd });
  if (result.status !== 0) {
    const message = `${result.stderr}\n${result.stdout}`;
    if (/E404|is not in this registry|No match found/i.test(message)) return null;
    throw new Error(message.trim());
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`npm returned invalid JSON for ${spec}`);
  }
}

const args = process.argv.slice(2);
let ref = "HEAD";
let tag = "latest";
const packageArgs = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--ref") {
    ref = args[++index] ?? fail("--ref requires a value");
  } else if (arg === "--tag") {
    tag = args[++index] ?? fail("--tag requires a value");
  } else if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      "Usage: inventory-npm-packages.mjs [--ref REF] [--tag DIST_TAG] <package-dir>...\n",
    );
    process.exit(0);
  } else if (arg.startsWith("-")) {
    fail(`Unknown option: ${arg}`);
  } else {
    packageArgs.push(arg);
  }
}

if (packageArgs.length === 0) fail("Provide at least one package directory");

const repoRoot = output("git", ["rev-parse", "--show-toplevel"]);
const resolvedRef = output("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoRoot });
const inventory = [];

for (const packageArg of packageArgs) {
  const packageDir = resolve(repoRoot, packageArg);
  const packagePath = relative(repoRoot, packageDir) || ".";
  let manifest;

  try {
    manifest = JSON.parse(readFileSync(resolve(packageDir, "package.json"), "utf8"));
  } catch (error) {
    inventory.push({
      path: packagePath,
      state: "unknown",
      reason: `cannot read package.json: ${error.message}`,
    });
    continue;
  }

  const record = {
    name: manifest.name ?? null,
    path: packagePath,
    private: manifest.private === true,
    manifestVersion: manifest.version ?? null,
    releaseRef: ref,
    releaseCommit: resolvedRef,
    distTag: tag,
  };

  if (!record.name || !record.manifestVersion) {
    inventory.push({ ...record, state: "excluded", reason: "missing package name or version" });
    continue;
  }
  if (record.private) {
    inventory.push({ ...record, state: "excluded", reason: "private package" });
    continue;
  }

  try {
    const channelBaseline = npmView(`${record.name}@${tag}`, ["version", "gitHead"], repoRoot);
    const stable = tag === "latest"
      ? channelBaseline
      : npmView(`${record.name}@latest`, ["version", "gitHead"], repoRoot);
    const baseline = channelBaseline ?? stable;
    const manifestPublished = npmView(
      `${record.name}@${record.manifestVersion}`,
      ["version"],
      repoRoot,
    );

    record.channelBaseline = channelBaseline;
    record.stableLatest = stable;
    record.comparisonBaseline = baseline;
    record.channelReleaseAbsent = tag !== "latest" && channelBaseline === null;
    record.manifestVersionPublished = manifestPublished !== null;

    if (baseline === null) {
      inventory.push({
        ...record,
        state: "initial",
        reason: "package has no stable or selected-channel npm release",
        dirtyFiles: gitStatus(repoRoot, packagePath),
      });
      continue;
    }

    record.baselineSource = channelBaseline === null ? "latest" : tag;
    const baselineVersion = typeof baseline === "string" ? baseline : baseline.version;
    const baselineGitHead = typeof baseline === "object" ? baseline.gitHead ?? null : null;
    record.baselineVersion = baselineVersion ?? null;
    record.baselineGitHead = baselineGitHead;
    record.dirtyFiles = gitStatus(repoRoot, packagePath);

    if (!baselineGitHead) {
      inventory.push({
        ...record,
        state: "unknown",
        reason: "registry release has no gitHead; compare normalized tarballs",
      });
      continue;
    }

    const exists = run("git", ["cat-file", "-e", `${baselineGitHead}^{commit}`], {
      cwd: repoRoot,
    }).status === 0;
    record.baselineCommitAvailable = exists;
    if (!exists) {
      inventory.push({
        ...record,
        state: "unknown",
        reason: "registry gitHead is unavailable locally; fetch history or compare normalized tarballs",
      });
      continue;
    }

    const ancestor = run(
      "git",
      ["merge-base", "--is-ancestor", baselineGitHead, resolvedRef],
      { cwd: repoRoot },
    ).status === 0;
    record.baselineIsAncestor = ancestor;

    const changedFiles = output(
      "git",
      ["diff", "--name-only", `${baselineGitHead}..${resolvedRef}`, "--", packagePath],
      { cwd: repoRoot },
    ).split("\n").filter(Boolean);
    record.changedFiles = changedFiles;

    if (!ancestor) {
      inventory.push({
        ...record,
        state: "unknown",
        reason: "registry gitHead is not an ancestor of the release ref; inspect merge history or compare tarballs",
      });
    } else if (changedFiles.length > 0) {
      inventory.push({ ...record, state: "changed", reason: "package path changed since registry gitHead" });
    } else {
      inventory.push({ ...record, state: "unchanged", reason: "no package-path changes since registry gitHead" });
    }
  } catch (error) {
    inventory.push({ ...record, state: "unknown", reason: error.message });
  }
}

function gitStatus(root, packagePath) {
  const status = output("git", ["status", "--porcelain=v1", "--", packagePath], { cwd: root });
  return status.split("\n").filter(Boolean);
}

process.stdout.write(`${JSON.stringify({ repoRoot, ref, resolvedRef, tag, packages: inventory }, null, 2)}\n`);
