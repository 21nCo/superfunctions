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
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

// SFNS-307: Turbo replays a CI task from cache only when nothing it reads changed. Workspace packages read root scripts
// Turbo cannot see, so turbo.json makes every scripts/ path a global input except the standalone scripts the CI planner
// lists. These tests ask Turbo for real task hashes and check the standalone list against every tracked file.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const turboBin = path.join(repoRoot, "node_modules", ".bin", process.platform === "win32" ? "turbo.cmd" : "turbo");
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

test("turbo.json excludes exactly the planner's standalone scripts from its scripts/** global input", () => {
  const { globalDependencies } = JSON.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf8"));
  const excluded = globalDependencies.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  assert.deepEqual([...excluded].sort(), [...standaloneGlobs].sort());
  for (const glob of ["scripts/**", "package.json", "tsconfig*.json", "vitest.config.*"]) {
    assert.ok(globalDependencies.includes(glob), `turbo.json globalDependencies must include ${glob}`);
  }
});

test("every standalone glob names files directly under scripts/, never a directory", () => {
  assert.ok(standaloneFiles.length >= standaloneGlobs.length, "each standalone glob matches a tracked script");
  const nested = gitLines(["ls-files", "-z", "--", ...standaloneGlobs.map((glob) => `:(glob)${glob}/**`)]);
  assert.deepEqual(nested, [], "a standalone glob must not match a directory of scripts");
});

// A package that uses a standalone script would read a file Turbo does not hash, and its cached results would go stale.
test("no tracked file outside scripts/ and .github/workflows/, Markdown aside, references a standalone script", () => {
  const names = [...new Set(standaloneFiles.map((file) => path.posix.basename(file)))];
  let matches = "";
  try {
    matches = execFileSync(
      "git",
      [
        "grep", "-n", "-F", ...names.flatMap((name) => ["-e", name]), "--",
        // turbo.json names them only to exclude them from its global inputs.
        ".", ":(exclude)scripts/", ":(exclude).github/workflows/", ":(exclude)*.md", ":(exclude,top)turbo.json",
      ],
      { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
    );
  } catch (error) {
    // git grep exits 1 when nothing matches; anything else is a real failure.
    if (error.status !== 1) {
      throw error;
    }
  }
  assert.equal(matches, "", `these files reference a standalone script (${names.join(", ")}):\n${matches}`);
});

let copyRoot = "";

before(() => {
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
});

after(() => {
  if (copyRoot) {
    rmSync(copyRoot, { recursive: true, force: true, maxRetries: 5 });
  }
});

function probeHash() {
  const output = execFileSync(turboBin, ["run", "build", `--filter=${PROBE_PACKAGE}`, "--dry=json"], {
    cwd: copyRoot,
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
    const target = path.join(copyRoot, file);
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
  ]) {
    assert.notEqual(hashWithEdits([file]), baseline, `${file} must invalidate cached tasks`);
  }
});
