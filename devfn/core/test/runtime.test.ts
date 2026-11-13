import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readReceipt, writeReceipt } from "../src/index.js";
import type { LifecycleReceipt } from "../src/types.js";
import { temporaryDirectories } from "../../test-support/temp-directories.mjs";

// Removed after each test, whether it passes, fails or times out.
const tempDir = temporaryDirectories(afterEach);

describe("runtime receipts", () => {
  it("keeps a running receipt discoverable after runtimeDir changes", async () => {
    const root = tempDir("devfn-runtime-");
    const receipt: LifecycleReceipt = {
      version: 1,
      projectId: "app",
      instanceId: "instance",
      invocationId: "invocation",
      profile: "default",
      state: "ready",
      root,
      runtimeDir: path.join(root, "old-runtime", "instances", "instance"),
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      allocations: [],
      processes: [],
      services: [],
      routes: [],
      urls: {},
      environmentOutputs: [],
    };
    await writeReceipt(receipt);
    const changed = { version: 1 as const, project: { id: "app" }, runtimeDir: "new-runtime", profiles: { default: {} } };
    expect((await readReceipt(changed, root, "instance"))?.runtimeDir).toBe(receipt.runtimeDir);
  });

  it("rejects a stable receipt directory symlinked outside the repository", async () => {
    const root = tempDir("devfn-runtime-");
    const outside = tempDir("devfn-outside-");
    await mkdir(path.join(root, ".devfn"));
    await symlink(outside, path.join(root, ".devfn", "receipts"));
    const receipt: LifecycleReceipt = {
      version: 1, projectId: "app", instanceId: "instance", invocationId: "invocation", profile: "default", state: "ready", root,
      runtimeDir: path.join(root, ".devfn", "instances", "instance"), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      allocations: [], processes: [], services: [], routes: [], urls: {}, environmentOutputs: [],
    };
    await expect(writeReceipt(receipt)).rejects.toMatchObject({ code: "DEVFN_CONFIG_PATH_ESCAPE" });
  });
});
