import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecurityScanner } from "@secfn/core";
import { runScan, runSecFnCli } from "./run.js";

describe("secfn cli", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.exitCode = undefined;
  });

  it("scans a path and emits JSON findings", async () => {
    const dir = await mkdtemp(join(tmpdir(), "secfn-scan-"));
    await writeFile(join(dir, "leak.ts"), "const token = 'ghp_aB3dE5gH7jK9mN2pQ4sT6vW8xY1zA3cD5fG7';\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const findings = await runScan({
      command: "scan",
      values: { path: dir, format: "json" },
      rest: [],
    });

    expect(findings.length).toBeGreaterThan(0);
    const output = JSON.parse(log.mock.calls[0]?.[0] as string) as { findings: unknown[] };
    expect(output.findings.length).toBe(findings.length);
  });

  it("supports SARIF output and fail-on thresholds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "secfn-sarif-"));
    const outputPath = join(dir, "secfn.sarif");
    await writeFile(join(dir, "key.pem"), "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----\n");

    await runScan({
      command: "scan",
      values: { path: dir, format: "sarif", output: outputPath, "fail-on": "critical" },
      rest: [],
    });

    const sarif = JSON.parse(await readFile(outputPath, "utf8")) as { version: string; runs: unknown[] };
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);
    expect(process.exitCode).toBe(1);
  });

  it("filters findings present in a baseline file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "secfn-baseline-"));
    const target = join(dir, "leak.ts");
    await writeFile(target, "-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----\n");
    const [finding] = await createSecurityScanner().scanFile(target);
    const baseline = join(dir, "baseline.json");
    await writeFile(baseline, JSON.stringify({ findings: [{ fingerprint: finding.fingerprint }] }));

    const findings = await runScan({
      command: "scan",
      values: { path: dir, format: "json", baseline },
      rest: [],
    });

    expect(findings).toHaveLength(0);
  });

  it("pulls a secret set as dotenv text", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: true,
      data: { name: "prod", secrets: { API_KEY: "abc 123" } },
    })));

    await runSecFnCli([
      "env",
      "pull",
      "--endpoint",
      "https://app.test/secfn",
      "--api-key",
      "token",
      "--set",
      "prod",
    ]);

    expect(log.mock.calls[0]?.[0]).toBe("API_KEY=\"abc 123\"");
  });

  it("runs a child command with resolved env values", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      ok: true,
      data: { name: "prod", secrets: { SECFN_TEST_VALUE: "present" } },
    })));

    await runSecFnCli([
      "env",
      "run",
      "--endpoint",
      "https://app.test/secfn",
      "--api-key",
      "token",
      "--set",
      "prod",
      "--",
      process.execPath,
      "-e",
      "if (process.env.SECFN_TEST_VALUE !== 'present') process.exit(9)",
    ]);

    expect(process.exitCode).toBe(0);
  });
});
