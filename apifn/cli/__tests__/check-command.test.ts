/**
 * `apifn check`: drift, validation, diff against a base and the version rule (API-5, D7).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { access, chmod, cp, lstat, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as toYaml, parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import {
  CHECK_REPORT_MARKER,
  canonicalJson,
  parseSemver,
  runCheckCommand,
  versionCoversBreaking,
} from "../src/commands/check.js";
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
    expect(result.stderr).toContain("git show");
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
    expect(result.stderr).toContain("unique");
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

  it("through a case alias of the missing spec, on every filesystem", async () => {
    const dir = await missingSpec();
    await expectRejected(dir, path.join(".apifn", "OpenAPI.yml"));
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
    for (const baseSpec of [SPEC, path.join(".apifn", "OpenAPI.yml")]) {
      const result = await run(["check", "--write", "--base-spec", baseSpec], dir);
      expect({ baseSpec, code: result.code, stdout: result.stdout }).toEqual({ baseSpec, code: 2, stdout: "" });
      expect(result.stderr).toContain("--base-spec");
      expect(await readFile(path.join(dir, SPEC), "utf8")).toBe(baseText);
    }
  });

  it("--report naming the --base-spec file exits 2 and leaves it unchanged", async () => {
    const { dir, baseText } = await staleService();
    for (const report of ["base.yml", "BASE.yml", "./out/../base.yml"]) {
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
    expect(allowed.report.breaking.length).toBe(1);
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
    await writeFile(path.join(dir, "ext.yml"), toYaml({ ...doc, "x-ext": { $ref: "other.yml#/x" } }));
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
