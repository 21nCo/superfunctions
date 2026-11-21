/**
 * `apifn check`: drift, validation, diff against a base and the version rule (API-5, D7).
 */

import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify as toYaml, parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import { CHECK_REPORT_MARKER, parseSemver, versionCoversBreaking } from "../src/commands/check.js";
import type { CheckReport } from "../src/commands/check.js";
import { tempDir } from "./temp-dirs.js";

const FIXTURES = path.join(import.meta.dirname, "fixtures", "check");
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

  it("a load error with --write leaves the committed spec untouched", async () => {
    const root = await fixtures();
    const dir = path.join(root, "compatible");
    await mkdir(path.join(dir, ".apifn"), { recursive: true });
    await writeFile(path.join(dir, SPEC), "openapi: 3.1.0\n");
    const result = await run(["check", "--write", "--base-spec", "missing.yml"], dir);
    expect(result.code).toBe(2);
    expect(await readFile(path.join(dir, SPEC), "utf8")).toBe("openapi: 3.1.0\n");
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
