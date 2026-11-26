/**
 * The fixtures .github/workflows/apifn-api-check-smoke.yml checks through the reusable API check workflow (API-4).
 * A generator change in a dependency does not trigger that workflow, so this test keeps the committed specs in sync
 * and the breaking fixture breaking: the smoke asserts verdict=pass for one and verdict=fail, breaking=true for the other,
 * and the install-scripts specs matching the router with and without its install and prepare script markers.
 */

import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";
import type { CheckReport } from "../src/commands/check.js";

const SMOKE = path.join(import.meta.dirname, "fixtures", "check-smoke");

async function check(
  fixture: string,
  extra: string[],
  dir = path.join(SMOKE, fixture),
  spec = "openapi.yml"
): Promise<{ code: number; report: CheckReport }> {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    ["check", path.join(dir, "router.ts"), "--config", path.join(dir, "apifn.config.ts"), "--spec", path.join(dir, spec), ...extra, "--format", "json"],
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

  it("install-scripts: openapi.yml needs both script markers, openapi.scripts-off.yml needs neither", async () => {
    // A copy, so the markers never land in the checkout; postinstall.mjs and prepare-dep/prepare.mjs write the same
    // files under npm ci with lifecycle scripts.
    const dir = mkdtempSync(path.join(tmpdir(), "apifn-install-scripts-"));
    const marker = (name: string) => writeFileSync(path.join(dir, "node_modules", name), "");
    try {
      cpSync(path.join(SMOKE, "install-scripts"), dir, { recursive: true, filter: (src) => !src.includes("node_modules") });
      // The smoke's scripts-off jobs (allow_install_scripts omitted or false) check against openapi.scripts-off.yml.
      const scriptsOff = await check("install-scripts", ["--base-spec", path.join(dir, "openapi.scripts-off.yml")], dir, "openapi.scripts-off.yml");
      expect(scriptsOff.code).toBe(0);
      expect(scriptsOff.report).toMatchObject({ verdict: "pass", drift: false, valid: true, breaking: [] });
      const withoutScripts = await check("install-scripts", [], dir);
      expect(withoutScripts.report).toMatchObject({ verdict: "fail", drift: true, valid: true, breaking: [] });

      mkdirSync(path.join(dir, "node_modules"), { recursive: true });
      // Either script alone adds its route, so the scripts-off check fails and openapi.yml still drifts.
      for (const name of [".apifn-prepare-script-ran", ".apifn-install-script-ran"]) {
        marker(name);
        const off = await check("install-scripts", [], dir, "openapi.scripts-off.yml");
        expect(off.report).toMatchObject({ verdict: "fail", drift: true });
        rmSync(path.join(dir, "node_modules", name));
      }

      marker(".apifn-prepare-script-ran");
      marker(".apifn-install-script-ran");
      const withScripts = await check("install-scripts", [], dir);
      expect(withScripts.code).toBe(0);
      expect(withScripts.report).toMatchObject({ verdict: "pass", drift: false, valid: true, breaking: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
