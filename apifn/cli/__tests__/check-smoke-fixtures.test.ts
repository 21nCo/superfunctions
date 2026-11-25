/**
 * The fixtures .github/workflows/apifn-api-check-smoke.yml checks through the reusable API check workflow (API-4).
 * A generator change in a dependency does not trigger that workflow, so this test keeps the committed specs in sync
 * and the breaking fixture breaking: the smoke asserts verdict=pass for one and verdict=fail, breaking=true for the other.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { CheckReport } from "../src/commands/check.js";

const SMOKE = path.join(import.meta.dirname, "fixtures", "check-smoke");

async function check(fixture: string, extra: string[]): Promise<{ code: number; report: CheckReport }> {
  let stdout = "";
  let stderr = "";
  const dir = path.join(SMOKE, fixture);
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
});
