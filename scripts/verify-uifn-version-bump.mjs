#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { gitBinary } from "./verify-package-lockfiles.mjs";

const GRAPH_PATH = "uifn/package-graph.json";
const RELEASE_TARGETS_PATH = "release-packages.json";

// Shipped code is everything that feeds the tarball (`dist` is built from the
// package sources and configs) minus tests, fixtures, stories, harnesses and
// Markdown docs. Unknown paths count as shipped so new build inputs fail closed.
const NON_SHIPPED_SEGMENTS = new Set(["__tests__", "__mocks__", "__fixtures__", "__snapshots__", "fixtures", "test", "tests"]);
const NON_SHIPPED_ROOT_DIRS = new Set(["browser", "stories", "type-tests", "workbenches"]);
const NON_SHIPPED_FILE = /(?:\.(?:test|spec|test-d|stories)\.[^/]+|\.mdx?|\.snap)$/i;
const NON_SHIPPED_ROOT_FILE = /^(?:vitest|playwright)(?:\.[^/]+)?\.config\.[^/]+$/;
// A root Vite config is a build input only when the package builds with Vite.
const VITE_ROOT_FILE = /^vite(?:\.[^/]+)?\.config\.[^/]+$/;
// devDependencies and non-lifecycle scripts are not part of what consumers install.
const SHIPPED_SCRIPTS = new Set(["build", "prepare", "prepack", "postpack", "prepublish", "prepublishOnly", "preinstall", "install", "postinstall"]);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Classifies a path relative to the package root as "manifest", "shipped" or "excluded". */
export function classifyPath(relative, { buildUsesVite = true } = {}) {
  if (relative === "package.json") return "manifest";
  const segments = relative.split("/");
  const file = segments.at(-1);
  if (segments.length > 1 && NON_SHIPPED_ROOT_DIRS.has(segments[0])) return "excluded";
  if (segments.slice(0, -1).some((segment) => NON_SHIPPED_SEGMENTS.has(segment))) return "excluded";
  if (NON_SHIPPED_FILE.test(file)) return "excluded";
  if (segments.length === 1 && NON_SHIPPED_ROOT_FILE.test(file)) return "excluded";
  if (segments.length === 1 && !buildUsesVite && VITE_ROOT_FILE.test(file)) return "excluded";
  return "shipped";
}

/** Returns the manifest fields that reach consumers, without the version itself. */
export function publishedManifest(manifest) {
  const { version: _version, devDependencies: _devDependencies, scripts, ...published } = manifest;
  const shippedScripts = Object.entries(scripts ?? {}).filter(([name]) => SHIPPED_SCRIPTS.has(name));
  if (shippedScripts.length > 0) published.scripts = Object.fromEntries(shippedScripts);
  return published;
}

function parseSemver(version) {
  const match = typeof version === "string" ? version.match(SEMVER) : null;
  if (!match) return null;
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split(".") ?? [] };
}

/** Semver precedence: negative when a < b, zero when equal, positive when a > b. */
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) throw new Error(`Invalid semver: ${left ? b : a}`);
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const l = left.prerelease[index];
    const r = right.prerelease[index];
    if (l === undefined || r === undefined) return l === undefined ? -1 : 1;
    if (l === r) continue;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) return Number(l) - Number(r);
    if (ln !== rn) return ln ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

