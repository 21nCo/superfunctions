/**
 * The fixtures .github/workflows/apifn-api-check-smoke.yml checks through the reusable API check workflow (API-4).
 * A generator change in a dependency does not trigger that workflow, so this test keeps the committed specs in sync
 * and the breaking fixture breaking: the smoke asserts verdict=pass for one and verdict=fail, breaking=true for the other.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { CheckReport } from "../src/commands/check.js";

const SMOKE = path.join(import.meta.dirname, "fixtures", "check-smoke");

async function check(fixture: string, extra: string[], dir = path.join(SMOKE, fixture)): Promise<{ code: number; report: CheckReport }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    ["check", path.join(dir, "router.ts"), "--config", path.join(dir, "apifn.config.ts"), "--spec", path.join(dir, "openapi.yml"), ...extra, "--format", "json"],
    {
      cwd: SMOKE,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    }
  );
  expect(stderr).toBe("");
  return { code, report: JSON.parse(stdout) as CheckReport };
}

describe("API check smoke fixtures", () => {
  it("compatible: the committed spec matches the router and passes", async () => {
    const { code, report } = await check("compatible", []);
    expect(code).toBe(0);
    expect(report).toMatchObject({ verdict: "pass", drift: false, valid: true, breaking: [] });
  });

  it("breaking: matches its router and fails against the compatible spec with a minor bump only", async () => {
    const { code, report } = await check("breaking", ["--base-spec", path.join(SMOKE, "compatible", "openapi.yml")]);
    expect(code).toBe(1);
    expect(report).toMatchObject({ verdict: "fail", drift: false, valid: true, versions: { base: "1.0.0", head: "1.1.0" } });
    expect(report.breaking.map((entry) => entry.path)).toEqual(["paths./users.get"]);
  });

  it("install-scripts: passes only when its postinstall marker exists, and reports drift without it", async () => {
    // A copy, so the marker never lands in the checkout; postinstall.mjs writes the same file under npm ci.
    const dir = mkdtempSync(path.join(tmpdir(), "apifn-install-scripts-"));
    try {
      cpSync(path.join(SMOKE, "install-scripts"), dir, { recursive: true, filter: (src) => !src.includes("node_modules") });
      const withoutScripts = await check("install-scripts", [], dir);
      expect(withoutScripts.code).toBe(1);
      expect(withoutScripts.report).toMatchObject({ verdict: "fail", drift: true, valid: true, breaking: [] });
      // The smoke's default job pins its base to the committed spec: the missing route is also a breaking change.
      const pinned = await check("install-scripts", ["--base-spec", path.join(dir, "openapi.yml")], dir);
      expect(pinned.report).toMatchObject({ verdict: "fail", drift: true });
      expect(pinned.report.breaking.map((entry) => entry.path)).toEqual(["paths./install-script.get"]);

      mkdirSync(path.join(dir, "node_modules"), { recursive: true });
      writeFileSync(path.join(dir, "node_modules", ".apifn-install-script-ran"), "");
      const withScripts = await check("install-scripts", [], dir);
      expect(withScripts.code).toBe(0);
      expect(withScripts.report).toMatchObject({ verdict: "pass", drift: false, valid: true, breaking: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
