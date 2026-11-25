import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

// SFNS-307: Turbo replays a CI task from cache only when nothing it reads changed. Workspace packages read root scripts
// Turbo cannot see, so turbo.json makes every scripts/ path a global input except the standalone scripts the CI planner
// lists. These tests ask Turbo for real task hashes and check the standalone list against every tracked file. CI's plan
// job runs only the "standalone list: " tests, which need no Turbo, on every pull request; the task-hash tests guard
// the local cache and the cache the JavaScript and DevFn tests jobs restore (SFNS-312).

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// Turbo's npm bin is a Node script, so it runs under this Node on every platform. Windows cannot spawn the turbo.cmd
// shim without a shell (CVE-2024-27980 makes that throw EINVAL), so the shim is never used.
const turboBin = path.join(repoRoot, "node_modules", "turbo", "bin", "turbo");
// A small package with no workspace dependencies and no turbo.json of its own: its build hash moves only with its own
// files and the global inputs.
const PROBE_TASK = "@superfunctions/errors#build";
const PROBE_PACKAGE = PROBE_TASK.split("#")[0];

function gitLines(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

const standaloneGlobs = JSON.parse(
  execFileSync(process.execPath, ["scripts/ci-plan.mjs", "--print-standalone-scripts"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
);
// Pathspec glob magic keeps `*` inside one path segment, as Turbo's globs and the planner's patterns do.
const standaloneFiles = gitLines(["ls-files", "-z", "--", ...standaloneGlobs.map((glob) => `:(glob)${glob}`)]);

test("standalone list: turbo.json excludes exactly the planner's standalone scripts from its scripts/** global input", () => {
  const { globalDependencies } = JSON.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf8"));
  const excluded = globalDependencies.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  assert.deepEqual([...excluded].sort(), [...standaloneGlobs].sort());
  for (const glob of [
    "scripts/**",
    "package.json",
    "tsconfig*.json",
    "vitest.config.*",
    "*/tsconfig*.json",
    "*/vitest.config.*",
  ]) {
    assert.ok(globalDependencies.includes(glob), `turbo.json globalDependencies must include ${glob}`);
  }
});

test("standalone list: every standalone glob names files directly under scripts/, never a directory", () => {
  for (const glob of standaloneGlobs) {
    assert.notDeepEqual(gitLines(["ls-files", "-z", "--", `:(glob)${glob}`]), [], `${glob} matches no tracked script`);
  }
  const nested = gitLines(["ls-files", "-z", "--", ...standaloneGlobs.map((glob) => `:(glob)${glob}/**`)]);
  assert.deepEqual(nested, [], "a standalone glob must not match a directory of scripts");
});

// `git grep -F` for any of the names over the pathspecs; the matching lines, or "" when nothing matches.
function grepNames(names, pathspecs, options = [], cwd = repoRoot) {
  try {
    return execFileSync("git", ["grep", ...options, "-F", ...names.flatMap((name) => ["-e", name]), "--", ...pathspecs], {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if (error.status !== 1) {
      throw error;
    }
    return "";
  }
}

const standaloneNames = [...new Set(standaloneFiles.map((file) => path.posix.basename(file)))];

// A package that uses a standalone script would read a file Turbo does not hash, and its cached results would go stale.
test("standalone list: no tracked file outside scripts/ and .github/workflows/, Markdown aside, references a standalone script", () => {
  const matches = grepNames(standaloneNames, [
    // turbo.json names them only to exclude them from its global inputs.
    ".", ":(exclude)scripts/", ":(exclude).github/workflows/", ":(exclude)*.md", ":(exclude,top)turbo.json",
  ], ["-n"]);
  assert.equal(matches, "", `these files reference a standalone script (${standaloneNames.join(", ")}):\n${matches}`);
});

// Files outside scripts/ that may name a script which, directly or through other scripts, names a standalone script:
// the root package.json runs them as root scripts, never as a package task, and these data files only name them.
const ROOT_SCRIPT_REFERENCES = [
  "package.json",
  "uifn/evidence/contracts/baseline.json", // Commands in UIFn evidence data, read only by root scripts.
  "uifn/version-bump-inputs.json", // Its comment names scripts/verify-uifn-version-bump.mjs, which reads it.
];

// The scripts/ files that name a standalone script, directly or through any chain of scripts naming each other (an
// import, a spawned command or a file list). `-z` keeps each path literal: without it git quotes and escapes a
// non-ASCII or special file name, and the chain would continue under a name no file uses.
function scriptsReachingStandalone(standalone, cwd = repoRoot) {
  const standaloneExcludes = standalone.map((file) => `:(exclude,top)${file}`);
  const reaching = new Set();
  for (let names = [...new Set(standalone.map((file) => path.posix.basename(file)))]; names.length > 0; ) {
    const found = grepNames(names, ["scripts/", ...standaloneExcludes], ["-z", "-l"], cwd)
      .split("\0")
      .filter((file) => file && !reaching.has(file));
    for (const file of found) {
      reaching.add(file);
    }
    names = [...new Set(found.map((file) => path.posix.basename(file)))];
  }
  return reaching;
}

// The lines of files outside scripts/, workflows, Markdown and the allowed root references that name a reaching script.
function packageReferencesTo(reaching, cwd = repoRoot) {
  const reachingNames = [...new Set([...reaching].map((file) => path.posix.basename(file)))];
  return grepNames(reachingNames, [
    ".", ":(exclude)scripts/", ":(exclude).github/workflows/", ":(exclude)*.md",
    ...ROOT_SCRIPT_REFERENCES.map((file) => `:(exclude,top)${file}`),
  ], ["-n"], cwd);
}

// A package task that runs a script reaching a standalone one would read a file Turbo does not hash.
test("standalone list: no package names a script that reaches a standalone script through other scripts", () => {
  const reaching = scriptsReachingStandalone(standaloneFiles);
  assert.ok(reaching.has("scripts/verify-uifn-version-bump.mjs"), "it imports verify-package-lockfiles.mjs");
  const matches = packageReferencesTo(reaching);
  assert.equal(matches, "", `these files reference a script that reaches a standalone script:\n${matches}`);
});

test("standalone list: the chain of scripts follows non-ASCII file names to the package that names them", (t) => {
  const fixture = mkdtempSync(path.join(tmpdir(), "standalone-chain-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const files = {
    "scripts/verify-owners.mjs": "export {};\n",
    "scripts/audit-café.mjs": 'import "./verify-owners.mjs";\n',
    "scripts/report-ü.mjs": 'import "./audit-café.mjs";\n',
    "pkg/package.json": '{ "scripts": { "test": "node ../scripts/report-ü.mjs" } }\n',
  };
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    writeFileSync(path.join(fixture, file), contents);
  }
  // core.quotePath=true is git's default; set it so a user's global setting cannot hide quoting.
  execFileSync("git", ["init", "-q"], { cwd: fixture });
  execFileSync("git", ["config", "core.quotePath", "true"], { cwd: fixture });
  execFileSync("git", ["add", "."], { cwd: fixture });

  const reaching = scriptsReachingStandalone(["scripts/verify-owners.mjs"], fixture);
  assert.deepEqual([...reaching].sort(), ["scripts/audit-café.mjs", "scripts/report-ü.mjs"]);
  assert.match(packageReferencesTo(reaching, fixture), /^pkg\/package\.json:1:.*report-ü\.mjs/m);
});

let copyRoot = "";

// A copy of every tracked file as it is in this working tree, made on first use so the standalone list tests need none.
function repositoryCopy() {
  if (copyRoot) {
    return copyRoot;
  }
  assert.ok(existsSync(turboBin), `Turbo is not installed at ${turboBin}; run npm ci first`);
  copyRoot = mkdtempSync(path.join(tmpdir(), "turbo-cache-config-"));
  for (const file of gitLines(["ls-files", "-z"])) {
    const source = path.join(repoRoot, file);
    const target = path.join(copyRoot, file);
    let stats;
    try {
      stats = lstatSync(source);
    } catch {
      continue; // Tracked but deleted in this working tree.
    }
    mkdirSync(path.dirname(target), { recursive: true });
    if (stats.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else {
      copyFileSync(source, target);
    }
  }
  return copyRoot;
}

after(() => {
  if (copyRoot) {
    rmSync(copyRoot, { recursive: true, force: true, maxRetries: 5 });
  }
});

function probeHash() {
  const output = execFileSync(process.execPath, [turboBin, "run", "build", `--filter=${PROBE_PACKAGE}`, "--dry=json"], {
    cwd: repositoryCopy(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", TURBO_NO_UPDATE_NOTIFIER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const task = JSON.parse(output).tasks.find((candidate) => candidate.taskId === PROBE_TASK);
  assert.ok(task?.hash, `turbo --dry=json reports no hash for ${PROBE_TASK}`);
  return task.hash;
}

// The probe's build hash after appending a newline to each file (creating it when missing), then the files restored.
function hashWithEdits(files) {
  const originals = files.map((file) => {
    const target = path.join(repositoryCopy(), file);
    return [target, existsSync(target) ? readFileSync(target) : null];
  });
  try {
    for (const [target, contents] of originals) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, contents === null ? "{}\n" : Buffer.concat([contents, Buffer.from("\n")]));
    }
    return probeHash();
  } finally {
    for (const [target, contents] of originals) {
      if (contents === null) {
        rmSync(target, { force: true });
      } else {
        writeFileSync(target, contents);
      }
    }
  }
}

test("editing standalone scripts or workflow files leaves a task's hash unchanged", () => {
  const baseline = probeHash();
  assert.ok(standaloneFiles.includes("scripts/promote.mjs"));
  assert.equal(hashWithEdits(standaloneFiles), baseline, "standalone scripts must not invalidate cached tasks");
  assert.equal(hashWithEdits(["scripts/promote.extra.mjs"]), baseline, "a new file a standalone glob covers");
  assert.equal(
    hashWithEdits([".github/workflows/ci.yml", ".github/workflows/uifn-browser.yml"]),
    baseline,
    "workflow files are not task inputs"
  );
});

test("editing a root file a package may read changes every task's hash", () => {
  const baseline = probeHash();
  for (const file of [
    "scripts/docs-site/llms.mjs",
    "scripts/vitest-oauth-shared.mjs",
    "scripts/promote-helper.mjs", // A new script next to a standalone one, but not on the list.
    "package.json",
    "tsconfig.base.json",
    "vitest.config.ts",
    "mdfn/tsconfig.json", // A product's shared config, which its packages' tsconfigs extend.
    "botfn/vitest.config.ts",
  ]) {
    assert.notEqual(hashWithEdits([file]), baseline, `${file} must invalidate cached tasks`);
  }
});
