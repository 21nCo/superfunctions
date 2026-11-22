/**
 * `apifn check`: drift, validation, diff against a base and the version rule (API-5, D7).
 */

import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { access, chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { stringify as toYaml, parse as parseYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/index.js";
import {
  CHECK_REPORT_MARKER,
  canonicalJson,
  parseContract,
  parseSemver,
  runCheckCommand,
  versionCoversBreaking,
} from "../src/commands/check.js";
import { diffOpenAPI } from "@apifn/core";
import { comparable } from "../src/commands/check-compare.js";
import { fetchBounded } from "../src/commands/check-io.js";
import { observe } from "../src/commands/check-publish.js";
import type { PublishStep } from "../src/commands/check-publish.js";
import { loadRouterModule } from "../src/utils/router-loader.js";
import type { Output } from "../src/utils/output.js";
import type { CheckReport } from "../src/commands/check.js";
import { tempDir } from "./temp-dirs.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "check");

/** True when the temp directory's filesystem ignores case (macOS and Windows defaults). */
const CASE_INSENSITIVE_FS = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifn-check-case-"));
  try {
    return existsSync(dir.toUpperCase()) && existsSync(dir.toLowerCase());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
/** True when the temp directory's filesystem treats NFC and NFD spellings as one name (APFS). */
const NORMALIZATION_INSENSITIVE_FS = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "apifn-check-nfc-"));
  try {
    writeFileSync(path.join(dir, "caf\u00e9"), "");
    return existsSync(path.join(dir, "cafe\u0301"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const SPEC = path.join(".apifn", "openapi.yml");

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], cwd: string): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(args, {
    cwd,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

async function runJson(args: string[], cwd: string): Promise<{ code: number; report: CheckReport }> {
  const result = await run([...args, "--format", "json"], cwd);
  expect(result.stderr).toBe("");
  return { code: result.code, report: JSON.parse(result.stdout) as CheckReport };
}

/** Copies all check fixtures into a temp directory so a test can write specs beside them. */
async function fixtures(): Promise<string> {
  const root = await tempDir("apifn-check-");
  await cp(FIXTURES, root, { recursive: true });
  return root;
}

/** Commits the spec the fixture's router generates, as a developer would after `apifn generate`. */
async function commitSpec(dir: string): Promise<void> {
  const result = await run(["generate"], dir);
  expect(result.code).toBe(0);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=apifn test",
      "-c",
      "user.email=apifn-test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

describe("apifn check: version rule (D7)", () => {
  it.each([
    ["1.0.0", "2.0.0", true],
    ["1.4.2", "1.5.0", false],
    ["1.0.0", "1.0.1", false],
    ["1.0.0", "1.0.0", false],
    ["2.0.0", "1.9.9", false],
    ["0.3.0", "0.4.0", true],
    ["0.3.0", "0.3.1", false],
    ["0.3.0", "1.0.0-rc.1", true],
    ["1.0.0", "2.0.0+build.7", true],
    ["1.0.0", "v2.0.0", false],
    ["1.0", "2.0", false],
    ["01.0.0", "2.0.0", false],
    ["2026.11", "2027.1", false],
  ])("base %s, head %s covers a breaking change: %s", (base, head, covered) => {
    expect(versionCoversBreaking(base, head)).toBe(covered);
  });

  it("accepts only semver 2.0 MAJOR.MINOR.PATCH with optional pre-release and build", () => {
    expect(parseSemver("1.2.3-alpha.1+build.5")).toEqual({ major: 1n, minor: 2n, patch: 3n });
    for (const version of ["1.2", "1.2.3.4", "v1.2.3", "1.2.3-", "1.2.3-01", "latest", ""]) {
      expect(parseSemver(version)).toBeNull();
    }
  });
});

describe("apifn check: fixtures against a base spec", () => {
  it.each([
    ["base", "base", 0, "pass"],
    ["compatible", "base", 0, "warn"],
    ["breaking", "base", 1, "fail"],
    ["breaking-major", "base", 0, "pass"],
    ["breaking-zero-minor", "base-zero", 0, "pass"],
    ["non-semver", "base", 1, "fail"],
  ] as const)("%s against %s exits %i with verdict %s", async (head, base, exitCode, verdict) => {
    const root = await fixtures();
    await commitSpec(path.join(root, base));
    await commitSpec(path.join(root, head));

    const { code, report } = await runJson(
      ["check", "--base-spec", path.join("..", base, SPEC)],
      path.join(root, head)
    );

    expect(code).toBe(exitCode);
    expect(report.verdict).toBe(verdict);
    expect(report.drift).toBe(false);
    expect(report.valid).toBe(true);
    expect(report.base.status).toBe("compared");
  });

  it("names the versions and the rule when a breaking change is not covered", async () => {
    const root = await fixtures();
    await commitSpec(path.join(root, "base"));
    await commitSpec(path.join(root, "breaking"));
    await commitSpec(path.join(root, "non-semver"));

    const minor = await runJson(["check", "--base-spec", "../base/.apifn/openapi.yml"], path.join(root, "breaking"));
    expect(minor.report.versions).toEqual({ base: "1.0.0", head: "1.1.0" });
    expect(minor.report.breaking.length).toBeGreaterThan(0);
    expect(minor.report.failures.join("\n")).toContain("without a major version bump");

    const unversioned = await runJson(
      ["check", "--base-spec", "../base/.apifn/openapi.yml"],
      path.join(root, "non-semver")
    );
    expect(unversioned.report.versions).toEqual({ base: "1.0.0", head: "2026.11" });
    expect(unversioned.report.failures.join("\n")).toContain("not semver");
  });

  it("warns on a non-breaking change with an unchanged version", async () => {
    const root = await fixtures();
    await commitSpec(path.join(root, "base"));
    await commitSpec(path.join(root, "compatible"));

    const { report } = await runJson(
      ["check", "--base-spec", "../base/.apifn/openapi.yml"],
      path.join(root, "compatible")
    );
    expect(report.breaking).toEqual([]);
    expect(report.diff?.nonBreaking.length).toBeGreaterThan(0);
    expect(report.warnings.join("\n")).toContain("unchanged contract version (1.0.0)");
  });

  it("--allow-breaking passes and still reports the breaking list", async () => {
    const root = await fixtures();
    await commitSpec(path.join(root, "base"));
    await commitSpec(path.join(root, "breaking"));

    const { code, report } = await runJson(
      ["check", "--base-spec", "../base/.apifn/openapi.yml", "--allow-breaking"],
      path.join(root, "breaking")
    );
    expect(code).toBe(0);
    expect(report.verdict).toBe("warn");
    expect(report.breaking.map((entry) => entry.path)).toEqual(["paths./users.get"]);
    expect(report.warnings.join("\n")).toContain("allowed by --allow-breaking");
  });

  it("diff.failOnBreaking: false reports breaking changes without failing", async () => {
    const root = await fixtures();
    const dir = path.join(root, "breaking");
    await commitSpec(path.join(root, "base"));
    await writeFile(
      path.join(dir, "apifn.config.ts"),
      [
        "export default {",
        '  router: "./router.ts",',
        '  openapi: { info: { title: "Check fixture", version: "1.1.0" } },',
        "  diff: { failOnBreaking: false },",
        "};",
        "",
      ].join("\n")
    );
    await commitSpec(dir);

    const { code, report } = await runJson(["check", "--base-spec", "../base/.apifn/openapi.yml"], dir);
    expect(code).toBe(0);
    expect(report.breaking.length).toBeGreaterThan(0);
    expect(report.warnings.join("\n")).toContain("diff.failOnBreaking is false");
  });
});

describe("apifn check: drift and validation", () => {
  it("fails a stale committed spec and --write repairs it", async () => {
    const root = await fixtures();
    const dir = path.join(root, "compatible");
    // The committed spec is the base contract: GET /health is missing from it.
    await mkdir(path.join(dir, ".apifn"), { recursive: true });
    await commitSpec(path.join(root, "base"));
    const stale = await readFile(path.join(root, "base", SPEC), "utf8");
    await writeFile(path.join(dir, SPEC), stale);

    const failed = await runJson(["check"], dir);
    expect(failed.code).toBe(1);
    expect(failed.report).toMatchObject({ drift: true, driftState: "stale", written: false, verdict: "fail" });
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(stale);

    const repaired = await runJson(["check", "--write"], dir);
    expect(repaired.code).toBe(0);
    expect(repaired.report).toMatchObject({ drift: true, written: true, verdict: "warn" });

    const generated = path.join(await tempDir("apifn-check-gen-"), "openapi.yml");
    expect((await run(["generate", "--output", generated], dir)).code).toBe(0);
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(await readFile(generated, "utf8"));

    const clean = await runJson(["check"], dir);
    expect(clean.code).toBe(0);
    expect(clean.report).toMatchObject({ drift: false, driftState: "none", verdict: "pass" });
  });

  it("a missing committed spec is drift; --write creates it", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");

    const missing = await runJson(["check"], dir);
    expect(missing.code).toBe(1);
    expect(missing.report.driftState).toBe("missing");

    expect((await runJson(["check", "--write"], dir)).code).toBe(0);
    expect((await runJson(["check"], dir)).report.verdict).toBe("pass");
  });

  it("compares canonical JSON: a JSON spec with other key order and formatting is not drift", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const doc = parseYaml(await readFile(path.join(dir, SPEC), "utf8")) as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(doc).reverse());
    await writeFile(path.join(dir, "openapi.json"), JSON.stringify(reordered));

    const { code, report } = await runJson(["check", "--spec", "openapi.json"], dir);
    expect(code).toBe(0);
    expect(report.drift).toBe(false);
  });

  it("a changed value in the committed spec is drift", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const doc = parseYaml(await readFile(path.join(dir, SPEC), "utf8")) as { info: { title: string } };
    doc.info.title = "Edited by hand";
    await writeFile(path.join(dir, SPEC), toYaml(doc));

    const { code, report } = await runJson(["check"], dir);
    expect(code).toBe(1);
    expect(report.driftState).toBe("stale");
  });

  it("--write keeps a .json spec in JSON", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const generated = parseYaml(await readFile(path.join(dir, SPEC), "utf8"));

    const written = await runJson(["check", "--spec", "openapi.json", "--write"], dir);
    expect(written.code).toBe(0);
    expect(written.report.written).toBe(true);
    const raw = await readFile(path.join(dir, "openapi.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(generated);
    expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);

    expect((await runJson(["check", "--spec", "openapi.json"], dir)).report.drift).toBe(false);
  });

  it("an own __proto__ key counts in canonical JSON and in drift", async () => {
    const withProto = JSON.parse('{"a":1,"__proto__":{"x":1}}');
    expect(canonicalJson(withProto)).toBe('{"__proto__":{"x":1},"a":1}');
    expect(canonicalJson(withProto)).not.toBe(canonicalJson({ a: 1 }));

    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const spec = await readFile(path.join(dir, SPEC), "utf8");
    await writeFile(path.join(dir, SPEC), `${spec}__proto__:\n  x: 1\n`);

    const { code, report } = await runJson(["check"], dir);
    expect(code).toBe(1);
    expect(report.driftState).toBe("stale");
  });

  it("an invalid spec exits 1 with its validation errors", async () => {
    const root = await fixtures();
    const dir = path.join(root, "invalid");
    await commitSpec(dir);

    const { code, report } = await runJson(["check"], dir);
    expect(code).toBe(1);
    expect(report.drift).toBe(false);
    expect(report.valid).toBe(false);
    expect(report.validationErrors.length).toBeGreaterThan(0);
    expect(report.failures.join("\n")).toContain("Generated spec is invalid");
  });

  it("an invalid spec the differ cannot read still exits 1 with its validation errors", async () => {
    const root = await fixtures();
    await commitSpec(path.join(root, "base"));
    const dir = path.join(root, "invalid-diff");
    await commitSpec(dir);

    const { code, report } = await runJson(
      ["check", "--base-spec", path.join("..", "base", SPEC)],
      dir
    );
    expect(code).toBe(1);
    expect(report.valid).toBe(false);
    expect(report.validationErrors.length).toBeGreaterThan(0);
    expect(report.diff).toBeNull();
    expect(report.base.status).toBe("skipped");
    expect(report.failures.join("\n")).toContain("Diff against the base skipped");
  });
});

describe("apifn check: --base <git-ref>", () => {
  async function repo(): Promise<{ root: string; service: string }> {
    const root = await fixtures();
    git(root, "init", "-q");
    // The spec lives below the repository root, so the path git is asked for is not cwd-relative.
    const service = path.join(root, "breaking");
    return { root, service };
  }

  it("diffs against the spec committed at the ref", async () => {
    const { root, service } = await repo();
    // Commit the base contract's spec at the service's spec path.
    await mkdir(path.join(service, ".apifn"), { recursive: true });
    await commitSpec(path.join(root, "base"));
    await writeFile(path.join(service, SPEC), await readFile(path.join(root, "base", SPEC), "utf8"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base contract");
    await commitSpec(service);

    const failed = await runJson(["check", "--base", "HEAD"], service);
    expect(failed.code).toBe(1);
    expect(failed.report.base).toEqual({ source: "git", ref: "HEAD", status: "compared" });
    expect(failed.report.versions).toEqual({ base: "1.0.0", head: "1.1.0" });
    expect(failed.report.breaking.length).toBeGreaterThan(0);

    const allowed = await runJson(["check", "--base", "HEAD", "--allow-breaking"], service);
    expect(allowed.code).toBe(0);
  });

  it("reports a new contract when the ref has no spec at that path", async () => {
    const { root, service } = await repo();
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "routers only");
    await commitSpec(service);

    const { code, report } = await runJson(["check", "--base", "HEAD"], service);
    expect(code).toBe(0);
    expect(report.base).toEqual({ source: "git", ref: "HEAD", status: "new-contract" });
    expect(report.diff).toBeNull();
    expect(report.versions).toEqual({ base: null, head: "1.1.0" });
  });

  it("a git failure reading the base spec exits 2 instead of reporting a new contract", async () => {
    const { root, service } = await repo();
    await mkdir(path.join(service, ".apifn"), { recursive: true });
    await commitSpec(path.join(root, "base"));
    await writeFile(path.join(service, SPEC), await readFile(path.join(root, "base", SPEC), "utf8"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base contract");
    await commitSpec(service);
    // The tree still lists the spec, but its blob is gone: git cannot read it.
    const blob = git(root, "rev-parse", "HEAD:breaking/.apifn/openapi.yml").trim();
    await rm(path.join(root, ".git", "objects", blob.slice(0, 2), blob.slice(2)), { force: true });

    const result = await run(["check", "--base", "HEAD", "--format", "json"], service);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("git cat-file blob");
    expect(result.stdout).toBe("");
  });

  it("a ref that looks like a number is passed to git literally", async () => {
    const { root, service } = await repo();
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "routers only");
    git(root, "tag", "0123");
    await commitSpec(service);

    const { code, report } = await runJson(["check", "--base", "0123"], service);
    expect(code).toBe(0);
    expect(report.base).toEqual({ source: "git", ref: "0123", status: "new-contract" });
  });

  it("an unknown ref exits 2", async () => {
    const { root, service } = await repo();
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "routers only");
    await commitSpec(service);

    const result = await run(["check", "--base", "no-such-ref"], service);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown git ref 'no-such-ref'");
    expect(result.stdout).toBe("");
  });

  it("outside a git work tree exits 2", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const result = await run(["check", "--base", "HEAD"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("git work tree");
  });

  /** Commits the base contract's spec at breaking/.apifn/openapi.yml, then regenerates the head. */
  async function trackedBaseSpec(): Promise<{ root: string; service: string }> {
    const { root, service } = await repo();
    await mkdir(path.join(service, ".apifn"), { recursive: true });
    await commitSpec(path.join(root, "base"));
    await writeFile(path.join(service, SPEC), await readFile(path.join(root, "base", SPEC), "utf8"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base contract");
    await commitSpec(service);
    return { root, service };
  }

  it("a --spec symlink to the tracked spec is diffed against it, not a new contract", async () => {
    const { service } = await trackedBaseSpec();
    await symlink(SPEC, path.join(service, "contract.yml"));

    const { code, report } = await runJson(["check", "--spec", "contract.yml", "--base", "HEAD"], service);
    expect(report.base).toEqual({ source: "git", ref: "HEAD", status: "compared" });
    expect(report.breaking.length).toBeGreaterThan(0);
    expect(code).toBe(1);
  });

  it.skipIf(!CASE_INSENSITIVE_FS)(
    "a case alias of the tracked spec is diffed against it (case-insensitive filesystem)",
    async () => {
      const { service } = await trackedBaseSpec();
      const { code, report } = await runJson(
        ["check", "--spec", path.join(".APIFN", "OpenAPI.yml"), "--base", "HEAD"],
        service
      );
      expect(report.base).toEqual({ source: "git", ref: "HEAD", status: "compared" });
      expect(report.breaking.length).toBeGreaterThan(0);
      expect(code).toBe(1);
    }
  );

  it("a dangling --spec symlink to the deleted tracked spec is diffed against it, even with --write", async () => {
    const { service } = await trackedBaseSpec();
    await rm(path.join(service, SPEC));
    await symlink(SPEC, path.join(service, "contract.yml"));

    const { code, report } = await runJson(
      ["check", "--spec", "contract.yml", "--base", "HEAD", "--write"],
      service
    );
    expect(report.base).toEqual({ source: "git", ref: "HEAD", status: "compared" });
    expect(report.breaking.length).toBeGreaterThan(0);
    expect(report.written).toBe(true);
    expect(code).toBe(1);
  });

  it.skipIf(!CASE_INSENSITIVE_FS)(
    "a case-only rename on disk is diffed against the old tracked name (case-insensitive filesystem)",
    async () => {
      const { service } = await trackedBaseSpec();
      const renamed = path.join(".apifn", "OpenAPI.yml");
      await rename(path.join(service, SPEC), path.join(service, renamed));

      const { code, report } = await runJson(["check", "--spec", renamed, "--base", "HEAD"], service);
      expect(report.base).toEqual({ source: "git", ref: "HEAD", status: "compared" });
      expect(report.breaking.length).toBeGreaterThan(0);
      expect(code).toBe(1);
    }
  );

  /** Moves the tracked spec directory and leaves a symlink at its old name, as `git mv` plus `ln -s` would. */
  async function symlinkedSpecDir(service: string): Promise<void> {
    await rename(path.join(service, ".apifn"), path.join(service, "contracts"));
    await symlink("contracts", path.join(service, ".apifn"));
  }

  it("a spec under a symlinked directory is diffed against the path as given, not a new contract", async () => {
    const { service } = await trackedBaseSpec();
    await symlinkedSpecDir(service);

    const { code, report } = await runJson(["check", "--base", "HEAD"], service);
    expect(report.base).toEqual({ source: "git", ref: "HEAD", status: "compared" });
    expect(report.breaking.map((change) => change.path)).toContain("paths./users.get");
    expect(code).toBe(1);
  });

  it("a stale spec under a symlinked directory is repaired with --write and still fails the breaking change", async () => {
    const { root, service } = await trackedBaseSpec();
    await symlinkedSpecDir(service);
    await writeFile(path.join(service, SPEC), await readFile(path.join(root, "base", SPEC), "utf8"));

    const { code, report } = await runJson(["check", "--base", "HEAD", "--write"], service);
    expect(report.drift).toBe(true);
    expect(report.written).toBe(true);
    expect(report.base).toEqual({ source: "git", ref: "HEAD", status: "compared" });
    expect(report.breaking.map((change) => change.path)).toContain("paths./users.get");
    expect(code).toBe(1);
  });

  it("a --spec symlink that resolves outside the repository exits 2", async () => {
    const { service } = await trackedBaseSpec();
    const outside = path.join(await tempDir("apifn-check-outside-"), "openapi.yml");
    await writeFile(outside, await readFile(path.join(service, SPEC), "utf8"));
    await symlink(outside, path.join(service, "contract.yml"));

    const result = await run(["check", "--spec", "contract.yml", "--base", "HEAD"], service);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("outside the git repository");
    expect(result.stdout).toBe("");
  });
});

describe("apifn check: documents without a faithful JSON form", () => {
  /** A router whose generated spec holds a null (a schema default). */
  async function nullDefaultService(): Promise<string> {
    const dir = await tempDir("apifn-check-null-");
    await writeFile(
      path.join(dir, "router.ts"),
      `export default {
  getRoutes() {
    return [
      {
        method: "GET",
        path: "/notes",
        handler: async () => Response.json({}),
        meta: {
          operationId: "getNotes",
          responses: {
            200: {
              description: "ok",
              schema: { type: "object", properties: { note: { type: ["string", "null"], default: null } } },
            },
          },
        },
      },
    ];
  },
};
`
    );
    await writeFile(
      path.join(dir, "apifn.config.ts"),
      `export default { router: "./router.ts", openapi: { info: { title: "Nulls", version: "1.0.0" } } };\n`
    );
    await commitSpec(dir);
    return dir;
  }

  async function variants(dir: string): Promise<Array<[string, string]>> {
    const generated = await readFile(path.join(dir, SPEC), "utf8");
    expect(generated).toContain("default: null");
    // .nan, .inf and -.inf parse to numbers JSON.stringify writes as null.
    const nan = generated.replace("default: null", "default: .nan");
    // 200 and "200" are distinct YAML keys that become one JSON key; the second would hide the first.
    const collision = generated.replace(
      /^( +)"200":\n/m,
      (line, indent: string) => `${indent}200:\n${indent}  description: hidden\n${line}`
    );
    expect(collision).not.toBe(generated);
    return [
      [".nan in place of null", nan],
      ["keys 200 and \"200\" in one mapping", collision],
    ];
  }

  it("a committed spec is drift (unparseable, exit 1), never a clean comparison", async () => {
    const dir = await nullDefaultService();
    expect((await runJson(["check"], dir)).report.drift).toBe(false);
    for (const [label, text] of await variants(dir)) {
      await writeFile(path.join(dir, SPEC), text);
      const { code, report } = await runJson(["check"], dir);
      expect({ label, code, drift: report.drift, driftState: report.driftState }).toEqual({
        label,
        code: 1,
        drift: true,
        driftState: "unparseable",
      });
    }
  });

  it("a base spec is a load error (exit 2)", async () => {
    const dir = await nullDefaultService();
    for (const [label, text] of await variants(dir)) {
      await writeFile(path.join(dir, "base.yml"), text);
      const result = await run(["check", "--base-spec", "base.yml"], dir);
      expect({ label, code: result.code, stdout: result.stdout }).toEqual({ label, code: 2, stdout: "" });
      expect(result.stderr).toContain("JSON");
    }
  });

  it("a JSON base spec with a duplicate key is a load error (exit 2), not its last value", async () => {
    const root = await fixtures();
    await commitSpec(path.join(root, "base"));
    const dir = path.join(root, "breaking");
    await commitSpec(dir);
    const base = parseYaml(await readFile(path.join(root, "base", SPEC), "utf8")) as Record<string, unknown>;
    // JSON.parse keeps the last "paths", so the removed endpoints would never be diffed.
    await writeFile(path.join(dir, "base.json"), `${JSON.stringify(base).slice(0, -1)},"paths":{}}`);

    const result = await run(["check", "--base-spec", "base.json"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('two keys that are both "paths"');
    expect(result.stdout).toBe("");
  });

  it("an alias mapping key that repeats a literal key is drift as the committed spec and a load error as the base", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const generated = await readFile(path.join(dir, SPEC), "utf8");
    // The alias key *k resolves to "description"; the literal key after it would silently win.
    let seen = 0;
    const aliased = generated.replace(/^( +)description: /gm, (line, indent: string) => {
      seen += 1;
      if (seen === 1) return `${indent}&k description: `;
      if (seen === 2) return `${indent}*k : hidden\n${line}`;
      return line;
    });
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(parseYaml(aliased)).toEqual(parseYaml(generated));

    await writeFile(path.join(dir, SPEC), aliased);
    const committed = await runJson(["check"], dir);
    expect({ code: committed.code, driftState: committed.report.driftState }).toEqual({
      code: 1,
      driftState: "unparseable",
    });

    await writeFile(path.join(dir, "base.yml"), aliased);
    await writeFile(path.join(dir, SPEC), generated);
    const result = await run(["check", "--base-spec", "base.yml"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("alias *k");
    expect(result.stdout).toBe("");
  });

  it("a JSON base spec with an overflowing number is a load error (exit 2)", async () => {
    const dir = await nullDefaultService();
    const doc = parseYaml(await readFile(path.join(dir, SPEC), "utf8")) as Record<string, unknown>;
    await writeFile(path.join(dir, "base.json"), JSON.stringify({ ...doc, "x-big": 0 }).replace('"x-big":0', '"x-big":1e999'));
    const result = await run(["check", "--base-spec", "base.json"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Infinity");
  });
});

describe("apifn check: usage and load errors", () => {
  it("a missing router exits 2", async () => {
    const root = await fixtures();
    const result = await run(["check", "no-such-router.ts"], path.join(root, "base"));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Failed to generate the spec from the router");
    expect(result.stdout).toBe("");
  });

  it("no router argument or config.router exits 2", async () => {
    const dir = await tempDir("apifn-check-empty-");
    const result = await run(["check"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Router path is required");
  });

  it("a missing --base-spec file exits 2", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const result = await run(["check", "--base-spec", "missing.yml"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Failed to load base spec 'missing.yml'");
  });

  it("--base with --base-spec, or an unknown --format, exits 2", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    expect((await run(["check", "--base", "HEAD", "--base-spec", SPEC], dir)).code).toBe(2);
    const badFormat = await run(["check", "--format", "xml"], dir);
    expect(badFormat.code).toBe(2);
    expect(badFormat.stderr).toContain("Unknown --format 'xml'");
  });

  it.each([
    [["--bogus"]],
    [["--base"]],
    [["--format"]],
    [["--spec"]],
  ])("a parse error (%j) exits 2 with no report", async (args) => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const result = await run(["check", ...args], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toBe("");
    expect(result.stdout).toBe("");
  });

  it("other commands keep exit 1 for a parse error", async () => {
    const root = await fixtures();
    expect((await run(["generate", "--bogus"], path.join(root, "base"))).code).toBe(1);
  });

  it("a --base-spec path that looks like a number is read literally", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    await writeFile(path.join(dir, "1.10"), await readFile(path.join(dir, SPEC), "utf8"));

    const { code, report } = await runJson(["check", "--base-spec", "1.10"], dir);
    expect(code).toBe(0);
    expect(report.base).toEqual({ source: "file", ref: "1.10", status: "compared" });
  });

  it.each([SPEC, `./.apifn/../${SPEC}`])(
    "--report naming the spec (%s) exits 2 and writes nothing",
    async (reportPath) => {
      const root = await fixtures();
      const dir = path.join(root, "compatible");
      await mkdir(path.join(dir, ".apifn"), { recursive: true });
      await writeFile(path.join(dir, SPEC), "openapi: 3.1.0\n");
      const result = await run(["check", "--write", "--report", reportPath], dir);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("is the spec itself");
      expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
    }
  );

  it("a load error with --write leaves the committed spec untouched", async () => {
    const root = await fixtures();
    const dir = path.join(root, "compatible");
    await mkdir(path.join(dir, ".apifn"), { recursive: true });
    await writeFile(path.join(dir, SPEC), "openapi: 3.1.0\n");
    const result = await run(["check", "--write", "--base-spec", "missing.yml"], dir);
    expect(result.code).toBe(2);
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
  });

  it.each([
    ["a stale committed spec", "openapi: 3.1.0\n"],
    ["a missing committed spec", null],
  ])(
    "a base spec the validator rejects exits 2 with --write and leaves %s untouched",
    async (_label, committed) => {
      const root = await fixtures();
      // The base parses (its openapi version is valid) but has `security: [null]` on GET
      // /users/{id}; the validator rejects it before the differ (which would throw) sees it.
      const baseSpec = path.join(await tempDir("apifn-check-base-"), "openapi.yml");
      expect((await run(["generate", "--output", baseSpec], path.join(root, "invalid-diff"))).code).toBe(0);
      const dir = path.join(root, "base");
      if (committed !== null) {
        await mkdir(path.join(dir, ".apifn"), { recursive: true });
        await writeFile(path.join(dir, SPEC), committed);
      }

      const result = await run(["check", "--write", "--base-spec", baseSpec, "--format", "json"], dir);
      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("is invalid");
      if (committed === null) {
        expect(existsSync(path.join(dir, SPEC))).toBe(false);
      } else {
        expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(committed);
      }
    }
  );

  it.each([
    ["a stale committed spec", "openapi: 3.1.0\n"],
    ["a missing committed spec", null],
  ])("a report that cannot be written exits 2 with --write and leaves %s untouched", async (_label, committed) => {
    const root = await fixtures();
    const dir = path.join(root, "compatible");
    if (committed !== null) {
      await mkdir(path.join(dir, ".apifn"), { recursive: true });
      await writeFile(path.join(dir, SPEC), committed);
    }
    // The report's parent directory is a regular file, so the report write fails.
    await writeFile(path.join(dir, "not-a-dir"), "x");

    const result = await run(["check", "--write", "--report", path.join("not-a-dir", "report.md")], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Failed to write report");
    if (committed === null) {
      expect(existsSync(path.join(dir, SPEC))).toBe(false);
    } else {
      expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(committed);
    }
  });
});

describe("apifn check: report formats", () => {
  async function breakingCase(): Promise<string> {
    const root = await fixtures();
    await commitSpec(path.join(root, "base"));
    const dir = path.join(root, "breaking");
    await commitSpec(dir);
    return dir;
  }

  it.each(["text", "json", "markdown"])("%s report", async (format) => {
    const dir = await breakingCase();
    const result = await run(
      ["check", "--base-spec", "../base/.apifn/openapi.yml", "--format", format],
      dir
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatchSnapshot();
  });

  it("the Markdown report starts with the CI comment marker", async () => {
    const dir = await breakingCase();
    const result = await run(
      ["check", "--base-spec", "../base/.apifn/openapi.yml", "--format", "markdown"],
      dir
    );
    expect(result.stdout.startsWith(`${CHECK_REPORT_MARKER}\n`)).toBe(true);
  });

  it("--report writes the same report to a file", async () => {
    const dir = await breakingCase();
    const result = await run(
      [
        "check",
        "--base-spec",
        "../base/.apifn/openapi.yml",
        "--format",
        "markdown",
        "--report",
        "out/report.md",
      ],
      dir
    );
    expect(result.code).toBe(1);
    expect(await readFile(path.join(dir, "out", "report.md"), "utf8")).toBe(result.stdout);
  });
});

describe("apifn check: YAML aliases", () => {
  /** A router whose 120 routes share one security array, so `apifn generate` writes 119 aliases. */
  async function sharedSecurityService(): Promise<string> {
    const dir = await tempDir("apifn-check-aliases-");
    const routes = Array.from(
      { length: 120 },
      (_, i) => `    {
      method: "GET",
      path: "/items${i}",
      handler: async () => Response.json({}),
      meta: { operationId: "getItems${i}", security: SHARED, responses: { 200: { description: "ok" } } },
    },`
    ).join("\n");
    await writeFile(
      path.join(dir, "router.ts"),
      `const SHARED = [{ bearerAuth: [] }];\nexport default {\n  getRoutes() {\n    return [\n${routes}\n    ];\n  },\n};\n`
    );
    await writeFile(
      path.join(dir, "apifn.config.ts"),
      `export default { router: "./router.ts", openapi: { info: { title: "Aliases", version: "1.0.0" } } };\n`
    );
    await commitSpec(dir);
    return dir;
  }

  /**
   * `apifn generate` copies every object (core sortObjectDeep), so its own YAML has no aliases;
   * a YAML tool that re-serializes the spec, or another generator, shares the equal security
   * arrays as one anchor and 119 aliases, past the yaml package's default limit of 100.
   */
  async function aliasedSpec(dir: string): Promise<string> {
    const doc = parseYaml(await readFile(path.join(dir, SPEC), "utf8")) as {
      paths: Record<string, { get: { security: unknown } }>;
    };
    const shared = [{ bearerAuth: [] }];
    for (const item of Object.values(doc.paths)) item.get.security = shared;
    const text = toYaml(doc);
    expect(text.match(/\*a\d+/g)?.length ?? 0).toBeGreaterThan(100);
    expect(() => parseYaml(text)).toThrow(/alias/i);
    return text;
  }

  it("a spec apifn generate wrote for a router sharing one security constant checks clean", async () => {
    const dir = await sharedSecurityService();
    const { code, report } = await runJson(["check"], dir);
    expect(code).toBe(0);
    expect(report.drift).toBe(false);
  });

  it("a committed spec with more than 100 aliases is compared by value, not rejected", async () => {
    const dir = await sharedSecurityService();
    await writeFile(path.join(dir, SPEC), await aliasedSpec(dir));
    const { code, report } = await runJson(["check"], dir);
    expect(code).toBe(0);
    expect(report.drift).toBe(false);
  });

  it("a base spec with more than 100 aliases is diffed, from a file and from git", async () => {
    const dir = await sharedSecurityService();
    await writeFile(path.join(dir, "base.yml"), await aliasedSpec(dir));
    const asBase = await runJson(["check", "--base-spec", "base.yml"], dir);
    expect(asBase.code).toBe(0);
    expect(asBase.report.base.status).toBe("compared");
    expect(asBase.report.diff?.breaking).toEqual([]);
    expect(asBase.report.diff?.nonBreaking).toEqual([]);

    git(dir, "init", "-q");
    await writeFile(path.join(dir, SPEC), await readFile(path.join(dir, "base.yml"), "utf8"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "contract");
    await commitSpec(dir);
    const asGitBase = await runJson(["check", "--base", "HEAD"], dir);
    expect(asGitBase.code).toBe(0);
    expect(asGitBase.report.base.status).toBe("compared");
    expect(asGitBase.report.diff?.breaking).toEqual([]);
    expect(asGitBase.report.diff?.nonBreaking).toEqual([]);
  });

  /** 10 aliases per level over 8 levels: about 10^8 nodes once expanded. */
  const ALIAS_BOMB = [
    "openapi: 3.1.0",
    "a0: &a0 [x, x, x, x, x, x, x, x, x, x]",
    ...Array.from(
      { length: 7 },
      (_, i) => `a${i + 1}: &a${i + 1} [${Array(10).fill(`*a${i}`).join(", ")}]`
    ),
  ].join("\n");

  it("a committed spec that expands past the limit is drift, not a hang", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"), { recursive: true });
    await writeFile(path.join(dir, SPEC), ALIAS_BOMB);
    const { code, report } = await runJson(["check"], dir);
    expect(code).toBe(1);
    expect(report.driftState).toBe("unparseable");
  });

  it("a committed spec whose aliases form a cycle is drift", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"), { recursive: true });
    await writeFile(path.join(dir, SPEC), "openapi: 3.1.0\nloop: &loop\n  self: *loop\n");
    const { code, report } = await runJson(["check"], dir);
    expect(code).toBe(1);
    expect(report.driftState).toBe("unparseable");
  });

  it("a base spec that expands past the limit is a load error", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    await writeFile(path.join(dir, "bomb.yml"), ALIAS_BOMB);
    const result = await run(["check", "--base-spec", "bomb.yml"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("expand to");
    expect(result.stdout).toBe("");
  });
});

describe("apifn check: argument grammar", () => {
  it.each([
    [["./router.ts", "HEAD"]],
    [["--allow-breaking="]],
    [["--allow-breaking=false"]],
    [["--write=false"]],
    [["--", "./router.ts"]],
    [["./router.ts", "--", "extra"]],
    [["--base-spec", "a.yml", "--base-spec", "b.yml"]],
    [["-x"]],
  ])("%j exits 2 with no report and no write", async (args) => {
    const root = await fixtures();
    const dir = path.join(root, "breaking");
    await mkdir(path.join(dir, ".apifn"), { recursive: true });
    await writeFile(path.join(dir, SPEC), "openapi: 3.1.0\n");
    const result = await run(["check", "--write", ...args], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).not.toBe("");
    expect(result.stdout).toBe("");
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
  });

  it("a router path that looks like a number is read literally", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    await mkdir(path.join(dir, "1.10"));
    await cp(path.join(dir, "router.ts"), path.join(dir, "1.10", "index.ts"));
    const { code, report } = await runJson(["check", "1.10"], dir);
    expect(code).toBe(0);
    expect(report.drift).toBe(false);
  });

  it("global options and the declared options in any order still parse", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const result = await run(
      ["--quiet", "check", "--format=json", "./router.ts", "--config", "apifn.config.ts", "--allow-breaking"],
      dir
    );
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout) as CheckReport).verdict).toBe("pass");
  });
});

describe("apifn check: --report never writes the spec", () => {
  async function missingSpec(): Promise<string> {
    const root = await fixtures();
    return path.join(root, "compatible");
  }

  async function expectRejected(dir: string, reportPath: string): Promise<void> {
    const result = await run(["check", "--write", "--report", reportPath], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("is the spec itself");
    await expect(access(path.join(dir, SPEC))).rejects.toThrow();
  }

  it("through a symlinked directory while the spec does not exist yet", async () => {
    const dir = await missingSpec();
    await mkdir(path.join(dir, ".apifn"));
    await symlink(".apifn", path.join(dir, "alias"));
    await expectRejected(dir, "alias/openapi.yml");
  });

  it("through a dangling directory symlink whose target --write would create", async () => {
    const dir = await missingSpec();
    await symlink(".apifn", path.join(dir, "alias"));
    await expectRejected(dir, "alias/openapi.yml");
  });

  it("through a dangling report symlink that points at the missing spec", async () => {
    const dir = await missingSpec();
    await mkdir(path.join(dir, ".apifn"));
    await symlink(path.join(".apifn", "openapi.yml"), path.join(dir, "report.md"));
    await expectRejected(dir, "report.md");
  });

  it("through a case alias of the missing spec where the filesystem folds case; a distinct file elsewhere", async () => {
    const dir = await missingSpec();
    // The destination directory exists, so the probe can judge the two spellings there.
    await mkdir(path.join(dir, ".apifn"));
    const report = path.join(".apifn", "OpenAPI.yml");
    if (CASE_INSENSITIVE_FS) {
      await expectRejected(dir, report);
      return;
    }
    // A case-sensitive filesystem keeps the two names apart: both files are written.
    const result = await run(["check", "--write", "--report", report], dir);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(dir, report), "utf8")).toBe(result.stdout);
    expect(parseYaml(await readFile(path.join(dir, SPEC), "utf8"))).toHaveProperty("openapi");
  });

  it("a report beside the spec is written normally", async () => {
    const dir = await missingSpec();
    const result = await run(["check", "--write", "--report", ".apifn/report.txt"], dir);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(dir, ".apifn", "report.txt"), "utf8")).toBe(result.stdout);
    expect(parseYaml(await readFile(path.join(dir, SPEC), "utf8"))).toHaveProperty("openapi");
  });
});

describe("apifn check: no write lands on the base spec", () => {
  /** The breaking service with the base contract's spec committed (stale) and kept as base.yml. */
  async function staleService(): Promise<{ dir: string; baseText: string }> {
    const root = await fixtures();
    await commitSpec(path.join(root, "base"));
    const dir = path.join(root, "breaking");
    const baseText = await readFile(path.join(root, "base", SPEC), "utf8");
    await mkdir(path.join(dir, ".apifn"), { recursive: true });
    await writeFile(path.join(dir, SPEC), baseText);
    await writeFile(path.join(dir, "base.yml"), baseText);
    return { dir, baseText };
  }

  it("--write with --base-spec naming the spec exits 2 and leaves it unchanged", async () => {
    const { dir, baseText } = await staleService();
    // The case alias names the spec only where the filesystem folds case.
    for (const baseSpec of CASE_INSENSITIVE_FS ? [SPEC, path.join(".apifn", "OpenAPI.yml")] : [SPEC]) {
      const result = await run(["check", "--write", "--base-spec", baseSpec], dir);
      expect({ baseSpec, code: result.code, stdout: result.stdout }).toEqual({ baseSpec, code: 2, stdout: "" });
      expect(result.stderr).toContain("--base-spec");
      expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(baseText);
    }
  });

  it("--report naming the --base-spec file exits 2 and leaves it unchanged", async () => {
    const { dir, baseText } = await staleService();
    for (const report of CASE_INSENSITIVE_FS ? ["base.yml", "BASE.yml", "./out/../base.yml"] : ["base.yml", "./out/../base.yml"]) {
      const result = await run(["check", "--base-spec", "base.yml", "--report", report], dir);
      expect({ report, code: result.code, stdout: result.stdout }).toEqual({ report, code: 2, stdout: "" });
      expect(result.stderr).toContain("--base-spec");
      expect(await readFile(path.join(dir, "base.yml"), "utf8")).toBe(baseText);
    }
  });

  it("--write with a base spec elsewhere still repairs the spec", async () => {
    const { dir } = await staleService();
    const result = await run(["check", "--write", "--base-spec", "base.yml", "--report", "report.txt"], dir);
    expect(result.code).toBe(1);
    expect(await readFile(path.join(dir, "report.txt"), "utf8")).toBe(result.stdout);
    expect(await readFile(path.join(dir, SPEC), "utf8")).not.toBe(await readFile(path.join(dir, "base.yml"), "utf8"));
  });
});

// ---------------------------------------------------------------------------
// PR #410 reset: baseline identity, validated comparison, faithful bounded parsing and safe
// publication. Each test below failed at 867eb7a5f.
// ---------------------------------------------------------------------------

const POSIX_ONLY = process.platform === "win32";
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

/** An executable shell script, used as a stand-in git. */
async function shellScript(file: string, body: string): Promise<void> {
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, 0o755);
}

function realGit(): string {
  return execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
}

async function withEnv<T>(name: string, value: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/** Files a failed publication could leave behind (temp files and backups). */
async function leftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.includes(".apifn-"));
}

describe("apifn check: the git baseline is resolved in the pinned commit", () => {
  /** breaking/ tracks the base contract as .apifn/OpenAPI.yml; the working tree renames it by case. */
  async function caseRenamed(): Promise<{ root: string; service: string }> {
    const root = await fixtures();
    git(root, "init", "-q");
    const service = path.join(root, "breaking");
    await commitSpec(path.join(root, "base"));
    await mkdir(path.join(service, ".apifn"), { recursive: true });
    await writeFile(path.join(service, ".apifn", "OpenAPI.yml"), await readFile(path.join(root, "base", SPEC), "utf8"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base contract");
    await rm(path.join(service, ".apifn", "OpenAPI.yml"));
    await commitSpec(service);
    return { root, service };
  }

  it.skipIf(POSIX_ONLY)("a git that fails the core.ignorecase query exits 2, never a new contract", async () => {
    const { service } = await caseRenamed();
    const shim = path.join(await tempDir("apifn-check-git-"), "git");
    await shellScript(
      shim,
      `case "$*" in *core.ignorecase*) echo "error: config unavailable" >&2; exit 1;; esac\nexec '${realGit()}' "$@"`
    );

    const failed = await withEnv("APIFN_GIT", shim, () => run(["check", "--base", "HEAD", "--format", "json"], service));
    expect(failed.code).toBe(2);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("core.ignorecase");

    // With a working git the lookup completes: the old spelling on a case-insensitive
    // repository, a new contract where case matters.
    const { code, report } = await runJson(["check", "--base", "HEAD"], service);
    if (CASE_INSENSITIVE_FS) {
      expect({ code, status: report.base.status }).toEqual({ code: 1, status: "compared" });
      expect(report.breaking.length).toBeGreaterThan(0);
    } else {
      expect({ code, status: report.base.status }).toEqual({ code: 0, status: "new-contract" });
    }
  });

  it.skipIf(POSIX_ONLY)("a git found first on PATH is never run", async () => {
    const { service } = await caseRenamed();
    const bin = await tempDir("apifn-check-path-");
    const marker = path.join(bin, "ran");
    await shellScript(path.join(bin, "git"), `touch '${marker}'\nexec '${realGit()}' "$@"`);

    const result = await withEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`, () =>
      run(["check", "--base", "HEAD", "--format", "json"], service)
    );
    expect(result.code).not.toBe(2);
    expect(existsSync(marker)).toBe(false);
  });

  it("APIFN_GIT must be an absolute path to an executable", async () => {
    const { service } = await caseRenamed();
    const result = await withEnv("APIFN_GIT", "git", () => run(["check", "--base", "HEAD"], service));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("APIFN_GIT");
  });

  it("a tracked spec symlink retargeted in the working tree is diffed against its target at the base", async () => {
    const root = await fixtures();
    git(root, "init", "-q");
    const service = path.join(root, "breaking");
    await commitSpec(path.join(root, "base"));
    await commitSpec(service);
    await mkdir(path.join(service, "contracts"));
    await writeFile(path.join(service, "contracts", "a.yml"), await readFile(path.join(root, "base", SPEC), "utf8"));
    await writeFile(path.join(service, "contracts", "b.yml"), await readFile(path.join(service, SPEC), "utf8"));
    await rm(path.join(service, SPEC));
    await symlink(path.join("..", "contracts", "a.yml"), path.join(service, SPEC));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "spec links to a.yml");
    await rm(path.join(service, SPEC));
    await symlink(path.join("..", "contracts", "b.yml"), path.join(service, SPEC));

    const { code, report } = await runJson(["check", "--base", "HEAD"], service);
    expect(report.base).toEqual({ source: "git", ref: "HEAD", status: "compared" });
    expect(report.versions).toEqual({ base: "1.0.0", head: "1.1.0" });
    expect(report.breaking.length).toBeGreaterThan(0);
    expect(code).toBe(1);
  });

  it("a base spec at the ref that expands past the budget is a load error", async () => {
    const root = await fixtures();
    git(root, "init", "-q");
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"));
    await writeFile(path.join(dir, SPEC), aliasBomb());
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "bomb");
    await commitSpec(dir);
    const result = await run(["check", "--base", "HEAD"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("expand to");
  });
});

/** A valid spec whose aliases share one 300 KB scalar 300 times (90 MB expanded). */
function aliasBomb(): string {
  const lines = [
    "openapi: 3.1.0",
    "info: { title: Check fixture, version: 0.9.0 }",
    `x-big: &b "${"x".repeat(300_000)}"`,
    "x-copies:",
    ...Array.from({ length: 300 }, () => "  - *b"),
    "paths: {}",
  ];
  return `${lines.join("\n")}\n`;
}

describe("apifn check: the base is validated and both sides are dereferenced", () => {
  /** POST /users takes the schema of GET /users' response through a local $ref. */
  async function refService(options: { required: boolean; version?: string; inline?: boolean }): Promise<string> {
    const dir = await tempDir("apifn-check-ref-");
    const schema = `{ type: "object", properties: { name: { type: "string" } }${options.required ? ', required: ["name"]' : ""} }`;
    const response = options.inline ? '{ type: "object" }' : schema;
    const body = options.inline
      ? schema
      : `{ $ref: "#/paths/~1users/get/responses/200/content/application~1json/schema" }`;
    await writeFile(
      path.join(dir, "router.ts"),
      `export default { getRoutes() { return [
  { method: "GET", path: "/users", handler: async () => Response.json({}), meta: { operationId: "listUsers", responses: { 200: { description: "ok", schema: ${response} } } } },
  { method: "POST", path: "/users", handler: async () => Response.json({}), meta: { operationId: "createUser", body: ${body}, responses: { 200: { description: "ok" } } } },
]; } };
`
    );
    await writeFile(
      path.join(dir, "apifn.config.ts"),
      `export default { router: "./router.ts", openapi: { info: { title: "Refs", version: "${options.version ?? "1.0.0"}" } } };\n`
    );
    await commitSpec(dir);
    return dir;
  }

  async function baseFile(options: { inline?: boolean }): Promise<string> {
    const base = await refService({ required: false, inline: options.inline });
    return path.join(base, SPEC);
  }

  it.each([
    ["behind a local $ref", false],
    ["written inline", true],
  ])("a request field that became required %s is breaking", async (_label, inline) => {
    const base = await baseFile({ inline });
    const head = await refService({ required: true, inline });
    const { code, report } = await runJson(["check", "--base-spec", base], head);
    expect(code).toBe(1);
    expect(report.breaking.map((entry) => entry.path)).toContain(
      "paths./users.post.requestBody.content.application/json.schema.required"
    );
  });

  it("the referenced change passes with a major bump or --allow-breaking, still listed", async () => {
    const base = await baseFile({});
    const bumped = await refService({ required: true, version: "2.0.0" });
    expect((await runJson(["check", "--base-spec", base], bumped)).code).toBe(0);

    const head = await refService({ required: true });
    const allowed = await runJson(["check", "--base-spec", base, "--allow-breaking"], head);
    expect(allowed.code).toBe(0);
    expect(allowed.report.breaking).toHaveLength(1);
  });

  it("a base the validator rejects (paths: []) exits 2 and --write publishes nothing", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"));
    await writeFile(path.join(dir, SPEC), "openapi: 3.1.0\n");
    await writeFile(path.join(dir, "bad.yml"), "openapi: 3.1.0\ninfo: { title: Check fixture, version: 1.0.0 }\npaths: []\n");

    const result = await run(["check", "--base-spec", "bad.yml", "--write"], dir);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("is invalid");
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
  });

  it("a valid base with an empty paths mapping is compared", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    await writeFile(path.join(dir, "empty.yml"), "openapi: 3.1.0\ninfo: { title: Check fixture, version: 1.0.0 }\npaths: {}\n");
    const { code, report } = await runJson(["check", "--base-spec", "empty.yml"], dir);
    expect(code).toBe(0);
    expect(report.base.status).toBe("compared");
    expect(report.diff?.nonBreaking.length).toBeGreaterThan(0);
  });

  it("a base $ref that leaves the document exits 2", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const doc = parseYaml(await readFile(path.join(dir, SPEC), "utf8")) as Record<string, unknown>;
    const components = { ...(doc.components as Record<string, unknown>), schemas: { Ext: { $ref: "other.yml#/x" } } };
    await writeFile(path.join(dir, "ext.yml"), toYaml({ ...doc, components }));
    const result = await run(["check", "--base-spec", "ext.yml"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("outside the document");
  });
});

describe("apifn check: one strict, bounded parser for every document", () => {
  async function service(schema: string): Promise<string> {
    const dir = await tempDir("apifn-check-parse-");
    await writeFile(
      path.join(dir, "router.ts"),
      `export default { getRoutes() { return [
  { method: "GET", path: "/n", handler: async () => Response.json({}), meta: { operationId: "getN", responses: { 200: { description: "ok", schema: ${schema} } } } },
]; } };
`
    );
    await writeFile(
      path.join(dir, "apifn.config.ts"),
      `export default { router: "./router.ts", openapi: { info: { title: "Numbers", version: "1.0.0" } } };\n`
    );
    return dir;
  }

  it("an integer a double cannot hold exactly is drift, and --write repairs it", async () => {
    const dir = await service(`{ type: "integer", maximum: 9007199254740992 }`);
    await commitSpec(dir);
    const generated = await readFile(path.join(dir, SPEC), "utf8");
    expect(generated).toContain("maximum: 9007199254740992");
    await writeFile(path.join(dir, SPEC), generated.replace("9007199254740992", "9007199254740993"));

    const stale = await runJson(["check"], dir);
    expect({ code: stale.code, driftState: stale.report.driftState }).toEqual({ code: 1, driftState: "unparseable" });
    expect((await runJson(["check", "--write"], dir)).code).toBe(0);
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(generated);
    expect((await runJson(["check"], dir)).report.drift).toBe(false);
  });

  it.each(["9007199254740993.0", "9.007199254740993e15", "90071992547409930e-1"])(
    "an integer written %s is held to the same rule: drift when committed, a load error as the base",
    async (spelling) => {
      const dir = await service(`{ type: "integer", maximum: 9007199254740992 }`);
      await commitSpec(dir);
      const generated = await readFile(path.join(dir, SPEC), "utf8");
      const misspelled = generated.replace("9007199254740992", spelling);
      await writeFile(path.join(dir, "base.yml"), misspelled);
      await writeFile(path.join(dir, SPEC), misspelled);

      const stale = await runJson(["check"], dir);
      expect({ code: stale.code, driftState: stale.report.driftState }).toEqual({ code: 1, driftState: "unparseable" });
      await writeFile(path.join(dir, SPEC), generated);
      const base = await run(["check", "--base-spec", "base.yml"], dir);
      expect(base.code).toBe(2);
      expect(base.stderr).toContain("does not hold exactly");
    }
  );

  it.each(["9007199254740992.0", "9.007199254740992e15", "1e+23", "1e21", "-0.0", "2.5", "1e-7"])(
    "%s reads as the double it names",
    (spelling) => {
      expect(parseContract(`openapi: 3.1.0\nx: ${spelling}\n`).x).toBe(Number(spelling));
    }
  );

  it("a long decimal with a long run of zeros is read in linear time", () => {
    // 1.000…0001 with 200,000 zeros: the old /0+$/ scan restarted at every zero (seconds here).
    const zeros = "0".repeat(200_000);
    const started = performance.now();
    expect(parseContract(`openapi: 3.1.0\nx: 1.${zeros}1\ny: 1${zeros}.0e-200000\n`)).toMatchObject({ x: 1, y: 1 });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it.each([
    ["int64 bounds", `{ type: "integer", minimum: -9223372036854775808, maximum: 9223372036854775807 }`],
    ["2^64 and an exponent float", `{ type: "number", minimum: 18446744073709551616, maximum: 1e21 }`],
    ["the largest double", `{ type: "number", maximum: Number.MAX_VALUE }`],
  ])("a router with %s checks clean after generate, and --write repairs its stale spec", async (_label, schema) => {
    const dir = await service(schema);
    await commitSpec(dir);
    const generated = await readFile(path.join(dir, SPEC), "utf8");
    const clean = await runJson(["check"], dir);
    expect({ code: clean.code, drift: clean.report.drift, valid: clean.report.valid }).toEqual({
      code: 0,
      drift: false,
      valid: true,
    });

    await writeFile(path.join(dir, SPEC), generated.replace("title: Numbers", "title: Stale"));
    expect((await runJson(["check", "--write"], dir)).report.written).toBe(true);
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(generated);
  });

  it("a generated value with no JSON form is an invalid spec and is never written", async () => {
    const dir = await service(`{ type: "number", maximum: Infinity }`);
    const { code, report } = await runJson(["check", "--write"], dir);
    expect(code).toBe(1);
    expect(report.valid).toBe(false);
    expect(report.written).toBe(false);
    expect(report.validationErrors[0].message).toContain("faithful JSON form");
    expect(existsSync(path.join(dir, SPEC))).toBe(false);
  });

  it("a base wrapped in a YAML string scalar is a load error like the document inside it", async () => {
    const root = await fixtures();
    await commitSpec(path.join(root, "base"));
    const dir = path.join(root, "breaking");
    await commitSpec(dir);
    const base = parseYaml(await readFile(path.join(root, "base", SPEC), "utf8")) as Record<string, unknown>;
    const duplicated = `${JSON.stringify(base).slice(0, -1)},"paths":{}}`;
    await writeFile(path.join(dir, "wrapped.yml"), JSON.stringify(duplicated));

    const result = await run(["check", "--base-spec", "wrapped.yml"], dir);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("not a mapping");
  });

  it("a committed spec past the expansion budget is drift that --write repairs", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"));
    await writeFile(path.join(dir, SPEC), aliasBomb());

    const stale = await runJson(["check"], dir);
    expect({ code: stale.code, driftState: stale.report.driftState }).toEqual({ code: 1, driftState: "unparseable" });
    const repaired = await runJson(["check", "--write"], dir);
    expect({ code: repaired.code, written: repaired.report.written }).toEqual({ code: 0, written: true });
    expect(await readFile(path.join(dir, SPEC), "utf8")).not.toContain("x-big");
  });

  it("a unique alias key is read by value; a merge key is not read", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const generated = await readFile(path.join(dir, SPEC), "utf8");
    let seen = 0;
    const aliased = generated.replace(/^( +)description: /gm, (line, indent: string) => {
      seen += 1;
      if (seen === 1) return `${indent}&k description: `;
      return seen === 2 ? `${indent}*k : ` : line;
    });
    expect(seen).toBeGreaterThanOrEqual(2);
    await writeFile(path.join(dir, SPEC), aliased);
    expect((await runJson(["check"], dir)).report.drift).toBe(false);

    await writeFile(path.join(dir, SPEC), `${generated}x-a: &a { k: 1 }\nx-b:\n  <<: *a\n`);
    expect((await runJson(["check"], dir)).report.driftState).toBe("unparseable");
  });

  it("canonical JSON does not depend on key insertion order", () => {
    expect(canonicalJson({ b: 1, é: 2, a: { d: [1, { z: 0, y: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { y: 1, z: 0 }] }, é: 2, b: 1 })
    );
    expect(canonicalJson({ é: 1, e: 2, Z: 3 })).toBe('{"Z":3,"e":2,"é":1}');
  });
});

describe("apifn check: an HTTP base spec", () => {
  async function serve(handler: (res: ServerResponse) => void): Promise<{ url: string; close: () => void }> {
    const server = createServer((_req, res) => handler(res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/openapi.yml`,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  }

  async function check(dir: string, url: string): Promise<{ code: number; errors: string[]; stdout: string }> {
    const errors: string[] = [];
    let stdout = "";
    const output = { error: (message: string) => errors.push(message) } as unknown as Output;
    const config = { router: "./router.ts", openapi: { info: { title: "Check fixture", version: "1.1.0" } } };
    const code = await runCheckCommand({
      cwd: dir,
      config,
      output,
      baseSpec: url,
      format: "json",
      httpTimeoutMs: 500,
      writeStdout: (text) => {
        stdout += text;
      },
    });
    return { code, errors, stdout };
  }

  it("a complete response is compared; a body that stalls or expands past the budget exits 2", async () => {
    const root = await fixtures();
    await commitSpec(path.join(root, "base"));
    const dir = path.join(root, "breaking");
    await commitSpec(dir);
    const baseText = await readFile(path.join(root, "base", SPEC), "utf8");

    const complete = await serve((res) => res.end(baseText));
    try {
      const result = await check(dir, complete.url);
      expect(result.code).toBe(1);
      expect((JSON.parse(result.stdout) as CheckReport).base.status).toBe("compared");
    } finally {
      complete.close();
    }

    const stalled = await serve((res) => {
      res.writeHead(200);
      res.write(baseText.slice(0, 20));
    });
    try {
      const started = Date.now();
      const result = await check(dir, stalled.url);
      expect(result.code).toBe(2);
      expect(result.errors.join("\n")).toContain("within 500 ms");
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      stalled.close();
    }

    const bomb = await serve((res) => res.end(aliasBomb()));
    try {
      const result = await check(dir, bomb.url);
      expect(result.code).toBe(2);
      expect(result.errors.join("\n")).toContain("expand to");
    } finally {
      bomb.close();
    }
  });
});

describe("apifn check: outputs never land on inputs and are published atomically", () => {
  async function staleService(): Promise<string> {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"));
    await writeFile(path.join(dir, SPEC), "openapi: 3.1.0\n");
    return dir;
  }

  it.each([
    ["the router module", ["--report", "router.ts"], "router.ts"],
    ["the config file", ["--report", "apifn.config.ts"], "apifn.config.ts"],
    ["the router module through a symlink", ["--report", "link.md"], "router.ts"],
    ["the router module of an extensionless operand", ["router", "--report", "router.ts"], "router.ts"],
    ["the router module of a directory operand", ["api", "--report", path.join("api", "index.ts")], path.join("api", "index.ts")],
  ])("--report naming %s exits 2 and leaves it unchanged", async (_label, args, source) => {
    const dir = await staleService();
    await symlink("router.ts", path.join(dir, "link.md"));
    await mkdir(path.join(dir, "api"));
    await cp(path.join(dir, "router.ts"), path.join(dir, "api", "index.ts"));
    const before = await readFile(path.join(dir, source), "utf8");

    const result = await run(["check", ...args, "--write"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/the (router module|config file)/);
    expect(await readFile(path.join(dir, source), "utf8")).toBe(before);
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
  });

  it("--write replaces the spec by rename and keeps a spec symlink", async () => {
    const dir = await staleService();
    const before = await stat(path.join(dir, SPEC));
    expect((await run(["check", "--write"], dir)).code).toBe(0);
    const after = await stat(path.join(dir, SPEC));
    expect(after.ino).not.toBe(before.ino);
    expect(await readFile(path.join(dir, SPEC), "utf8")).toContain("title: Check fixture");

    await writeFile(path.join(dir, SPEC), "openapi: 3.1.0\n");
    await symlink(SPEC, path.join(dir, "contract.yml"));
    expect((await run(["check", "--write", "--spec", "contract.yml"], dir)).code).toBe(0);
    expect((await lstat(path.join(dir, "contract.yml"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(dir, SPEC), "utf8")).toContain("title: Check fixture");
    expect(await leftovers(path.join(dir, ".apifn"))).toEqual([]);
  });

  it.each([
    ["a stale committed spec", "openapi: 3.1.0\n"],
    ["a missing committed spec", null],
  ])("a stdout failure after --write rolls back %s and the report", async (_label, committed) => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"));
    if (committed !== null) await writeFile(path.join(dir, SPEC), committed);
    await writeFile(path.join(dir, "report.md"), "previous report\n");

    let stderr = "";
    const code = await runCli(["check", "--write", "--report", "report.md"], {
      cwd: dir,
      stdout: () => {
        throw new Error("stdout closed");
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(2);
    expect(stderr).toContain("stdout closed");
    expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe("previous report\n");
    if (committed === null) expect(existsSync(path.join(dir, SPEC))).toBe(false);
    else expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(committed);
    expect([...(await leftovers(dir)), ...(await leftovers(path.join(dir, ".apifn")))]).toEqual([]);
  });

  it.each([
    ["rewrites the repaired spec in place", false],
    ["replaces the repaired spec by rename", true],
  ])("a rollback leaves the spec alone when another writer %s", async (_label, byRename) => {
    const dir = await staleService();
    const specFile = path.join(dir, SPEC);
    let stderr = "";
    const code = await runCli(["check", "--write"], {
      cwd: dir,
      stdout: () => {
        if (byRename) {
          writeFileSync(`${specFile}.writer`, "writer: 1\n");
          renameSync(`${specFile}.writer`, specFile);
        } else {
          writeFileSync(specFile, "writer: 1\n");
        }
        throw new Error("stdout closed");
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(2);
    expect(stderr).toContain("changed after apifn check wrote it");
    expect(await readFile(specFile, "utf8")).toBe("writer: 1\n");
  });

  it.skipIf(POSIX_ONLY || IS_ROOT)("a write failure keeps the previous spec and report complete and leaves no temp files", async () => {
    const dir = await staleService();
    await chmod(path.join(dir, ".apifn"), 0o555);
    try {
      const result = await run(["check", "--write"], dir);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Failed to write spec");
    } finally {
      await chmod(path.join(dir, ".apifn"), 0o755);
    }
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
    expect(await leftovers(path.join(dir, ".apifn"))).toEqual([]);

    await mkdir(path.join(dir, "out"));
    await writeFile(path.join(dir, "out", "report.md"), "previous report\n");
    await chmod(path.join(dir, "out"), 0o555);
    try {
      const result = await run(["check", "--write", "--report", path.join("out", "report.md")], dir);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Failed to write report");
    } finally {
      await chmod(path.join(dir, "out"), 0o755);
    }
    expect(await readFile(path.join(dir, "out", "report.md"), "utf8")).toBe("previous report\n");
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
  });

  it("--write keeps a JSON spec at an extensionless path in JSON, and the drift hint names --write", async () => {
    const dir = await staleService();
    await writeFile(path.join(dir, "contract"), '{"openapi":"3.1.0"}\n');
    const stale = await runJson(["check", "--spec", "contract"], dir);
    expect(stale.report.failures.join("\n")).toContain("Rerun this check with --write");

    expect((await run(["check", "--spec", "contract", "--write"], dir)).code).toBe(0);
    const repaired = await readFile(path.join(dir, "contract"), "utf8");
    expect((JSON.parse(repaired) as { openapi: string }).openapi).toBe("3.1.0");
  });
});

describe("apifn check: Markdown escaping and usage errors", () => {
  it.skipIf(POSIX_ONLY)("paths with pipes and backslashes stay whole in one table cell", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const baseName = String.raw`bases/a|b\c.yml`;
    await mkdir(path.join(dir, "bases"));
    await cp(path.join(dir, SPEC), path.join(dir, baseName));
    await mkdir(path.join(dir, "specs"));
    await cp(path.join(dir, SPEC), path.join(dir, String.raw`specs/x|y\z.yml`));

    const result = await run(
      ["check", "--spec", String.raw`specs/x|y\z.yml`, "--base-spec", baseName, "--format", "markdown"],
      dir
    );
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    // GFM reads `\|` as a literal pipe inside the cell (also inside a code span) and `\\` as a
    // backslash in text, so each cell renders the complete path.
    expect(lines).toContain(String.raw`| Spec | ` + "`" + String.raw`specs/x\|y\z.yml` + "` |");
    expect(lines).toContain(String.raw`| Base | bases/a\|b\\c.yml |`);
  });

  it.each([
    [["check", "--help=1"], "--help takes no value"],
    [["check", "--spec", "--help"], "--spec takes one value"],
    [["check", "a", "b", "--help"], "at most one [routerPath]"],
    [["check", "--base", "HEAD", "--base-spec", "base.yml", "--help"], "only one of --base and --base-spec"],
    [["check", "--format", "xml", "--help"], "Unknown --format 'xml'"],
  ])("%j is a usage error (exit 2) even with --help", async (args, message) => {
    const root = await fixtures();
    const result = await run(args, path.join(root, "base"));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(message);
  });

  it.each([
    ["--write", "false"],
    ["--allow-breaking", "true"],
    ["--help", "false"],
  ])("a separate value on %s (%s) is a usage error and writes nothing", async (flag, value) => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    const result = await run(["check", flag, value], dir);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`${flag} takes no value`);
    expect(existsSync(path.join(dir, SPEC))).toBe(false);
  });

  it("a router operand named false before the switches is still a router", async () => {
    const root = await fixtures();
    const result = await run(["check", "false", "--write"], path.join(root, "base"));
    expect(result.code).toBe(2);
    expect(result.stderr).not.toContain("takes no value");
    expect(result.stderr).toContain("Failed to generate the spec from the router");
  });

  it("--help alone still prints help, for check and for the other commands", async () => {
    const root = await fixtures();
    for (const command of ["check", "generate"]) {
      const result = await run([command, "--help"], path.join(root, "base"));
      // cac prints help to the console; the run itself writes no error.
      expect({ command, code: result.code, stderr: result.stderr }).toEqual({ command, code: 0, stderr: "" });
    }
  });
});

describe("apifn check: the git baseline is resolved component by component", () => {
  /** A git repository holding the fixtures, with the breaking service's head spec and the base contract. */
  async function gitService(): Promise<{ root: string; service: string; baseText: string; headText: string }> {
    const root = await fixtures();
    git(root, "init", "-q");
    const service = path.join(root, "breaking");
    await commitSpec(path.join(root, "base"));
    await commitSpec(service);
    const baseText = await readFile(path.join(root, "base", SPEC), "utf8");
    return { root, service, baseText, headText: await readFile(path.join(service, SPEC), "utf8") };
  }

  function commitAll(root: string, message: string): void {
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", message);
  }

  async function expectCompared(args: string[], service: string): Promise<void> {
    const { code, report } = await runJson(["check", "--base", "HEAD", ...args], service);
    expect(report.drift).toBe(false);
    expect(report.base).toEqual({ source: "git", ref: "HEAD", status: "compared" });
    expect(report.breaking.length).toBeGreaterThan(0);
    expect(code).toBe(1);
  }

  it.skipIf(POSIX_ONLY)("`..` in a link target returns to the directory a preceding directory link resolved to", async () => {
    // .apifn/openapi.yml -> ../alias/../contract.yml and alias -> deep/child: git (like the kernel)
    // reads deep/contract.yml, the base contract; collapsing alias/.. first would read the decoy.
    const { root, service, baseText, headText } = await gitService();
    await mkdir(path.join(service, "deep", "child"), { recursive: true });
    await writeFile(path.join(service, "deep", "child", "keep.txt"), "keep\n");
    await writeFile(path.join(service, "deep", "contract.yml"), baseText);
    await writeFile(path.join(service, "contract.yml"), headText);
    await symlink("deep/child", path.join(service, "alias"));
    await rm(path.join(service, SPEC));
    await symlink("../alias/../contract.yml", path.join(service, SPEC));
    commitAll(root, "spec behind a directory link");
    await rm(path.join(service, SPEC));
    await writeFile(path.join(service, SPEC), headText);

    await expectCompared([], service);
  });

  it.skipIf(POSIX_ONLY)("a tracked spec directory that is a link through a directory link and `..` is walked in order", async () => {
    // .apifn -> alias/.. and alias -> deep/child: the spec directory at the base is deep/.
    const { root, service, baseText, headText } = await gitService();
    await mkdir(path.join(service, "deep", "child"), { recursive: true });
    await writeFile(path.join(service, "deep", "child", "keep.txt"), "keep\n");
    await writeFile(path.join(service, "deep", "openapi.yml"), baseText);
    await writeFile(path.join(service, "openapi.yml"), headText);
    await symlink("deep/child", path.join(service, "alias"));
    await rm(path.join(service, ".apifn"), { recursive: true });
    await symlink("alias/..", path.join(service, ".apifn"));
    commitAll(root, "spec directory behind links");
    await rm(path.join(service, ".apifn"));
    await mkdir(path.join(service, ".apifn"));
    await writeFile(path.join(service, SPEC), headText);

    await expectCompared([], service);
  });

  it.skipIf(POSIX_ONLY)("a spec path through an in-repository link back to the root keeps the link's tracked spelling", async () => {
    // At the base, self/ is a directory holding the base contract; in the working tree self -> .
    const { root, service, baseText } = await gitService();
    await mkdir(path.join(root, "self", "breaking", ".apifn"), { recursive: true });
    await writeFile(path.join(root, "self", "breaking", SPEC), baseText);
    commitAll(root, "self is a directory");
    await rm(path.join(root, "self"), { recursive: true });
    await symlink(".", path.join(root, "self"));

    await expectCompared(["--spec", path.join("..", "self", "breaking", SPEC)], service);
  });

  it.skipIf(POSIX_ONLY).each([
    ["climbs above the repository root", [["openapi.yml", "../../../outside.yml"]], "leaves the repository"],
    ["forms a loop", [["openapi.yml", "loop.yml"], ["loop.yml", "openapi.yml"]], "Too many symbolic links"],
  ])("a tracked spec link that %s exits 2", async (_label, links, message) => {
    const { root, service, headText } = await gitService();
    await rm(path.join(service, SPEC));
    for (const [name, target] of links) await symlink(target, path.join(service, ".apifn", name));
    commitAll(root, "spec link");
    await rm(path.join(service, SPEC));
    await writeFile(path.join(service, SPEC), headText);

    const result = await run(["check", "--base", "HEAD"], service);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
  });
});

describe("apifn check: keys beside a $ref apply together with its target", () => {
  /** POST /users takes GET /users' response schema through a $ref with a sibling `required`. */
  async function siblingService(target: string[], sibling: string[]): Promise<string> {
    const dir = await tempDir("apifn-check-sibling-");
    const schema = `{ type: "object", properties: { kind: { type: "string" }, name: { type: "string" } }, required: ${JSON.stringify(target)} }`;
    const body = `{ $ref: "#/paths/~1users/get/responses/200/content/application~1json/schema", required: ${JSON.stringify(sibling)} }`;
    await writeFile(
      path.join(dir, "router.ts"),
      `export default { getRoutes() { return [
  { method: "GET", path: "/users", handler: async () => Response.json({}), meta: { operationId: "listUsers", responses: { 200: { description: "ok", schema: ${schema} } } } },
  { method: "POST", path: "/users", handler: async () => Response.json({}), meta: { operationId: "createUser", body: ${body}, responses: { 200: { description: "ok" } } } },
]; } };
`
    );
    await writeFile(
      path.join(dir, "apifn.config.ts"),
      `export default { router: "./router.ts", openapi: { info: { title: "Siblings", version: "1.0.0" } } };\n`
    );
    await commitSpec(dir);
    return dir;
  }

  it.each([
    ["the target newly requires a field beside a sibling required list", [["kind"], ["kind"]], [["kind", "name"], ["kind"]], 1],
    ["the sibling list newly requires a field", [["kind"], ["kind"]], [["kind"], ["kind", "name"]], 1],
    ["nothing changes", [["kind"], ["kind"]], [["kind"], ["kind"]], 0],
  ])("%s at an unchanged version", async (_label, before, after, expected) => {
    const base = await siblingService(before[0], before[1]);
    const head = await siblingService(after[0], after[1]);
    const { code, report } = await runJson(["check", "--base-spec", path.join(base, SPEC)], head);
    expect(report.drift).toBe(false);
    expect(report.base.status).toBe("compared");
    expect({ code, breaking: report.breaking.length > 0 }).toEqual({ code: expected, breaking: expected === 1 });
  });

  function doc(schemas: Record<string, unknown>): Record<string, never> {
    return { openapi: "3.1.0", info: { title: "S", version: "1.0.0" }, paths: {}, components: { schemas } } as never;
  }

  it("bounds keep the tighter one, and a sibling without an exact combined form is refused", () => {
    const target = { type: "string", maxLength: 10, pattern: "^a" };
    const merged = comparable(doc({ A: target, B: { $ref: "#/components/schemas/A", maxLength: 5, minLength: 1 } }));
    expect((merged.components?.schemas as Record<string, unknown>).B).toEqual({ ...target, maxLength: 5, minLength: 1 });
    expect(() => comparable(doc({ A: target, C: { $ref: "#/components/schemas/A", pattern: "^b" } }))).toThrow(
      "cannot combine"
    );
  });

  /** GET /users answers GET /user's schema closed to some names, inline or as a $ref with siblings. */
  async function closedService(viaRef: boolean, siblingNames: string[]): Promise<string> {
    const dir = await tempDir("apifn-check-closed-");
    const target = `{ type: "object", properties: { id: { type: "string" }, name: { type: "string" } } }`;
    const sibling = `properties: { ${siblingNames.map((name) => `${name}: { type: "string" }`).join(", ")} }, additionalProperties: false`;
    const response = viaRef
      ? `{ $ref: "#/paths/~1user/get/responses/200/content/application~1json/schema", ${sibling} }`
      : `{ type: "object", ${sibling} }`;
    await writeFile(
      path.join(dir, "router.ts"),
      `export default { getRoutes() { return [
  { method: "GET", path: "/user", handler: async () => Response.json({}), meta: { operationId: "getUser", responses: { 200: { description: "ok", schema: ${target} } } } },
  { method: "GET", path: "/users", handler: async () => Response.json({}), meta: { operationId: "listUsers", responses: { 200: { description: "ok", schema: ${response} } } } },
]; } };
`
    );
    await writeFile(
      path.join(dir, "apifn.config.ts"),
      `export default { router: "./router.ts", openapi: { info: { title: "Closed", version: "1.0.0" } } };\n`
    );
    await commitSpec(dir);
    return dir;
  }

  it.each([false, true])(
    "a closed response that drops a property is breaking whether its schema is inline or a $ref (via $ref: %s)",
    async (viaRef) => {
      const base = await closedService(viaRef, ["id", "name"]);
      const head = await closedService(viaRef, ["id"]);
      const { code, report } = await runJson(["check", "--base-spec", path.join(base, SPEC)], head);
      expect(report.base.status).toBe("compared");
      expect({ code, breaking: report.breaking.length }).toEqual({ code: 1, breaking: 1 });
    }
  );

  it("a closed side keeps only its own property names, as the same schema written inline", () => {
    const target = { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } };
    const closed = comparable(doc({ A: target, B: { $ref: "#/components/schemas/A", properties: { id: { minLength: 1 } }, additionalProperties: false } }));
    expect((closed.components?.schemas as Record<string, unknown>).B).toEqual({
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      additionalProperties: false,
    });
  });

  it.each([
    ["scalar number with integer", "number", "integer", "integer"],
    ["scalar integer with number", "integer", "number", "integer"],
    ["an array with a scalar", ["number", "null"], "integer", "integer"],
    ["two arrays", ["number", "null"], ["integer", "null", "string"], ["null", "integer"]],
  ])("type intersects %s", (_label, a, b, expected) => {
    const merged = comparable(doc({ A: { type: a }, B: { $ref: "#/components/schemas/A", type: b } }));
    expect((merged.components?.schemas as Record<string, { type: unknown }>).B.type).toEqual(expected);
  });

  it.each([
    ["an open side's additionalProperties would cover fewer names", { type: "object", properties: { a: {} }, additionalProperties: { type: "string" } }, { properties: { b: {} } }],
    ["items would start after a new prefix", { type: "array", items: { type: "string" } }, { prefixItems: [{ type: "number" }] }],
    ["minContains would count another contains", { type: "array", minContains: 2 }, { contains: { type: "string" } }],
    ["then would follow another if", { then: { required: ["a"] } }, { if: { type: "object" } }],
  ])("a sibling that changes what a keyword applies to is refused: %s", (_label, target, sibling) => {
    expect(() => comparable(doc({ A: target, B: { $ref: "#/components/schemas/A", ...sibling } }))).toThrow(
      "changes what"
    );
  });
});

describe("apifn check: publication re-checks each step and stdout completes the transaction", () => {
  const CONFIG = { router: "./router.ts", openapi: { info: { title: "Check fixture", version: "1.0.0" } } };

  async function staleService(): Promise<string> {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"));
    await writeFile(path.join(dir, SPEC), "openapi: 3.1.0\n");
    await writeFile(path.join(dir, "report.md"), "previous report\n");
    return dir;
  }

  async function checkWithHook(
    dir: string,
    extra: { baseSpec?: string },
    hook: (step: PublishStep, destination: string) => void,
    stdout: (text: string) => void = () => {}
  ): Promise<{ code: number; errors: string[] }> {
    const errors: string[] = [];
    const output = { error: (message: string) => errors.push(message) } as unknown as Output;
    const code = await runCheckCommand({
      cwd: dir,
      config: CONFIG,
      output,
      write: true,
      reportPath: "report.md",
      ...extra,
      writeStdout: stdout,
      publishHook: hook,
    });
    return { code, errors };
  }

  async function allLeftovers(dir: string): Promise<string[]> {
    return [...(await leftovers(dir)), ...(await leftovers(path.join(dir, ".apifn")))];
  }

  it("a spec replaced after the check and before the rename is kept, and nothing is published", async () => {
    const dir = await staleService();
    const specFile = path.join(dir, SPEC);
    const { code, errors } = await checkWithHook(dir, {}, (step, destination) => {
      if (step === "rename" && destination.endsWith("openapi.yml")) {
        writeFileSync(`${specFile}.other`, "other: 1\n");
        renameSync(`${specFile}.other`, specFile);
      }
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("changed while apifn check ran");
    expect(await readFile(specFile, "utf8")).toBe("other: 1\n");
    expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe("previous report\n");
    expect(await allLeftovers(dir)).toEqual([]);
  });

  it("an output replaced right after its rename is not rolled back over, and the error names it", async () => {
    const dir = await staleService();
    const reportFile = path.join(dir, "report.md");
    const { code, errors } = await checkWithHook(
      dir,
      {},
      (step, destination) => {
        // The report was renamed into place; another writer replaces it before the spec's turn.
        if (step === "backup" && destination.endsWith("openapi.yml")) {
          writeFileSync(`${reportFile}.other`, "other report\n");
          renameSync(`${reportFile}.other`, reportFile);
        }
      },
      () => {
        throw new Error("stdout closed");
      }
    );
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain(`${reportFile} changed after apifn check wrote it`);
    expect(await readFile(reportFile, "utf8")).toBe("other report\n");
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
  });

  /** Rewrites `file` in place with bytes of the same length and puts its times back exactly. */
  function editInPlace(file: string, text: string): void {
    const before = statSync(file, { bigint: true });
    expect(Buffer.byteLength(text)).toBe(Number(before.size));
    // touch -r copies the times at full (nanosecond) precision; fs.utimes rounds them.
    const times = `${file}.times`;
    writeFileSync(times, "");
    execFileSync("touch", ["-r", file, times]);
    const fd = openSync(file, "r+");
    writeSync(fd, text, 0);
    closeSync(fd);
    execFileSync("touch", ["-r", times, file]);
    rmSync(times);
    const after = statSync(file, { bigint: true });
    expect({ ino: after.ino, size: after.size, mtimeNs: after.mtimeNs }).toEqual({
      ino: before.ino,
      size: before.size,
      mtimeNs: before.mtimeNs,
    });
  }

  it.each(["openapi.yml", "report.md"])(
    "an in-place edit of the published %s that keeps its size and mtime is not rolled back over",
    async (name) => {
      const dir = await staleService();
      const file = name === "report.md" ? path.join(dir, "report.md") : path.join(dir, SPEC);
      let newer = "";
      const { code, errors } = await checkWithHook(
        dir,
        {},
        (step, destination) => {
          if (step === "rollback" && destination.endsWith(name)) {
            const published = readFileSync(file, "utf8");
            newer = published.replace(/./, (c) => (c === "x" ? "y" : "x"));
            editInPlace(file, newer);
          }
        },
        () => {
          throw new Error("stdout closed");
        }
      );
      expect(newer).not.toBe("");
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain(`changed after apifn check wrote it`);
      expect(await readFile(file, "utf8")).toBe(newer);
      const other = name === "report.md" ? path.join(dir, SPEC) : path.join(dir, "report.md");
      expect(await readFile(other, "utf8")).toBe(name === "report.md" ? "openapi: 3.1.0\n" : "previous report\n");
    }
  );

  it("a spec replaced by another inode during rollback is kept, and a report still owned is restored", async () => {
    const dir = await staleService();
    const specFile = path.join(dir, SPEC);
    const { code, errors } = await checkWithHook(
      dir,
      {},
      (step, destination) => {
        if (step === "rollback" && destination.endsWith("openapi.yml")) {
          writeFileSync(`${specFile}.other`, "other: 1\n");
          renameSync(`${specFile}.other`, specFile);
        }
      },
      () => {
        throw new Error("stdout closed");
      }
    );
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain(`changed after apifn check wrote it`);
    expect(await readFile(specFile, "utf8")).toBe("other: 1\n");
    expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe("previous report\n");
  });

  it("a failed stdout with untouched outputs restores the previous bytes, or the absence of a new report", async () => {
    const dir = await staleService();
    await rm(path.join(dir, "report.md"));
    const { code } = await checkWithHook(dir, {}, () => {}, () => {
      throw new Error("stdout closed");
    });
    expect(code).toBe(2);
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
    expect(existsSync(path.join(dir, "report.md"))).toBe(false);
    expect(await allLeftovers(dir)).toEqual([]);
  });

  it.skipIf(POSIX_ONLY)("a spec directory swapped for a link to the base's directory before the rename writes nothing", async () => {
    const dir = await staleService();
    await mkdir(path.join(dir, "bases"));
    await commitSpec(dir);
    const generated = await readFile(path.join(dir, SPEC), "utf8");
    await writeFile(path.join(dir, "bases", "openapi.yml"), generated);
    await writeFile(path.join(dir, SPEC), "openapi: 3.1.0\n");

    const { code, errors } = await checkWithHook(dir, { baseSpec: path.join("bases", "openapi.yml") }, (step, destination) => {
      if (step === "rename" && destination.endsWith("openapi.yml")) {
        renameSync(path.join(dir, ".apifn"), path.join(dir, ".apifn-moved"));
        symlinkSync("bases", path.join(dir, ".apifn"));
      }
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("changed while apifn check ran");
    expect(await readFile(path.join(dir, "bases", "openapi.yml"), "utf8")).toBe(generated);
    expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe("previous report\n");
  });

  it("a stdout writer that rejects after the renames rolls back the spec and the report", async () => {
    const dir = await staleService();
    let stderr = "";
    const code = await runCli(["check", "--write", "--report", "report.md"], {
      cwd: dir,
      stdout: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("stdout closed later");
      },
      stderr: (text) => {
        stderr += text;
      },
    });
    expect(code).toBe(2);
    expect(stderr).toContain("stdout closed later");
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
    expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe("previous report\n");
    expect(await allLeftovers(dir)).toEqual([]);
  });

  it("a closed stdout pipe makes the CLI process exit 2 and roll back the spec and the report", async () => {
    const dir = await staleService();
    const jiti = path.join(path.dirname(createRequire(import.meta.url).resolve("jiti/package.json")), "lib", "jiti-cli.mjs");
    const bin = path.join(import.meta.dirname, "..", "src", "bin.ts");
    const child = spawn(
      process.execPath,
      [jiti, bin, "check", "--write", "--report", "report.md", "--format", "markdown"],
      { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }
    );
    // The reader goes away before the CLI writes its report.
    child.stdout.destroy();
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.on("close", (exit) => resolve(exit)));
    expect({ code, stderr }).toEqual({ code: 2, stderr: expect.stringContaining("Failed to write the report to stdout") });
    expect(stderr).not.toContain("Unhandled");
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
    expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe("previous report\n");
    expect(await allLeftovers(dir)).toEqual([]);
  }, 30_000);
});

describe("apifn check: --write keeps the committed format, told by content", () => {
  it.each([
    ["flow-style YAML at .apifn/openapi.yml", SPEC, "{openapi: 3.1.0}\n", "yaml"],
    ["flow-style YAML at a .json path", "contract.json", "{openapi: 3.1.0, info: {title: x}}\n", "yaml"],
    ["block YAML at a .json path", "contract.json", "openapi: 3.1.0\n", "yaml"],
    ["JSON at an extensionless path", "contract", '{"openapi": "3.1.0"}\n', "json"],
    ["JSON with a byte-order mark at a .json path", "contract.json", '\uFEFF{"openapi": "3.1.0"}\n', "json"],
    ["JSON at a .yml path", "contract.yml", '{"openapi": "3.1.0"}\n', "json"],
    ["a missing spec at a .json path", "contract.json", null, "json"],
    ["a missing spec at a .yml path", "contract.yml", null, "yaml"],
    ["unreadable text at a .json path", "contract.json", "{ [\n", "json"],
  ])("--write repairs %s in its own format", async (_label, name, text, format) => {
    const dir = path.join(await fixtures(), "base");
    const file = path.join(dir, name);
    if (text !== null) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
    }

    expect((await run(["check", "--spec", name, "--write"], dir)).code).toBe(0);
    const repaired = await readFile(file, "utf8");
    if (format === "json") {
      expect((JSON.parse(repaired) as { openapi: string }).openapi).toBe("3.1.0");
    } else {
      expect(() => JSON.parse(repaired)).toThrow();
      expect((parseYaml(repaired) as { openapi: string }).openapi).toBe("3.1.0");
    }
  });

  it.skipIf(POSIX_ONLY).each([
    ["a missing spec", null],
    ["unreadable text", "{ [\n"],
  ])("%s reached through an extensionless link to a .json file is repaired as JSON at the link's target", async (_label, text) => {
    const dir = path.join(await fixtures(), "base");
    const target = path.join(dir, "contract.json");
    if (text !== null) await writeFile(target, text);
    await symlink("contract.json", path.join(dir, "contract"));

    expect((await run(["check", "--spec", "contract", "--write"], dir)).code).toBe(0);
    expect((await lstat(path.join(dir, "contract"))).isSymbolicLink()).toBe(true);
    expect((JSON.parse(await readFile(target, "utf8")) as { openapi: string }).openapi).toBe("3.1.0");
  });
});

describe("apifn check: effective schemas resolve references and keep literal data (round 4)", () => {
  function doc(schemas: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, never> {
    return { openapi: "3.1.0", info: { title: "S", version: "1.0.0" }, paths: {}, components: { schemas, ...extra } } as never;
  }
  const schemasOf = (value: ReturnType<typeof comparable>) => value.components?.schemas as Record<string, Record<string, unknown>>;

  it("unevaluatedProperties beside a $ref sees the properties its target evaluates", () => {
    const target = { type: "object", properties: { id: { type: "string" } } };
    const merged = comparable(doc({ A: target, B: { $ref: "#/components/schemas/A", unevaluatedProperties: false } }));
    expect(schemasOf(merged).B).toEqual({ ...target, unevaluatedProperties: false });
    // The target's own unevaluatedProperties cannot see a sibling's properties: still refused.
    const closedTarget = { ...target, unevaluatedProperties: false };
    expect(() =>
      comparable(doc({ A: closedTarget, B: { $ref: "#/components/schemas/A", properties: { extra: { type: "string" } } } }))
    ).toThrow("changes what");
  });

  it("number with [number, integer] is number, so the equivalent inline schema has no breaking change", () => {
    const viaRef = comparable(doc({ A: { type: ["number", "integer"] }, B: { $ref: "#/components/schemas/A", type: "number" } }));
    expect(schemasOf(viaRef).B.type).toBe("number");
    const inline = comparable(doc({ A: { type: ["number", "integer"] }, B: { type: "number" } }));
    expect(diffOpenAPI(inline, viaRef).breaking).toHaveLength(0);
  });

  it("a $ref key in literal data is data; a genuine Example Object reference is resolved", () => {
    const literal = { $ref: "#/components/schemas/A" };
    const merged = comparable(
      doc(
        {
          A: { type: "string" },
          B: { type: "object", example: literal, default: { $ref: "#/nowhere" }, "x-sample": { $ref: "#/nowhere" }, examples: [literal] },
          C: { type: "object", properties: { default: { $ref: "#/components/schemas/A" } } },
        },
        {
          examples: { E: { summary: "e", value: { $ref: "#/nowhere" } } },
          requestBodies: { R: { content: { "application/json": { schema: { type: "object" }, examples: { e: { $ref: "#/components/examples/E" } } } } } },
        }
      )
    );
    expect(schemasOf(merged).B).toMatchObject({ example: literal, default: { $ref: "#/nowhere" }, examples: [literal] });
    expect(schemasOf(merged).C.properties).toEqual({ default: { type: "string" } });
    const body = (merged.components as Record<string, Record<string, Record<string, unknown>>>).requestBodies.R;
    expect(body).toMatchObject({ content: { "application/json": { examples: { e: { summary: "e", value: { $ref: "#/nowhere" } } } } } });
  });

  it("a fragment inside a schema resource with its own $id resolves in that resource", () => {
    const resource = {
      $id: "https://example.com/schemas/r",
      type: "object",
      $defs: { X: { type: "string", minLength: 2 } },
      properties: { x: { $ref: "#/$defs/X" } },
    };
    const merged = comparable(doc({ R: resource }));
    expect((schemasOf(merged).R.properties as Record<string, unknown>).x).toEqual({ type: "string", minLength: 2 });
  });

  it("a $ref that leaves the document is refused where it is a reference, and is data inside literal data", () => {
    expect(() => comparable(doc({ B: { $ref: "other.yml#/x" } }))).toThrow("outside the document");
    const literal = comparable(doc({ B: { type: "object", example: { $ref: "other.yml#/x" } } }));
    expect(schemasOf(literal).B.example).toEqual({ $ref: "other.yml#/x" });
  });
});

describe("apifn check: the git baseline is the pinned object (round 4)", () => {
  async function gitBase(): Promise<{ root: string; service: string; baseText: string; headText: string }> {
    const root = await fixtures();
    git(root, "init", "-q");
    const service = path.join(root, "breaking");
    await commitSpec(path.join(root, "base"));
    await commitSpec(service);
    const baseText = await readFile(path.join(root, "base", SPEC), "utf8");
    const headText = await readFile(path.join(service, SPEC), "utf8");
    await writeFile(path.join(service, SPEC), baseText);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "base contract");
    await writeFile(path.join(service, SPEC), headText);
    return { root, service, baseText, headText };
  }

  it("a refs/replace object cannot substitute the base contract", async () => {
    const { root, service, headText } = await gitBase();
    const original = git(root, "rev-parse", "HEAD:breaking/.apifn/openapi.yml").trim();
    const decoy = path.join(root, "decoy.yml");
    await writeFile(decoy, headText);
    const replacement = git(root, "hash-object", "-w", decoy).trim();
    git(root, "replace", original, replacement);

    const { code, report } = await runJson(["check", "--base", "HEAD"], service);
    expect(report.base.status).toBe("compared");
    expect(report.breaking.length).toBeGreaterThan(0);
    expect(code).toBe(1);
  });

  it.skipIf(POSIX_ONLY).each(["contract.yml/", "contract.yml/."])(
    "a tracked spec link to a file followed by %j exits 2, never reads the file",
    async (target) => {
      const { root, service, baseText } = await gitBase();
      await writeFile(path.join(service, ".apifn", "contract.yml"), baseText);
      await rm(path.join(service, SPEC));
      await symlink(target, path.join(service, SPEC));
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "spec link with a trailing slash");
      await rm(path.join(service, SPEC));
      await commitSpec(service);

      const result = await run(["check", "--base", "HEAD"], service);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("needs it to be a directory");
    }
  );

  it("an unrelated tracked name that is not UTF-8 beside the spec path does not stop the walk", async () => {
    const { root, service } = await gitBase();
    const blob = git(root, "rev-parse", "HEAD:breaking/.apifn/openapi.yml").trim();
    const listing = execFileSync("git", ["ls-tree", "HEAD"], { cwd: root });
    const entry = Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), Buffer.from([0x6c, 0x61, 0x74, 0x69, 0x6e, 0xe9, 0x2e, 0x79, 0x6d, 0x6c]), Buffer.from("\n")]);
    const tree = execFileSync("git", ["mktree"], { cwd: root, input: Buffer.concat([listing, entry]) }).toString().trim();
    const commit = git(root, "commit-tree", tree, "-p", "HEAD", "-m", "latin-1 sibling").trim();
    git(root, "update-ref", "HEAD", commit);

    const { code, report } = await runJson(["check", "--base", "HEAD"], service);
    expect(report.base.status).toBe("compared");
    expect(report.breaking.length).toBeGreaterThan(0);
    expect(code).toBe(1);
  });

  it("a base spec at the ref that is not UTF-8 exits 2", async () => {
    const { root, service, baseText } = await gitBase();
    await writeFile(path.join(service, SPEC), Buffer.concat([Buffer.from(baseText), Buffer.from("# \xff\n", "latin1")]));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "malformed base");
    await commitSpec(service);

    const result = await run(["check", "--base", "HEAD"], service);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not valid UTF-8");
  });
});

describe("apifn check: inputs are read strictly and without blocking (round 4)", () => {
  async function based(): Promise<{ root: string; dir: string; baseText: string }> {
    const root = await fixtures();
    await commitSpec(path.join(root, "base"));
    const dir = path.join(root, "breaking");
    await commitSpec(dir);
    return { root, dir, baseText: await readFile(path.join(root, "base", SPEC), "utf8") };
  }

  it("a base file that is not UTF-8 exits 2; a correctly encoded U+FFFD is read", async () => {
    const { dir, baseText } = await based();
    await writeFile(path.join(dir, "bad.yml"), Buffer.concat([Buffer.from(baseText), Buffer.from("# \xff\xfe\n", "latin1")]));
    const bad = await run(["check", "--base-spec", "bad.yml"], dir);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("not valid UTF-8");

    await writeFile(path.join(dir, "good.yml"), `${baseText}# �\n`);
    const good = await runJson(["check", "--base-spec", "good.yml"], dir);
    expect(good.report.base.status).toBe("compared");
  });

  it("a committed spec that is not UTF-8 is unparseable drift, and --write repairs it", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const generated = await readFile(path.join(dir, SPEC), "utf8");
    await writeFile(path.join(dir, SPEC), Buffer.concat([Buffer.from(generated), Buffer.from("# \xff\n", "latin1")]));

    const { code, report } = await runJson(["check"], dir);
    expect({ code, driftState: report.driftState }).toEqual({ code: 1, driftState: "unparseable" });
    expect((await run(["check", "--write"], dir)).code).toBe(0);
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(generated);
  });

  it.skipIf(POSIX_ONLY)("a FIFO base spec or committed spec with no writer exits 2 promptly instead of blocking", async () => {
    const { dir } = await based();
    execFileSync("mkfifo", [path.join(dir, "base.fifo")]);
    const jiti = path.join(path.dirname(createRequire(import.meta.url).resolve("jiti/package.json")), "lib", "jiti-cli.mjs");
    const bin = path.join(import.meta.dirname, "..", "src", "bin.ts");
    for (const args of [["--base-spec", "base.fifo"], ["--spec", "base.fifo"]]) {
      const child = spawn(process.execPath, [jiti, bin, "check", ...args], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      const code = await new Promise<number | null>((resolve) => child.on("close", (exit) => resolve(exit)));
      clearTimeout(timer);
      expect({ args, code, stderr }).toEqual({ args, code: 2, stderr: expect.stringContaining("not a regular file") });
    }
  }, 40_000);

  it("an HTTP error status whose body stalls exits 2 and releases the connection", async () => {
    const { dir } = await based();
    let closed = false;
    const server = createServer((req, res) => {
      req.socket.on("close", () => {
        closed = true;
      });
      res.writeHead(500, { "content-type": "text/plain" });
      res.write("partial error body");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const errors: string[] = [];
      const code = await runCheckCommand({
        cwd: dir,
        config: { router: "./router.ts", openapi: { info: { title: "Check fixture", version: "1.1.0" } } },
        output: { error: (message: string) => errors.push(message) } as unknown as Output,
        baseSpec: `http://127.0.0.1:${port}/openapi.yml`,
        httpTimeoutMs: 10_000,
        writeStdout: () => {},
      });
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("HTTP 500");
      const deadline = Date.now() + 2_000;
      while (!closed && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(closed).toBe(true);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("apifn check: an HTTP error status cancels its body (round 4)", () => {
  it("fetchBounded cancels the unread body of a non-success response before it throws", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull: () => new Promise(() => {}),
      cancel: () => {
        cancelled = true;
      },
    });
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 503 }));
    try {
      await expect(fetchBounded("http://127.0.0.1:9/openapi.yml", 10_000)).rejects.toThrow("HTTP 503");
      expect(cancelled).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("apifn check: the strict parser rejects tagged collections and stays linear (round 4)", () => {
  it.each(["!!set { a: null }", "!!omap [ { a: 1 } ]", "!!pairs [ { a: 1 } ]"])("a %s collection has no faithful JSON form", (tagged) => {
    expect(() => parseContract(`openapi: 3.1.0\nx: ${tagged}\n`)).toThrow("collection");
  });

  it("plain !!map and !!seq tags are read", () => {
    expect(parseContract("openapi: 3.1.0\nx: !!map { a: !!seq [1] }\n")).toEqual({ openapi: "3.1.0", x: { a: [1] } });
  });

  it("a tagged base exits 2 and a tagged committed spec is unparseable drift", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const generated = await readFile(path.join(dir, SPEC), "utf8");
    await writeFile(path.join(dir, "tagged.yml"), `${generated}x-set: !!set { a: null }\n`);
    expect((await run(["check", "--base-spec", "tagged.yml"], dir)).code).toBe(2);
    await writeFile(path.join(dir, SPEC), `${generated}x-set: !!set { a: null }\n`);
    const { code, report } = await runJson(["check"], dir);
    expect({ code, driftState: report.driftState }).toEqual({ code: 1, driftState: "unparseable" });
  });

  it("duplicate keys in a wide mapping are found in linear time, literal and via an alias", () => {
    const wide = (count: number) => Array.from({ length: count }, (_, i) => `  k${i}: ${i}`).join("\n");
    const started = performance.now();
    expect(Object.keys(parseContract(`openapi: 3.1.0\nx:\n${wide(40_000)}\n`).x as object)).toHaveLength(40_000);
    // Pairwise key comparison takes several seconds here; one pass takes well under one.
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(() => parseContract(`openapi: 3.1.0\nx:\n${wide(3)}\n  k1: again\n`)).toThrow('two keys that are both "k1"');
    expect(() => parseContract(`openapi: 3.1.0\na: &k k1\nx:\n${wide(3)}\n  *k : again\n`)).toThrow("alias");
  });

  it("an aliased numeric scalar is charged its source length each time it appears", () => {
    const long = `1.${"0".repeat(100_000)}`;
    const aliases = Array.from({ length: 700 }, (_, i) => `  - *n # ${i}`).join("\n");
    expect(() => parseContract(`openapi: 3.1.0\nn: &n ${long}\nx:\n${aliases}\n`)).toThrow("characters of text");
    const few = Array.from({ length: 50 }, () => "  - *n").join("\n");
    expect((parseContract(`openapi: 3.1.0\nn: &n ${long}\nx:\n${few}\n`).x as number[]).every((value) => value === 1)).toBe(true);
  });
});

describe("apifn check: publication binds the paths it read and the directories it made (round 4)", () => {
  const CONFIG = { router: "./router.ts", openapi: { info: { title: "Check fixture", version: "1.0.0" } } };

  it.skipIf(POSIX_ONLY)("a dangling spec link retargeted while the base loads exits 2 and creates nothing", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const baseText = await readFile(path.join(dir, SPEC), "utf8");
    await rm(path.join(dir, SPEC));
    await symlink("a.yml", path.join(dir, SPEC));
    const server = createServer((_req, res) => {
      // The link moves from missing a.yml to missing b.yml while the base is being read.
      rmSync(path.join(dir, SPEC));
      symlinkSync("b.yml", path.join(dir, SPEC));
      res.end(baseText);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const errors: string[] = [];
      const code = await runCheckCommand({
        cwd: dir,
        config: CONFIG,
        output: { error: (message: string) => errors.push(message) } as unknown as Output,
        baseSpec: `http://127.0.0.1:${port}/openapi.yml`,
        write: true,
        writeStdout: () => {},
      });
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("changed while apifn check ran");
      expect(existsSync(path.join(dir, ".apifn", "a.yml"))).toBe(false);
      expect(existsSync(path.join(dir, ".apifn", "b.yml"))).toBe(false);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it.skipIf(POSIX_ONLY)("a spec link through a regular file and `..` exits 2 instead of writing beside the file", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"));
    await writeFile(path.join(dir, ".apifn", "file.txt"), "a file\n");
    await symlink("file.txt/../x.yml", path.join(dir, SPEC));

    const result = await run(["check", "--write"], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not a directory");
    expect(existsSync(path.join(dir, ".apifn", "x.yml"))).toBe(false);
  });

  it("rollback leaves a directory another process put in place of one this run created", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    const created = path.join(dir, "new", "deep");
    const errors: string[] = [];
    const code = await runCheckCommand({
      cwd: dir,
      config: CONFIG,
      output: { error: (message: string) => errors.push(message) } as unknown as Output,
      specPath: path.join("new", "deep", "openapi.yml"),
      write: true,
      writeStdout: () => {},
      publishHook: (step) => {
        if (step !== "backup") return;
        // Another process moves this run's directory (with its staged file) away and makes its own.
        renameSync(created, path.join(dir, "moved"));
        execFileSync("mkdir", [created]);
      },
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("changed while apifn check ran");
    expect(statSync(created).isDirectory()).toBe(true);
  });

  it("file identities are bigint stats, so device and inode numbers above 2^53 stay distinct", async () => {
    const dir = await tempDir("apifn-check-bigint-");
    const file = path.join(dir, "spec.yml");
    await writeFile(file, "openapi: 3.1.0\n");
    const observed = observe(file);
    expect(typeof observed.state?.ino).toBe("bigint");
    expect(typeof observed.anchor.dev).toBe("bigint");
    expect(observed.state?.ino).toBe(statSync(file, { bigint: true }).ino);
  });
});

describe("apifn check: the router module is the one file loaded (round 4)", () => {
  it("a router that moves itself while it loads still generates the same bytes, and is the file check protects", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const expected = await readFile(path.join(dir, SPEC), "utf8");
    const source = await readFile(path.join(dir, "router.ts"), "utf8");
    const moving = path.join(dir, "moving.ts");
    await writeFile(moving, `import { renameSync } from "node:fs";\nrenameSync(${JSON.stringify(moving)}, ${JSON.stringify(path.join(dir, "moved.ts"))});\n${source}`);

    const generated = await run(["generate", "./moving", "--output", "out.yml"], dir);
    expect(generated.code).toBe(0);
    expect(await readFile(path.join(dir, "out.yml"), "utf8")).toBe(expected);

    const loaded = await loadRouterModule("./router", dir);
    expect(realpathSync(loaded.file)).toBe(realpathSync(path.join(dir, "router.ts")));
    const report = await run(["check", "./router", "--report", "router.ts"], dir);
    expect(report.code).toBe(2);
    expect(report.stderr).toContain("the router module");
  });
});

describe("apifn check: argument handling stays in step with cac (round 4)", () => {
  it("an unknown leading option with an operand before check --help is a usage error, not help", async () => {
    const root = await fixtures();
    const result = await run(["--unknown", "operand", "check", "--help"], path.join(root, "base"));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown option `--unknown`");
  });

  it.each([["--no-unknown"], ["--unknown", "operand"]])(
    "%s before a malformed check --help is a usage error, and check --help alone still prints help",
    async (...leading) => {
      const root = await fixtures();
      const dir = path.join(root, "base");
      const malformed = await run([...leading, "check", "--format", "nope", "--help"], dir);
      expect(malformed.code).toBe(2);
      expect(malformed.stderr).not.toBe("");
      expect((await run(["check", "--help"], dir)).code).toBe(0);
    }
  );

  it("a dash-prefixed path reads the same separated and attached; a missing value is still an error", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    await cp(path.join(dir, SPEC), path.join(dir, "-odd.yml"));
    const separated = await runJson(["check", "--spec", "-odd.yml", "--base-spec", "-odd.yml"], dir);
    const attached = await runJson(["check", "--spec=-odd.yml", "--base-spec=-odd.yml"], dir);
    expect(separated).toEqual(attached);
    expect({ code: separated.code, status: separated.report.base.status }).toEqual({ code: 0, status: "compared" });
    const missing = await run(["check", "--spec", "--write"], dir);
    expect({ code: missing.code, stderr: missing.stderr }).toEqual({ code: 2, stderr: expect.stringContaining("--spec takes one value") });
  });
});

describe("apifn check: Markdown keeps every line ending inside its field (round 4)", () => {
  it.each(["\r", "\r\n", "\n"])("a version with %j stays on the Versions row; JSON keeps it", async (ending) => {
    const dir = (await fixtures()) + "/base";
    const version = `1.0.0${ending}## injected`;
    const config = { router: "./router.ts", openapi: { info: { title: "Check fixture", version } } };
    const outputs: Record<string, string> = {};
    for (const format of ["markdown", "json"]) {
      let stdout = "";
      await runCheckCommand({
        cwd: dir,
        config,
        format,
        output: { error: () => {} } as unknown as Output,
        writeStdout: (text) => {
          stdout += text;
        },
      });
      outputs[format] = stdout;
    }
    expect(outputs.markdown.startsWith(CHECK_REPORT_MARKER)).toBe(true);
    expect(outputs.markdown).not.toContain("\r");
    expect(outputs.markdown.split("\n").some((line) => line.startsWith("## injected"))).toBe(false);
    expect((JSON.parse(outputs.json) as CheckReport).versions.head).toBe(version);
  });
});

describe("apifn check: scope, resources and literal data hold on base and head alike (round 5)", () => {
  const GET_SCHEMA = "#/paths/~1users/get/responses/200/content/application~1json/schema";

  /** GET /users answers `response`; POST /users takes `body` (both TypeScript object literals). */
  async function usersService(response: string, body: string): Promise<string> {
    const dir = await tempDir("apifn-check-round5-");
    await writeFile(
      path.join(dir, "router.ts"),
      `export default { getRoutes() { return [
  { method: "GET", path: "/users", handler: async () => Response.json({}), meta: { operationId: "listUsers", responses: { 200: { description: "ok", schema: ${response} } } } },
  { method: "POST", path: "/users", handler: async () => Response.json({}), meta: { operationId: "createUser", body: ${body}, responses: { 200: { description: "ok" } } } },
]; } };
`
    );
    await writeFile(
      path.join(dir, "apifn.config.ts"),
      `export default { router: "./router.ts", openapi: { info: { title: "Round 5", version: "1.0.0" } } };\n`
    );
    await commitSpec(dir);
    return dir;
  }

  const TARGET = `{ type: "object", properties: { x: { type: "object", properties: { a: { type: "string" } } } } }`;

  it("unevaluatedProperties in a nested property merged under a $ref does not see the target's properties", async () => {
    // The inline request accepts {"x":{"a":"v"}}; the $ref form rejects it (x's sibling schema
    // evaluates no property of its own), so the same-version change must not pass.
    const base = await usersService(
      TARGET,
      `{ type: "object", properties: { x: { type: "object", properties: { a: { type: "string" } }, unevaluatedProperties: false } } }`
    );
    const head = await usersService(TARGET, `{ $ref: "${GET_SCHEMA}", properties: { x: { unevaluatedProperties: false } } }`);
    const result = await run(["check", "--base-spec", path.join(base, SPEC)], head);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("changes what 'unevaluatedProperties' applies to");
  });

  it("unevaluatedProperties directly beside a $ref still sees the target's properties", async () => {
    const base = await usersService(
      TARGET,
      `{ type: "object", properties: { x: { type: "object", properties: { a: { type: "string" } } } }, unevaluatedProperties: false }`
    );
    const head = await usersService(TARGET, `{ $ref: "${GET_SCHEMA}", unevaluatedProperties: false }`);
    const { code, report } = await runJson(["check", "--base-spec", path.join(base, SPEC)], head);
    expect({ code, status: report.base.status, breaking: report.breaking }).toEqual({ code: 0, status: "compared", breaking: [] });
  });

  const RESOURCE = `{ $id: "https://example.com/schemas/user", type: "object", $defs: { Name: { type: "string", minLength: 2 } }, properties: { name: { $ref: "#/$defs/Name" } } }`;

  it("an unchanged contract with a resource-relative $ref validates without a base and against itself", async () => {
    const dir = await usersService(RESOURCE, `{ type: "object" }`);
    const alone = await runJson(["check"], dir);
    expect({ code: alone.code, valid: alone.report.valid }).toEqual({ code: 0, valid: true });
    const self = await runJson(["check", "--base-spec", SPEC], dir);
    expect({ code: self.code, status: self.report.base.status, breaking: self.report.breaking }).toEqual({
      code: 0,
      status: "compared",
      breaking: [],
    });
  });

  it("a resource-relative $ref with siblings is only respelled for the validator; the comparison alone may refuse it", async () => {
    const conflicting = `{ $id: "https://example.com/schemas/u", type: "object", $defs: { N: { type: "string", pattern: "^a" } }, properties: { n: { $ref: "#/$defs/N", pattern: "b$" } } }`;
    const dir = await usersService(conflicting, `{ type: "object" }`);
    const alone = await runJson(["check"], dir);
    expect({ code: alone.code, valid: alone.report.valid }).toEqual({ code: 0, valid: true });
    const self = await run(["check", "--base-spec", SPEC], dir);
    expect(self.code).toBe(2);
    expect(self.stderr).toContain("cannot combine");
  });

  it("a resource-relative $ref is diffed against its target in that resource", async () => {
    const base = await usersService(RESOURCE, `{ type: "object" }`);
    const head = await usersService(RESOURCE.replace("minLength: 2", "minLength: 2, maxLength: 8"), `{ $ref: "${GET_SCHEMA}/properties/name" }`);
    const result = await run(["check", "--base-spec", path.join(base, SPEC)], head);
    expect(result.stderr).toBe("");
    expect([0, 1]).toContain(result.code);
  });

  it("extension entries, Link Object payloads and Example values are data: never followed, never refused", async () => {
    const dir = await usersService(`{ type: "object" }`, `{ type: "object" }`);
    const doc = parseYaml(await readFile(path.join(dir, SPEC), "utf8")) as Record<string, any>;
    const external = { $ref: "missing-file.yml#/x" };
    doc.paths["x-sample"] = external;
    doc.paths["/users"].get.responses["200"].links = {
      Create: { operationId: "createUser", parameters: { p: "$request.body#/id" }, requestBody: external },
    };
    doc.components = { examples: { E: { summary: "e", value: external } } };
    await writeFile(path.join(dir, "literal.yml"), toYaml(doc));
    const { code, report } = await runJson(["check", "--base-spec", "literal.yml"], dir);
    expect({ code, status: report.base.status, breaking: report.breaking }).toEqual({ code: 0, status: "compared", breaking: [] });
    // A genuine reference that leaves the document is still refused before anything reads it.
    doc.paths["/users"].get.responses["200"].links.Create = external;
    await writeFile(path.join(dir, "literal.yml"), toYaml(doc));
    const refused = await run(["check", "--base-spec", "literal.yml"], dir);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("outside the document");
  });
});

describe("apifn check: Responses extensions and Link payloads are copied as data (round 5)", () => {
  it("a $ref in a Responses extension or a Link Object payload is not resolved; a Link Object $ref is", () => {
    const dangling = { $ref: "#/nowhere" };
    const merged = comparable({
      openapi: "3.1.0",
      info: { title: "S", version: "1.0.0" },
      paths: {
        "/u": {
          get: {
            responses: {
              "x-sample": dangling,
              "200": { description: "ok", links: { L: { operationId: "getU", requestBody: dangling }, M: { $ref: "#/components/links/M" } } },
            },
          },
        },
      },
      components: { links: { M: { operationId: "getU", parameters: { p: "$request.path.id" } } } },
    } as never) as unknown as Record<string, any>;
    const withCallbacks = comparable({
      openapi: "3.1.0",
      info: { title: "S", version: "1.0.0" },
      paths: {
        "/u": {
          post: {
            responses: { "200": { description: "ok" } },
            callbacks: { onEvent: { "x-sample": { $ref: "other.yml#/x" }, "{$request.body#/url}": { $ref: "#/components/pathItems/P" } }, onRef: { $ref: "#/components/callbacks/C" } },
          },
        },
      },
      components: {
        pathItems: { P: { post: { responses: { "200": { description: "ok" } } } } },
        callbacks: { C: { "x-note": dangling, "{$request.body#/url}": { $ref: "#/components/pathItems/P" } } },
      },
    } as never) as unknown as Record<string, any>;
    const callbacks = withCallbacks.paths["/u"].post.callbacks;
    const pathItem = { post: { responses: { "200": { description: "ok" } } } };
    expect(callbacks.onEvent).toEqual({ "x-sample": { $ref: "other.yml#/x" }, "{$request.body#/url}": pathItem });
    expect(callbacks.onRef).toEqual({ "x-note": dangling, "{$request.body#/url}": pathItem });
    const responses = merged.paths["/u"].get.responses;
    expect(responses["x-sample"]).toEqual(dangling);
    expect(responses["200"].links).toEqual({
      L: { operationId: "getU", requestBody: dangling },
      M: { operationId: "getU", parameters: { p: "$request.path.id" } },
    });
  });
});

describe("apifn check: directory requirements and created directories survive binding (round 5)", () => {
  const CONFIG = { router: "./router.ts", openapi: { info: { title: "Check fixture", version: "1.0.0" } } };

  it.skipIf(POSIX_ONLY).each([["/"], ["/."]])(
    "a spec link to the committed spec followed by %s is never read or repaired",
    async (suffix) => {
      const root = await fixtures();
      const dir = path.join(root, "base");
      await commitSpec(dir);
      const before = await readFile(path.join(dir, SPEC), "utf8");
      await symlink(`${SPEC}${suffix}`, path.join(dir, "alias.yml"));
      for (const extra of [[], ["--write"]]) {
        const result = await run(["check", "--spec", "alias.yml", ...extra], dir);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("not a directory");
      }
      expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(before);
      const operand = await run(["check", "--spec", `${SPEC}${suffix}`, "--write"], dir);
      expect(operand.code).toBe(2);
      expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(before);
    }
  );

  it.skipIf(POSIX_ONLY)("a stable dangling spec link to a missing file stays repairable", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"));
    await symlink("real.yml", path.join(dir, SPEC));
    expect((await run(["check"], dir)).code).toBe(1);
    expect((await run(["check", "--write"], dir)).code).toBe(0);
    expect((await lstat(path.join(dir, SPEC))).isSymbolicLink()).toBe(true);
    expect((await run(["check"], dir)).code).toBe(0);
  });

  async function stagedFailure(onMkdir: (created: string, dir: string) => void): Promise<{ dir: string; code: number; errors: string }> {
    const root = await fixtures();
    const dir = path.join(root, "base");
    const errors: string[] = [];
    const code = await runCheckCommand({
      cwd: dir,
      config: CONFIG,
      output: { error: (message: string) => errors.push(message) } as unknown as Output,
      specPath: path.join("new", "deep", "openapi.yml"),
      write: true,
      writeStdout: () => {},
      publishHook: (step, created) => {
        if (step === "mkdir") onMkdir(created, dir);
      },
    });
    return { dir, code, errors: errors.join("\n") };
  }

  it("a failure while staging removes every directory the run created so far", async () => {
    const { dir, code, errors } = await stagedFailure((created) => {
      if (path.basename(created) === "deep") throw new Error("injected staging failure");
    });
    expect(code).toBe(2);
    expect(errors).toContain("injected staging failure");
    expect(existsSync(path.join(dir, "new"))).toBe(false);
  });

  it("a failure while staging keeps a directory another process put in place of one the run created", async () => {
    const { dir, code } = await stagedFailure((created, root) => {
      if (path.basename(created) !== "deep") return;
      renameSync(path.join(root, "new"), path.join(root, "moved"));
      execFileSync("mkdir", [path.join(root, "new")]);
      throw new Error("injected staging failure");
    });
    expect(code).toBe(2);
    expect(statSync(path.join(dir, "new")).isDirectory()).toBe(true);
  });
});

describe("apifn check: output aliases are judged from the destination directory itself (round 6, 7)", () => {
  const NO_EVIDENCE = "cannot show whether the directory there folds them";

  /** The base fixture with a committed (or missing) spec and the given entries in .apifn. */
  async function destination(entries: (apifn: string) => void, spec: "committed" | "missing"): Promise<string> {
    const root = await fixtures();
    const dir = path.join(root, "base");
    if (spec === "committed") await commitSpec(dir);
    await mkdir(path.join(dir, ".apifn"), { recursive: true });
    entries(path.join(dir, ".apifn"));
    return dir;
  }

  it("a report whose name differs from an existing spec only in case: the spec where the filesystem folds case, a new file where it does not", async () => {
    const dir = await destination(() => {}, "committed");
    const before = await readFile(path.join(dir, SPEC), "utf8");
    const report = path.join(".apifn", "OpenAPI.yml");
    const result = await run(["check", "--report", report], dir);
    if (CASE_INSENSITIVE_FS) {
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("is the spec itself");
    } else {
      expect(result.code).toBe(0);
      expect(await readFile(path.join(dir, report), "utf8")).toContain("apifn check");
    }
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(before);
  });

  it("an existing report and a missing spec whose names differ only in case: refused where they are one file, both kept apart where not", async () => {
    const dir = await destination((apifn) => writeFileSync(path.join(apifn, "OpenAPI.yml"), "old report\n"), "missing");
    const report = path.join(".apifn", "OpenAPI.yml");
    const result = await run(["check", "--write", "--report", report], dir);
    if (CASE_INSENSITIVE_FS) {
      expect(result.code).toBe(2);
      expect(await readFile(path.join(dir, report), "utf8")).toBe("old report\n");
    } else {
      expect(result.code).toBe(0);
      expect(await readFile(path.join(dir, report), "utf8")).toBe(result.stdout);
      expect(parseYaml(await readFile(path.join(dir, SPEC), "utf8"))).toHaveProperty("openapi");
    }
  });

  for (const write of [false, true]) {
    it(`an empty destination directory is probed: a case-variant report of the missing spec is the spec where the directory folds case, and nothing is left behind${write ? " (--write)" : ""}`, async () => {
      const dir = await destination(() => {}, "missing");
      const report = path.join(".apifn", "OpenAPI.yml");
      const result = await run(["check", "--report", report, ...(write ? ["--write"] : [])], dir);
      if (CASE_INSENSITIVE_FS) {
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("is the spec itself");
        expect(result.stdout).toBe("");
        expect(await readdir(path.join(dir, ".apifn"))).toEqual([]);
      } else {
        expect(result.code).toBe(write ? 0 : 1);
        expect(await readFile(path.join(dir, report), "utf8")).toBe(result.stdout);
        expect((await readdir(path.join(dir, ".apifn"))).sort()).toEqual(write ? ["OpenAPI.yml", "openapi.yml"] : ["OpenAPI.yml"]);
      }
    });
  }

  it("an unrelated entry does not decide; only the probe of the two spellings does", async () => {
    const dir = await destination((apifn) => writeFileSync(path.join(apifn, "Probe.txt"), ""), "missing");
    const report = path.join(".apifn", "OpenAPI.yml");
    const result = await run(["check", "--write", "--report", report], dir);
    if (CASE_INSENSITIVE_FS) {
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("is the spec itself");
      expect((await readdir(path.join(dir, ".apifn"))).sort()).toEqual(["Probe.txt"]);
    } else {
      expect(result.code).toBe(0);
      expect(await readFile(path.join(dir, report), "utf8")).toBe(result.stdout);
      expect(parseYaml(await readFile(path.join(dir, SPEC), "utf8"))).toHaveProperty("openapi");
    }
  });

  it.skipIf(CASE_INSENSITIVE_FS)("two listed entries that differ in case are distinct names even as hard links of one inode", async () => {
    const dir = await destination((apifn) => {
      writeFileSync(path.join(apifn, "Probe.txt"), "");
      linkSync(path.join(apifn, "Probe.txt"), path.join(apifn, "probe.txt"));
    }, "missing");
    const report = path.join(".apifn", "OpenAPI.yml");
    const result = await run(["check", "--write", "--report", report], dir);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(await readFile(path.join(dir, report), "utf8")).toBe(result.stdout);
    expect(parseYaml(await readFile(path.join(dir, SPEC), "utf8"))).toHaveProperty("openapi");
  });

  const NFC_SPEC = path.join(".apifn", "café.yml");
  const NFD_REPORT = path.join(".apifn", "café.yml");

  it("names that differ below a directory that does not exist yet exit 2 before either output is written", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    for (const [spec, report] of [[NFC_SPEC, NFD_REPORT], [SPEC, path.join(".apifn", "OpenAPI.yml")]]) {
      const result = await run(["check", "--spec", spec, "--write", "--report", report], dir);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(NO_EVIDENCE);
      expect(existsSync(path.join(dir, ".apifn"))).toBe(false);
    }
    expect((await readdir(dir)).filter((name) => name.startsWith(".apifn-probe"))).toEqual([]);
  });

  it("a differing directory component is probed where it would be created", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    const result = await run(["check", "--spec", path.join("Out", "openapi.yml"), "--write", "--report", path.join("out", "openapi.yml")], dir);
    if (CASE_INSENSITIVE_FS) {
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("is the spec itself");
      expect(existsSync(path.join(dir, "out"))).toBe(false);
    } else {
      expect(result.code).toBe(0);
      expect(await readFile(path.join(dir, "out", "openapi.yml"), "utf8")).toBe(result.stdout);
      expect(parseYaml(await readFile(path.join(dir, "Out", "openapi.yml"), "utf8"))).toHaveProperty("openapi");
    }
    expect((await readdir(dir)).filter((name) => name.startsWith(".apifn-probe"))).toEqual([]);
  });

  for (const entry of ["naïve.txt", "Å"]) {
    it(`names equal after NFC are judged by their own spellings, not by the entry ${JSON.stringify(entry)}`, async () => {
      const dir = await destination((apifn) => writeFileSync(path.join(apifn, entry), ""), "missing");
      const result = await run(["check", "--spec", NFC_SPEC, "--write", "--report", NFD_REPORT], dir);
      const listed = (await readdir(path.join(dir, ".apifn"))).map((name) => name.normalize("NFC"));
      expect(listed.filter((name) => name.startsWith(".apifn-probe"))).toEqual([]);
      if (NORMALIZATION_INSENSITIVE_FS) {
        expect(result.code).toBe(2);
        expect(result.stderr).toContain("is the spec itself");
        expect(listed).toEqual([entry.normalize("NFC")]);
      } else {
        expect(result.code).toBe(0);
        expect(await readFile(path.join(dir, NFD_REPORT), "utf8")).toBe(result.stdout);
        expect(parseYaml(await readFile(path.join(dir, NFC_SPEC), "utf8"))).toHaveProperty("openapi");
      }
    });
  }

  it.skipIf(NORMALIZATION_INSENSITIVE_FS)("names equal after NFC are distinct where the directory lists both spellings of an entry", async () => {
    const dir = await destination((apifn) => {
      writeFileSync(path.join(apifn, "naïve.txt"), "");
      writeFileSync(path.join(apifn, "naïve.txt"), "");
    }, "missing");
    const result = await run(["check", "--spec", NFC_SPEC, "--write", "--report", NFD_REPORT], dir);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(dir, NFD_REPORT), "utf8")).toBe(result.stdout);
    expect(parseYaml(await readFile(path.join(dir, NFC_SPEC), "utf8"))).toHaveProperty("openapi");
  });

  it.skipIf(POSIX_ONLY || IS_ROOT)("a directory the probe cannot write in gives no answer: exit 2 with nothing written", async () => {
    const dir = await destination(() => {}, "missing");
    const apifn = path.join(dir, ".apifn");
    await chmod(apifn, 0o555);
    try {
      for (const write of [false, true]) {
        const result = await run(["check", "--report", path.join(".apifn", "OpenAPI.yml"), ...(write ? ["--write"] : [])], dir);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain(NO_EVIDENCE);
        expect(result.stdout).toBe("");
      }
    } finally {
      await chmod(apifn, 0o755);
    }
    expect(await readdir(apifn)).toEqual([]);
  });

  it("a report naming the spec itself is still refused", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const result = await run(["check", "--report", SPEC], dir);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("is the spec itself");
  });
});

describe("apifn check: publication re-checks every protected path after each change it makes (round 8)", () => {
  const CONFIG = { router: "./router.ts", openapi: { info: { title: "Check fixture", version: "1.0.0" } } };

  /**
   * Runs check on the base fixture with a report at .apifn/report.md. `onInstalled` runs right
   * after the report is renamed into place and stands in for a filesystem that makes another name
   * reach it there (a vfat short name or a case fold no name comparison predicts).
   */
  async function checkReaching(
    setup: (dir: string) => Promise<void>,
    onInstalled: (dir: string, report: string) => void,
    extra: { write?: boolean; baseSpec?: string } = {}
  ): Promise<{ dir: string; code: number; errors: string; stdout: string }> {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"), { recursive: true });
    await setup(dir);
    const errors: string[] = [];
    let stdout = "";
    const code = await runCheckCommand({
      cwd: dir,
      config: CONFIG,
      output: { error: (message: string) => errors.push(message) } as unknown as Output,
      reportPath: path.join(".apifn", "report.md"),
      format: "json",
      ...extra,
      writeStdout: (text) => {
        stdout += text;
      },
      publishHook: (step, destination) => {
        if (step === "installed" && destination.endsWith("report.md")) onInstalled(dir, destination);
      },
    });
    return { dir, code, errors: errors.join("\n"), stdout };
  }

  // With --write the missing spec's name is this run's own reservation by then (round 9 covers it).
  for (const write of [false]) {
    it.skipIf(POSIX_ONLY)(`a missing spec name that comes to reach the report is rolled back: exit 2, the spec stays absent, nothing is left${write ? " (--write)" : ""}`, async () => {
      const { dir, code, errors, stdout } = await checkReaching(
        async () => {},
        (root, report) => symlinkSync(report, path.join(root, SPEC)),
        { write }
      );
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(errors).toContain(write ? "reached the output of --write" : "reached the spec .apifn/openapi.yml");
      expect(existsSync(path.join(dir, SPEC))).toBe(false);
      expect(existsSync(path.join(dir, ".apifn", "report.md"))).toBe(false);
      expect((await readdir(path.join(dir, ".apifn"))).sort()).toEqual(["openapi.yml"]);
      expect(await leftovers(path.join(dir, ".apifn"))).toEqual([]);
    });
  }

  it.skipIf(POSIX_ONLY)("a spec link rebound to the published report is caught, the report is rolled back and the new link is kept", async () => {
    const { dir, code, errors, stdout } = await checkReaching(
      async (root) => {
        await commitSpec(root);
        await rename(path.join(root, SPEC), path.join(root, ".apifn", "real.yml"));
        await symlink("real.yml", path.join(root, SPEC));
      },
      (root) => {
        rmSync(path.join(root, SPEC));
        symlinkSync("report.md", path.join(root, SPEC));
      }
    );
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(errors).toContain("reached the spec .apifn/openapi.yml");
    expect(existsSync(path.join(dir, ".apifn", "report.md"))).toBe(false);
    expect((await lstat(path.join(dir, SPEC))).isSymbolicLink()).toBe(true);
    expect(await leftovers(path.join(dir, ".apifn"))).toEqual([]);
  });

  it.skipIf(POSIX_ONLY)("a repaired spec link rebound to the report after its install is caught before stdout, and the new link is kept", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"));
    await writeFile(path.join(dir, ".apifn", "real.yml"), "openapi: 3.1.0\n");
    await symlink("real.yml", path.join(dir, SPEC));
    const errors: string[] = [];
    let stdout = "";
    const code = await runCheckCommand({
      cwd: dir,
      config: CONFIG,
      output: { error: (message: string) => errors.push(message) } as unknown as Output,
      write: true,
      reportPath: path.join(".apifn", "report.md"),
      writeStdout: (text) => {
        stdout += text;
      },
      publishHook: (step, destination) => {
        if (step !== "installed" || !destination.endsWith("real.yml")) return;
        rmSync(path.join(dir, SPEC));
        symlinkSync("report.md", path.join(dir, SPEC));
      },
    });
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(errors.join("\n")).toContain("reached the output of --write");
    expect(errors.join("\n")).not.toContain("changed after apifn check wrote it");
    expect(existsSync(path.join(dir, ".apifn", "report.md"))).toBe(false);
    expect(readlinkSync(path.join(dir, SPEC))).toBe("report.md");
    // The bound destination is still this run's write, so it is restored and its backup removed.
    expect(await readFile(path.join(dir, ".apifn", "real.yml"), "utf8")).toBe("openapi: 3.1.0\n");
    expect(await leftovers(path.join(dir, ".apifn"))).toEqual([]);
  });

  it("an existing spec that a report write changes is caught in a report-only run, and the report is rolled back", async () => {
    let spec = "";
    const { dir, code, errors } = await checkReaching(
      async (root) => {
        await commitSpec(root);
        await writeFile(path.join(root, ".apifn", "report.md"), "previous report\n");
        spec = await readFile(path.join(root, SPEC), "utf8");
      },
      (root) => {
        // The write reached the spec: its bytes changed.
        writeFileSync(path.join(root, SPEC), `${spec}# reached\n`);
      }
    );
    expect(code).toBe(2);
    expect(errors).toContain("reached the spec .apifn/openapi.yml");
    expect(await readFile(path.join(dir, ".apifn", "report.md"), "utf8")).toBe("previous report\n");
    expect(await leftovers(path.join(dir, ".apifn"))).toEqual([]);
  });

  it("a --base-spec file and the router module are guarded too", async () => {
    for (const target of ["base.yml", "router.ts"]) {
      const { dir, code, errors } = await checkReaching(
        async (root) => {
          await commitSpec(root);
          await cp(path.join(root, SPEC), path.join(root, "base.yml"));
        },
        (root) => {
          appendFileSync(path.join(root, target), "\n");
        },
        { baseSpec: "base.yml" }
      );
      expect(code).toBe(2);
      expect(errors).toContain(target === "base.yml" ? "reached the --base-spec file base.yml" : "reached the router module router.ts");
      expect(existsSync(path.join(dir, ".apifn", "report.md"))).toBe(false);
    }
  });

  it("a directory the run creates that reaches a guarded name is removed again", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const errors: string[] = [];
    const code = await runCheckCommand({
      cwd: dir,
      config: CONFIG,
      output: { error: (message: string) => errors.push(message) } as unknown as Output,
      reportPath: path.join("out", "report.md"),
      writeStdout: () => {},
      publishHook: (step) => {
        // Stands in for a directory entry that the guarded spec's name now reaches.
        if (step === "mkdir") appendFileSync(path.join(dir, SPEC), "# reached\n");
      },
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("reached the spec .apifn/openapi.yml");
    expect(existsSync(path.join(dir, "out"))).toBe(false);
  });

  it.skipIf(POSIX_ONLY)("a run that writes no file resolves no guard: an input path that no longer resolves does not change its verdict", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    // A config path that loops (as if the loaded file were replaced by a link to itself).
    const loop = path.join(dir, "loop.config.ts");
    symlinkSync("loop.config.ts", loop);
    const run = async (extra: { write?: boolean; reportPath?: string }) => {
      const errors: string[] = [];
      let stdout = "";
      const code = await runCheckCommand({
        cwd: dir,
        config: CONFIG,
        configFile: loop,
        output: { error: (message: string) => errors.push(message) } as unknown as Output,
        ...extra,
        writeStdout: (text) => {
          stdout += text;
        },
      });
      return { code, errors: errors.join("\n"), stdout };
    };
    // A stdout-only run (--write separates its target from the inputs before any read, as before).
    const result = await run({});
    expect(result).toMatchObject({ code: 0, errors: "" });
    expect(result.stdout).toContain("apifn check");
    // A run that writes a report must still be able to guard its inputs.
    expect((await run({ reportPath: "report.md" })).code).toBe(2);
    expect(existsSync(path.join(dir, "report.md"))).toBe(false);
  });

  it("distinct outputs keep the normal verdict and leave the inputs byte-identical", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const before = await Promise.all([SPEC, "router.ts"].map((file) => readFile(path.join(dir, file))));
    const result = await run(["check", "--report", path.join(".apifn", "openapi-report.md"), "--format", "markdown"], dir);
    expect(result.code).toBe(0);
    expect(await readFile(path.join(dir, ".apifn", "openapi-report.md"), "utf8")).toBe(result.stdout);
    const after = await Promise.all([SPEC, "router.ts"].map((file) => readFile(path.join(dir, file))));
    expect(after).toEqual(before);
    expect(await leftovers(path.join(dir, ".apifn"))).toEqual([]);
  });
});

describe("apifn check: separation is established on the reserved destination before any bytes exist (round 9)", () => {
  const CONFIG = { router: "./router.ts", openapi: { info: { title: "Check fixture", version: "1.0.0" } } };

  for (const write of [false, true]) {
    it.skipIf(POSIX_ONLY)(`a missing spec name that reaches the report's reservation stops the run before any temp file or byte exists${write ? " (--write)" : ""}`, async () => {
      const root = await fixtures();
      const dir = path.join(root, "base");
      await mkdir(path.join(dir, ".apifn"));
      const errors: string[] = [];
      const steps: string[] = [];
      let stdout = "";
      let reservation = "";
      const code = await runCheckCommand({
        cwd: dir,
        config: CONFIG,
        output: { error: (message: string) => errors.push(message) } as unknown as Output,
        reportPath: path.join(".apifn", "report.md"),
        format: "json",
        write,
        writeStdout: (text) => {
          stdout += text;
        },
        publishHook: (step, destination) => {
          steps.push(step);
          if (step !== "reserved") return;
          // Stands in for a filesystem that joins the two names (a vfat short name, a case fold).
          reservation = readFileSync(destination, "utf8");
          symlinkSync(destination, path.join(dir, SPEC));
        },
      });
      expect(code).toBe(2);
      expect(stdout).toBe("");
      expect(reservation).toBe("");
      // The first reservation is checked before another output is reserved or any temp is staged.
      expect(steps).toEqual(["reserved"]);
      expect(errors.join("\n")).toContain(write ? "reached the output of --write" : "reached the spec .apifn/openapi.yml");
      expect(existsSync(path.join(dir, ".apifn", "report.md"))).toBe(false);
      expect((await readdir(path.join(dir, ".apifn"))).sort()).toEqual(["openapi.yml"]);
      expect((await lstat(path.join(dir, SPEC))).isSymbolicLink()).toBe(true);
    });
  }

  it("a reservation another writer replaced is kept and named", async () => {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await commitSpec(dir);
    const errors: string[] = [];
    const code = await runCheckCommand({
      cwd: dir,
      config: CONFIG,
      output: { error: (message: string) => errors.push(message) } as unknown as Output,
      reportPath: "report.md",
      writeStdout: () => {},
      publishHook: (step, destination) => {
        if (step !== "reserved") return;
        writeFileSync(destination, "another writer\n");
        appendFileSync(path.join(dir, SPEC), "# reached\n");
      },
    });
    expect(code).toBe(2);
    expect(errors.join("\n")).toContain("changed after apifn check reserved it");
    expect(await readFile(path.join(dir, "report.md"), "utf8")).toBe("another writer\n");
  });

  /** Runs check in a child process that sends itself SIGTERM at `step` for the report. */
  async function interrupted(step: string, write: boolean, alias = false): Promise<{ dir: string; code: number | null; signal: string | null; stdout: string }> {
    const root = await fixtures();
    const dir = path.join(root, "base");
    await mkdir(path.join(dir, ".apifn"));
    const script = path.join(root, "interrupt.ts");
    const check = path.join(import.meta.dirname, "..", "src", "commands", "check.ts");
    await writeFile(
      script,
      [
        `import { symlinkSync } from "node:fs";`,
        `import { runCheckCommand } from ${JSON.stringify(check)};`,
        `await runCheckCommand({`,
        `  cwd: ${JSON.stringify(dir)},`,
        `  config: ${JSON.stringify(CONFIG)},`,
        `  output: { error: (message) => process.stderr.write(message + "\\n") },`,
        `  reportPath: ".apifn/report.md",`,
        `  format: "json",`,
        `  write: ${write},`,
        `  publishHook: (step, destination) => {`,
        `    if (step !== ${JSON.stringify(step)} || !destination.endsWith("report.md")) return;`,
        `    process.kill(process.pid, "SIGTERM");`,
        alias ? `    symlinkSync(destination, ${JSON.stringify(path.join(dir, SPEC))});` : "",
        `  },`,
        `});`,
        `process.stdout.write("survived\\n");`,
      ].join("\n")
    );
    const jiti = path.join(path.dirname(createRequire(import.meta.url).resolve("jiti/package.json")), "lib", "jiti-cli.mjs");
    const child = spawn(process.execPath, [jiti, script], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => child.on("close", (exit, sig) => resolve([exit, sig])));
    return { dir, code, signal, stdout };
  }

  for (const [step, write] of [["reserved", false], ["installed", false], ["installed", true]] as const) {
    it.skipIf(POSIX_ONLY)(`SIGTERM at '${step}' rolls back every output and is raised again${write ? " (--write)" : ""}`, async () => {
      const { dir, code, signal, stdout } = await interrupted(step, write);
      expect({ code, signal, stdout }).toEqual({ code: null, signal: "SIGTERM", stdout: "" });
      expect(await readdir(path.join(dir, ".apifn"))).toEqual([]);
    }, 30_000);
  }

  it.skipIf(POSIX_ONLY)("SIGTERM that comes with an alias at 'reserved' is still raised after the rollback", async () => {
    const { dir, code, signal, stdout } = await interrupted("reserved", false, true);
    expect({ code, signal, stdout }).toEqual({ code: null, signal: "SIGTERM", stdout: "" });
    expect((await readdir(path.join(dir, ".apifn"))).sort()).toEqual(["openapi.yml"]);
    expect(existsSync(path.join(dir, ".apifn", "report.md"))).toBe(false);
  }, 30_000);
});
