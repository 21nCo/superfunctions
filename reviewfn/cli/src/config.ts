import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { safeDirectory, DEFAULT_CONFIG, DEFAULT_POLICY, PANEL_POLICY_PATH, parsePanelPolicy, validateConfig, validatePolicy, type PanelPolicy, type ReviewFnConfig, type ReviewPolicy } from "@superfunctions/reviewfn-core";

const execFileAsync = promisify(execFile);

export async function loadConfig(file: string): Promise<ReviewFnConfig> {
  return validateConfig(JSON.parse(await readFile(file, "utf8")));
}

export async function loadPolicy(file: string): Promise<ReviewPolicy> {
  return validatePolicy(JSON.parse(await readFile(file, "utf8")));
}

export async function loadTrustedConfigFromBase(root: string, base: string, relative = ".reviewfn/config.json"): Promise<ReviewFnConfig> {
  if (relative.startsWith("/") || relative.split(/[\\/]/).includes("..")) throw new Error("Trusted configuration path must be repository-relative.");
  const commit = (await execFileAsync("git", ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], { cwd: root })).stdout.trim();
  const { stdout } = await execFileAsync("git", ["show", `${commit}:${relative}`], { cwd: root, maxBuffer: 5_000_000 });
  return validateConfig(JSON.parse(stdout));
}

export async function loadTrustedPolicyFromBase(root: string, base: string, relative = ".reviewfn/policy.json"): Promise<ReviewPolicy> {
  if (relative.startsWith("/") || relative.split(/[\\/]/).includes("..")) throw new Error("Trusted policy path must be repository-relative.");
  const commit = (await execFileAsync("git", ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], { cwd: root })).stdout.trim();
  const { stdout } = await execFileAsync("git", ["show", `${commit}:${relative}`], { cwd: root, maxBuffer: 5_000_000 });
  return validatePolicy(JSON.parse(stdout));
}

async function refuseExisting(root: string, files: string[]): Promise<void> {
  for (const file of files) {
    try { await readFile(file); throw new Error(`Refusing to overwrite ${path.relative(root, file)}.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export async function initializeConfiguration(root: string): Promise<string[]> {
  const directory = path.join(root, ".reviewfn");
  await safeDirectory(directory);
  const files = [path.join(directory, "config.json"), path.join(directory, "policy.json")];
  await refuseExisting(root, files);
  await writeFile(files[0], `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(files[1], `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return files;
}

/**
 * The `reviewfn init --panel` template: one general stage-1 slot that also extracts requirements, and one general
 * stage-2 slot, both on the Codex harness with the default inference. `harness.version` is the exact version the
 * harness reports (`codex --version`) and must be updated to the installed Codex before a run can complete.
 */
export const PANEL_POLICY_TEMPLATE: PanelPolicy = parsePanelPolicy({
  version: 1,
  slots: [
    { id: "codex-general", stage: 1, harness: { adapter: "codex", version: "codex-cli 0.154.0" }, inference: { ...DEFAULT_CONFIG.inference }, lens: "general", budget: { timeoutMs: 20 * 60_000, maxOutputBytes: 10_000_000 } },
    { id: "codex-second-pass", stage: 2, harness: { adapter: "codex", version: "codex-cli 0.154.0" }, inference: { ...DEFAULT_CONFIG.inference }, lens: "general", budget: { timeoutMs: 20 * 60_000, maxOutputBytes: 10_000_000 } },
  ],
  quorum: { stage1: 1, stage2: 1 },
  requirementsSlot: "codex-general",
  maxConcurrentSlots: 2,
  incremental: "full",
});

/** Write the panel policy template to `.reviewfn/panel.json`, refusing to overwrite an existing file. */
export async function initializePanelPolicy(root: string): Promise<string> {
  await safeDirectory(path.join(root, ".reviewfn"));
  const file = path.join(root, PANEL_POLICY_PATH);
  await refuseExisting(root, [file]);
  await writeFile(file, `${JSON.stringify(PANEL_POLICY_TEMPLATE, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return file;
}
