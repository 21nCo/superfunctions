// Root workspaces resolve by shape globs (SFNS-123, SFNS-121 D3), so a function that follows a shape needs no
// root package.json edit. The globs must not change which packages are workspaces: at the commit that replaced the
// explicit list they resolve to exactly the same set, and later no example, fixture, template or docs package is
// swept in by a shape the explicit list did not have.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gitBinary } from "./verify-package-lockfiles.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The last explicit list, from dev at BASELINE_COMMIT (SFNS-122), kept as the reference set.
const BASELINE_COMMIT = "23c60c3ea99f38dd67473d9dc3972abfa646962f";
const EXPLICIT_WORKSPACES = [
  "searchfn/*", "*fn/admin", "botfn/*", "hostfn/*", "authfn/*", "uifn/*", "uifn/catalogs/*", "uifn/examples/*",
  "authfn/adapters/*", "authfn/examples/*", "authfn/examples/*/*", "apifn/*", "extfn/*", "extfn/examples/*",
  "datafn/client", "datafn/cli", "datafn/core", "datafn/docs", "datafn/extfn", "datafn/server", "datafn/svelte",
  "datafn/swift-bridge", "mcpfn/*", "reviewfn/*", "mailfn/*", "mdfn/*", "mdfn/examples/*", "billfn/*", "filefn/*",
  "clifn/*", "devfn/*", "superconsole", "packages/*", "filefn/examples/full-demo/*", "filefn/examples/production/*",
  "plugfn/*", "sendfn/*", "langfn/typescript", "logfn/typescript", "catchfn/typescript", "watchfn/typescript",
  "langfn/docs", "memoryfn/typescript", "memoryfn/docs", "secfn/core", "secfn/server", "secfn/runtime", "secfn/docs",
];
// Shapes used by public and next today; a function laid out in one of them is a workspace in either repository.
const SHAPES = [
  "*/typescript", "*/typescript/*", "*/admin", "*/server/typescript", "*/adapters/*", "*/platforms/*", "*/apps/*", "*/packages/*",
];
// Directory names a shape must never newly sweep in.
const EXCLUDED_SEGMENTS = new Set(["docs", "example", "examples", "fixture", "fixtures", "__fixtures__", "template", "templates", "test", "tests"]);

const git = (...args) => execFileSync(gitBinary(), args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });

/** One glob segment as npm workspaces read it: `*` matches within a segment and never a leading dot. */
function segmentPattern(segment) {
  const body = segment.split("*").map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
  return new RegExp(`^${segment.startsWith("*") ? "(?!\\.)" : ""}${body}$`);
}

function matchesWorkspace(pattern, directory) {
  const patternSegments = pattern.split("/");
  const segments = directory.split("/");
  return patternSegments.length === segments.length && patternSegments.every((segment, index) => segmentPattern(segment).test(segments[index]));
}

/** Package directories (holding a tracked package.json, outside node_modules) that any pattern matches. */
function resolveWorkspaces(patterns, packageFiles) {
  return new Set(
    packageFiles
      .filter((file) => file.endsWith("/package.json"))
      .map((file) => file.slice(0, -"/package.json".length))
      .filter((directory) => !directory.split("/").includes("node_modules"))
      .filter((directory) => patterns.some((pattern) => matchesWorkspace(pattern, directory))),
  );
}

const sorted = (set) => [...set].sort();
const workspaces = () => JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).workspaces;

test("the glob matcher follows npm's segment rules", () => {
  assert.equal(matchesWorkspace("*/typescript", "langfn/typescript"), true);
  assert.equal(matchesWorkspace("*/typescript", "langfn/typescript/core"), false);
  assert.equal(matchesWorkspace("*/typescript/*", "cifn/typescript/core"), true);
  assert.equal(matchesWorkspace("*fn/admin", "packages/admin"), false);
  assert.equal(matchesWorkspace("*/admin", "packages/admin"), true);
  assert.equal(matchesWorkspace("*/admin", ".hidden/admin"), false);
  assert.equal(matchesWorkspace("superconsole", "superconsole"), true);
  assert.deepEqual(sorted(resolveWorkspaces(["*/apps/*"], ["a/apps/b/package.json", "a/apps/b/c.ts", "a/apps/node_modules/package.json"])), ["a/apps/b"]);
});

test("root workspaces list every shape and keep the explicit entries the shapes do not cover", () => {
  const current = workspaces();
  for (const shape of SHAPES) assert.ok(current.includes(shape), `workspaces must include ${shape}`);
  assert.equal(new Set(current).size, current.length, "workspaces must not repeat a pattern");
  for (const pattern of current) {
    assert.ok(!pattern.startsWith("!"), `${pattern}: negated workspace patterns are not used`);
  }
});

test("at the baseline commit the globs resolve exactly the explicit list's packages", (t) => {
  try {
    git("cat-file", "-e", `${BASELINE_COMMIT}^{commit}`);
  } catch {
    t.skip(`baseline commit ${BASELINE_COMMIT} is not in this clone (shallow checkout)`);
    return;
  }
  const files = git("ls-tree", "-r", "-z", "--name-only", BASELINE_COMMIT).split("\0").filter(Boolean);
  const explicit = resolveWorkspaces(EXPLICIT_WORKSPACES, files);
  assert.ok(explicit.size > 200, `expected the baseline to have its ~260 workspaces, found ${explicit.size}`);
  assert.deepEqual(sorted(resolveWorkspaces(workspaces(), files)), sorted(explicit));
});

test("in this checkout the globs keep every explicit-list package and add no example, fixture or docs package", () => {
  const files = git("ls-files", "-z").split("\0").filter(Boolean);
  const explicit = resolveWorkspaces(EXPLICIT_WORKSPACES, files);
  const globbed = resolveWorkspaces(workspaces(), files);
  assert.deepEqual(sorted(explicit).filter((directory) => !globbed.has(directory)), [], "explicit-list packages must stay workspaces");
  const added = sorted(globbed).filter((directory) => !explicit.has(directory));
  const excluded = added.filter((directory) => directory.split("/").slice(1).some((segment) => EXCLUDED_SEGMENTS.has(segment)));
  assert.deepEqual(excluded, [], "a shape glob must not make an example, fixture, template, test or docs package a workspace");
});
