import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadDevFnConfig, loadTrustedDevFnConfig, trustProject, validateDevFnConfig } from "../src/index.js";

const manifest = (extra: Record<string, unknown>) => ({ version: 1, project: { id: "fixture" }, profiles: { default: {} }, ...extra });

describe("setup tasks before the runtime runs them", () => {
  it("rejects a declared task instead of running it as an ordinary process or service", () => {
    expect(() => validateDevFnConfig(manifest({ processes: { migrate: { adapter: "command", command: ["migrate"], task: { rerun: "once" } } } })))
      .toThrow(expect.objectContaining({ code: "DEVFN_CONFIG_INVALID", path: "processes.migrate.task" }));
    expect(() => validateDevFnConfig(manifest({ services: { seed: { adapter: "compose", service: "seed", task: {} } } })))
      .toThrow(expect.objectContaining({ code: "DEVFN_CONFIG_INVALID", path: "services.seed.task" }));
    expect(validateDevFnConfig(manifest({ processes: { app: { adapter: "command", command: ["app"] } } })).processes?.app).not.toHaveProperty("task");
  });

  it("reports schema errors first and rejects a task in loaded manifests", async () => {
    expect(() => validateDevFnConfig({ version: 2, processes: { migrate: { task: {} } } })).toThrow("config.version must be 1.");
    const root = await mkdtemp(path.join(tmpdir(), "devfn-task-guard-"));
    try {
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "devfn.config.json");
      await writeFile(configPath, JSON.stringify(manifest({ processes: { migrate: { adapter: "command", command: ["migrate"], task: {} } } })));
      await expect(loadDevFnConfig({ cwd: root, configPath })).rejects.toMatchObject({ code: "DEVFN_CONFIG_INVALID" });
      await trustProject(root, configPath, stateDir);
      await expect(loadTrustedDevFnConfig({ cwd: root, configPath, stateDir })).rejects.toMatchObject({ code: "DEVFN_CONFIG_INVALID", path: "processes.migrate.task" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
