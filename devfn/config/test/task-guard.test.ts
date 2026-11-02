import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadTrustedDevFnConfig, trustProject, validateDevFnConfig } from "../src/index.js";

describe("finite setup task contracts", () => {
  it("validates finite task contracts and keeps tasks from serving", () => {
    const base = (task: unknown, process: Record<string, unknown> = {}) => validateDevFnConfig({ version: 1, project: { id: "fixture" }, ports: { web: {} },
      processes: { setup: { adapter: "command", command: ["setup"], task, ...process } }, profiles: { default: { processes: ["setup"] } } });
    expect(base({}).processes?.setup.task).toEqual({ rerun: "on-change", idempotent: false, retries: 0, timeoutMs: 600_000 });
    expect(base({ rerun: "always", idempotent: true, retries: 2, timeoutMs: 1000, inputs: ["migrations", "schema.sql"] }).processes?.setup.task)
      .toEqual({ rerun: "always", idempotent: true, retries: 2, timeoutMs: 1000, inputs: ["migrations", "schema.sql"] });
    expect(() => base(null)).toThrow("must be an object");
    expect(() => base({ rerun: "sometimes" })).toThrow("on-change, always or once");
    // Only an omitted policy defaults; null is no policy and is rejected, never run as on-change.
    for (const field of ["rerun", "idempotent", "retries", "timeoutMs"]) expect(() => base({ [field]: null }), field).toThrow(field);
    expect(() => base({ idempotent: "yes" })).toThrow("must be a boolean");
    expect(() => base({ rerun: "always" })).toThrow("requires idempotent: true");
    expect(() => base({ retries: 1 })).toThrow("never repeated automatically");
    expect(() => base({ retries: 6, idempotent: true })).toThrow("retries");
    expect(() => base({ timeoutMs: 0 })).toThrow("timeoutMs");
    expect(() => base({ inputs: ["../outside"] })).toThrow("inside the repository");
    expect(() => base({ inputs: ["a", "a"] })).toThrow("each entry once");
    expect(() => base({}, { ports: ["web"] })).toThrow("cannot be declared by a task");
    expect(() => base({}, { health: { type: "tcp", port: "web" } })).toThrow("cannot be declared by a task");
    expect(() => base({}, { exposure: "public" })).toThrow("cannot be public for a task");
    const service = (extra: Record<string, unknown>) => validateDevFnConfig({ version: 1, project: { id: "fixture" }, ports: { db: {} },
      services: { seed: { adapter: "compose", service: "seed", task: {}, ...extra } }, profiles: { default: { services: ["seed"] } } });
    expect(service({}).services?.seed.task?.rerun).toBe("on-change");
    expect(() => service({ persistent: true })).toThrow("cannot be declared by a task");
    expect(() => service({ ports: { db: 5432 } })).toThrow("cannot be declared by a task");
    // A task has no ports, so it can never provide a resource target.
    expect(() => validateDevFnConfig({ version: 1, project: { id: "fixture" }, ports: { db: {} },
      processes: { setup: { adapter: "command", command: ["setup"], task: {} } },
      resources: { data: { kind: "database", targets: { local: { node: "setup", port: "db" } } } }, profiles: { default: { processes: ["setup"] } } })).toThrow("not an exposed port");
    expect(validateDevFnConfig({ version: 1, project: { id: "fixture" }, processes: { app: { adapter: "command", command: ["app"] } }, profiles: { default: {} } }).processes?.app).not.toHaveProperty("task");
  });

  it("reports schema errors first and keeps a task in loaded manifests", async () => {
    expect(() => validateDevFnConfig({ version: 2, processes: { migrate: { task: {} } } })).toThrow("config.version must be 1.");
    const root = await mkdtemp(path.join(tmpdir(), "devfn-task-guard-"));
    try {
      const stateDir = path.join(root, "state");
      const configPath = path.join(root, "devfn.config.json");
      await writeFile(configPath, JSON.stringify({ version: 1, project: { id: "fixture" }, profiles: { default: {} },
        processes: { migrate: { adapter: "command", command: ["migrate"], task: { rerun: "once" } } } }));
      await trustProject(root, configPath, stateDir);
      const loaded = await loadTrustedDevFnConfig({ cwd: root, configPath, stateDir });
      expect(loaded.config.processes?.migrate.task).toEqual({ rerun: "once", idempotent: false, retries: 0, timeoutMs: 600_000 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