/** True when the changelog has a heading for `version` followed by at least one content line. */
export function changelogHasEntry(text, version) {
  if (typeof text !== "string") return false;
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`^(#{1,6})\\s+\\[?v?${escaped}\\]?(?:\\s|$)`);
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return false;
  const level = lines[start].match(/^#+/)[0].length;
  for (const line of lines.slice(start + 1)) {
    const nested = line.match(/^(#{1,6})\s/);
    if (nested && nested[1].length <= level) return false;
    if (!nested && line.trim()) return true;
  }
  return false;
}

/** Pure per-package decision shared by the PR gate and the since-published report. */
export function evaluatePackage({ name, packagePath, baseManifest, headManifest, changedFiles, headChangelog }) {
  const prefix = `${packagePath}/`;
  const buildScripts = Object.values(publishedManifest(headManifest ?? baseManifest ?? {}).scripts ?? {});
  const options = { buildUsesVite: buildScripts.some((script) => /\bvite\b/.test(script)) };
  const shippedFiles = changedFiles
    .filter((file) => file.startsWith(prefix) && classifyPath(file.slice(prefix.length), options) === "shipped")
    .sort();
  const result = { name, packagePath, shippedFiles, manifestChanged: false, baseVersion: baseManifest?.version, headVersion: headManifest?.version, bumped: false, errors: [] };
  if (!headManifest) {
    result.errors.push(`${name}: ${packagePath}/package.json is missing`);
    return result;
  }
  if (!baseManifest) return result;
  result.manifestChanged = JSON.stringify(publishedManifest(baseManifest)) !== JSON.stringify(publishedManifest(headManifest));
  const changed = shippedFiles.length > 0 || result.manifestChanged;
  if (result.baseVersion !== result.headVersion) {
    if (!parseSemver(result.headVersion)) {
      result.errors.push(`${name}: version ${JSON.stringify(result.headVersion)} is not valid semver`);
      return result;
    }
    if (parseSemver(result.baseVersion) && compareSemver(result.headVersion, result.baseVersion) <= 0) {
      result.errors.push(`${name}: version ${result.headVersion} must be greater than ${result.baseVersion}`);
      return result;
    }
    result.bumped = true;
    if (!changelogHasEntry(headChangelog, result.headVersion)) {
      result.errors.push(`${name}: version bumped to ${result.headVersion} but ${packagePath}/CHANGELOG.md has no "## ${result.headVersion}" entry with content`);
    }
  } else if (changed) {
    const reasons = [...shippedFiles.map((file) => file.slice(prefix.length)), ...(result.manifestChanged ? ["package.json (published fields)"] : [])];
    const listed = reasons.slice(0, 5).join(", ") + (reasons.length > 5 ? `, and ${reasons.length - 5} more` : "");
    result.errors.push(`${name}: shipped code changed (${listed}) but version is still ${result.headVersion}; bump ${packagePath}/package.json and add a "## <new version>" entry to ${packagePath}/CHANGELOG.md`);
  }
  return result;
}

function git(cwd, args) {
  return execFileSync(gitBinary(), args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

function resolveCommit(cwd, ref) {
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch {
    throw new Error(`Cannot resolve ${ref} to a commit; fetch it first (CI needs fetch-depth: 0)`);
  }
}

function readAt(cwd, commit, file) {
  try {
    git(cwd, ["cat-file", "-e", `${commit}:${file}`]);
  } catch {
    return null;
  }
  return git(cwd, ["show", `${commit}:${file}`]);
}

function readJsonAt(cwd, commit, file) {
  const text = readAt(cwd, commit, file);
  return text === null ? null : JSON.parse(text);
}

function stablePackages(cwd, commit) {
  const graph = readJsonAt(cwd, commit, GRAPH_PATH);
  if (!Array.isArray(graph?.stable)) throw new Error(`${GRAPH_PATH} at ${commit} has no stable package list`);
  return graph.stable.map(({ name, path: packagePath }) => ({ name, packagePath }));
}

function changedFiles(cwd, from, to, pathspecs) {
  return git(cwd, ["diff", "--name-only", "-z", "--no-renames", from, to, "--", ...pathspecs]).split("\0").filter(Boolean);
}

function evaluateRange(cwd, from, to, packages) {
  const files = changedFiles(cwd, from, to, packages.map(({ packagePath }) => `${packagePath}/`));
  return packages.map(({ name, packagePath }) =>
    evaluatePackage({
      name,
      packagePath,
      baseManifest: readJsonAt(cwd, from, `${packagePath}/package.json`),
      headManifest: readJsonAt(cwd, to, `${packagePath}/package.json`),
      changedFiles: files,
      headChangelog: readAt(cwd, to, `${packagePath}/CHANGELOG.md`),
    })
  );
}

/** PR gate: every stable package whose shipped code changed since the merge base must bump and log it. */
export function verifyVersionBumps({ cwd = process.cwd(), base, head = "HEAD" }) {
  const headCommit = resolveCommit(cwd, head);
  const baseCommit = resolveCommit(cwd, base);
  let mergeBase;
  try {
    mergeBase = git(cwd, ["merge-base", baseCommit, headCommit]).trim();
  } catch {
    throw new Error(`${base} and ${head} share no history; fetch full history before running this check`);
  }
  const results = evaluateRange(cwd, mergeBase, headCommit, stablePackages(cwd, headCommit));
  return { mergeBase, head: headCommit, results, errors: results.flatMap((result) => result.errors) };
}

/** Informational: shipped changes on `head` since each stable package's highest published tag. */
export function reportSincePublished({ cwd = process.cwd(), head = "HEAD" }) {
  const headCommit = resolveCommit(cwd, head);
  const targets = readJsonAt(cwd, headCommit, RELEASE_TARGETS_PATH) ?? [];
  return stablePackages(cwd, headCommit).map((pkg) => {
    const slug = targets.find((target) => target.name === pkg.name)?.slug ?? `uifn-${path.posix.basename(pkg.packagePath)}`;
    const tags = git(cwd, ["tag", "--list", `${slug}-v*`])
      .split("\n")
      .map((tag) => ({ tag, version: tag.slice(slug.length + 2) }))
      .filter(({ tag, version }) => tag && parseSemver(version))
      .sort((a, b) => compareSemver(b.version, a.version));
    if (tags.length === 0) return { ...pkg, tag: null };
    const [result] = evaluateRange(cwd, resolveCommit(cwd, tags[0].tag), headCommit, [pkg]);
    return { ...result, tag: tags[0].tag };
  });
}

function formatReport(entries) {
  const lines = ["uifn stable packages: shipped changes since the last published tag (informational)"];
  let changed = 0;
  for (const entry of entries) {
    if (!entry.tag) {
      lines.push(`  ${entry.name}: no published tag`);
      continue;
    }
    const drift = entry.shippedFiles.length > 0 || entry.manifestChanged;
    if (drift) changed += 1;
    const what = drift
      ? `${entry.shippedFiles.length} shipped file(s) changed${entry.manifestChanged ? " + published manifest fields" : ""}`
      : "no shipped changes";
    const version = entry.bumped ? `version ${entry.baseVersion} -> ${entry.headVersion} (unpublished)` : `version ${entry.headVersion}`;
    lines.push(`  ${entry.name}: ${entry.tag} -> HEAD: ${what}; ${version}`);
  }
  lines.push(`${changed} of ${entries.length} stable packages have shipped changes since their last published tag.`);
  return lines.join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { base: { type: "string" }, head: { type: "string", default: "HEAD" }, "since-published": { type: "boolean", default: false } },
    });
    if (values["since-published"]) {
      console.log(formatReport(reportSincePublished({ head: values.head })));
    } else {
      if (!values.base) throw new Error("Usage: verify-uifn-version-bump.mjs --base <ref> [--head <ref>] | --since-published [--head <ref>]");
      const { mergeBase, head, results, errors } = verifyVersionBumps({ base: values.base, head: values.head });
      console.log(`uifn version bump check: ${mergeBase.slice(0, 12)}...${head.slice(0, 12)}`);
      for (const result of results.filter((entry) => entry.errors.length === 0 && entry.bumped)) {
        console.log(`  ok ${result.name}: ${result.baseVersion} -> ${result.headVersion} with changelog entry`);
      }
      if (errors.length > 0) {
        for (const error of errors) console.error(`  error: ${error}`);
        process.exitCode = 1;
      } else {
        console.log("  ok: no stable package ships changed code under an unchanged version");
      }
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
