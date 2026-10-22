import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../src/index.js";

const require = createRequire(import.meta.url);
const fixture = (name: string) => require.resolve(`@apifn/sdk/fixtures/${name}`);

async function run(argv: string[], cwd: string) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(argv, { cwd, stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) });
  return { code, stdout, stderr };
}

describe("apifn sdk generate", () => {
  it("writes the package and manifest from a catalog, then reports it up to date", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "apifn-cli-sdk-"));
    const args = ["sdk", "generate", "--sdk-config", fixture("typescript/sdk.config.json"), "--catalog", fixture("catalog/catalog.json"), "--out", "tasks-sdk"];
    const generated = await run([...args, "--no-color"], cwd);
    expect(generated.code).toBe(0);
    expect(generated.stdout).toContain("Generated @example/tasks-sdk 1.0.0 (typescript)");
    expect(generated.stdout).toContain("warning SDK_UNSUPPORTED_OPERATION: reports.upload");
    expect(generated.stdout).toContain("Excluded unsupported operations: reports.upload, session.get.");
    const manifest = JSON.parse(await readFile(path.join(cwd, "tasks-sdk/apifn.sdk-manifest.json"), "utf8"));
    expect(manifest.catalog.digest).toMatch(/^sha256:/);
    expect(existsSync(path.join(cwd, "tasks-sdk/src/custom/index.ts"))).toBe(true);

    expect((await run([...args, "--check"], cwd)).code).toBe(0);
    await writeFile(path.join(cwd, "tasks-sdk/src/models.ts"), "// stale\n");
    const stale = await run([...args, "--check", "--no-color"], cwd);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("out of date: src/models.ts");
    expect(await readFile(path.join(cwd, "tasks-sdk/src/models.ts"), "utf8")).toBe("// stale\n");

    // Regenerating repairs the edit and leaves a final manifest, so the next check is clean.
    expect((await run(args, cwd)).code).toBe(0);
    expect((await run([...args, "--check"], cwd)).code).toBe(0);
  });

  it("reports output conflicts apart from generation failures", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "apifn-cli-sdk-"));
    const args = ["sdk", "generate", "--sdk-config", fixture("typescript/sdk.config.json"), "--catalog", fixture("catalog/catalog.json"), "--out", "out", "--no-color"];
    await mkdir(path.join(cwd, "out"));
    await writeFile(path.join(cwd, "out/README.md"), "mine\n");
    const written = await run(args, cwd);
    expect(written.code).toBe(1);
    expect(written.stderr).toContain("error SDK_OUTPUT_CONFLICT README.md:");
    expect(written.stderr).toContain("conflicts with the generated SDK; nothing was written.");
    expect(written.stderr).not.toContain("generation failed");
    const checked = await run([...args, "--check"], cwd);
    expect(checked.code).toBe(1);
    expect(checked.stderr).toContain("cannot be checked: resolve the output conflicts above.");
    expect(readdirSync(path.join(cwd, "out"))).toEqual(["README.md"]);
  });

  it("exits 1 without writing while another run holds the output directory", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "apifn-cli-sdk-"));
    const args = ["sdk", "generate", "--sdk-config", fixture("typescript/sdk.config.json"), "--catalog", fixture("catalog/catalog.json"), "--out", "out", "--no-color"];
    await mkdir(path.join(cwd, "out"));
    const held = `${JSON.stringify({ pid: 4242, hostname: "build-host", startedAt: "2026-10-22T00:00:00.000Z", nonce: "other" })}\n`;
    await writeFile(path.join(cwd, "out/.apifn-sdk.lock"), held);
    for (const extra of [[], ["--check"]]) {
      const result = await run([...args, ...extra], cwd);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("error SDK_OUTPUT_CONFLICT .apifn-sdk.lock:");
      expect(result.stderr).toContain("process 4242 on build-host");
    }
    expect(readdirSync(path.join(cwd, "out"))).toEqual([".apifn-sdk.lock"]);
    expect(await readFile(path.join(cwd, "out/.apifn-sdk.lock"), "utf8")).toBe(held);
  });

  it("builds the catalog from --spec and --manifest with the same result", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "apifn-cli-sdk-"));
    const config = fixture("typescript/sdk.config.json");
    expect((await run(["sdk", "generate", "--sdk-config", config, "--catalog", fixture("catalog/catalog.json"), "--out", "a"], cwd)).code).toBe(0);
    const fromSpec = await run(
      ["sdk", "generate", "--sdk-config", config, "--spec", fixture("catalog/openapi.json"), "--manifest", fixture("catalog/manifest.json"), "--out", "b", "--format", "json"],
      cwd
    );
    expect(fromSpec.code).toBe(0);
    expect(JSON.parse(fromSpec.stdout).ok).toBe(true);
    for (const file of ["apifn.sdk-manifest.json", "src/client.ts", "src/models.ts", "package.json"]) {
      expect(await readFile(path.join(cwd, "b", file), "utf8")).toBe(await readFile(path.join(cwd, "a", file), "utf8"));
    }
  });

  it("fails without writing when generation has errors", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "apifn-cli-sdk-"));
    const config = JSON.parse(await readFile(fixture("typescript/sdk.config.json"), "utf8"));
    delete config.unsupported;
    await writeFile(path.join(cwd, "sdk.config.json"), JSON.stringify(config));
    const result = await run(["sdk", "generate", "--sdk-config", "sdk.config.json", "--catalog", fixture("catalog/catalog.json"), "--out", "out", "--no-color"], cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error SDK_UNSUPPORTED_OPERATION: reports.upload");
    expect(result.stderr).toContain("nothing was written");
    expect(existsSync(path.join(cwd, "out"))).toBe(false);
  });

  it("rejects unknown actions and incomplete arguments with exit code 2", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "apifn-cli-sdk-"));
    const config = fixture("typescript/sdk.config.json");
    const catalog = fixture("catalog/catalog.json");
    for (const argv of [
      ["sdk", "publish"],
      ["sdk", "generate", "--catalog", catalog, "--out", "x"],
      ["sdk", "generate", "--sdk-config", config, "--catalog", catalog],
      ["sdk", "generate", "--sdk-config", config, "--out", "x"],
      ["sdk", "generate", "--sdk-config", config, "--catalog", catalog, "--spec", catalog, "--manifest", catalog, "--out", "x"],
      ["sdk", "generate", "--sdk-config", config, "--spec", catalog, "--out", "x"],
      ["sdk", "generate", "--sdk-config", "missing.json", "--catalog", catalog, "--out", "x"],
    ]) {
      expect((await run(argv, cwd)).code, argv.join(" ")).toBe(2);
    }
    expect(readdirSync(cwd)).toEqual([]);
  });
});
