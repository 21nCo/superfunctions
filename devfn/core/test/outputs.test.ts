import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { processBirthSignature, validateDevFnConfig } from "@devfn/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveInstanceIdentity } from "../src/index.js";
import { assertEnvironmentOutputsAvailable, claimEnvironmentOutputs } from "../src/outputs.js";

const execFileAsync = promisify(execFile);

/** Interrupts an output replacement at its rename, before or after the new content lands, as a killed DevFn would. */
const renameFault = vi.hoisted(() => ({ target: undefined as string | undefined, land: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renameFault.target === undefined || to !== renameFault.target) return await actual.rename(from, to);
      if (renameFault.land) await actual.rename(from, to);
      throw Object.assign(new Error("interrupted"), { code: "EINTR" });
    },
  };
});

afterEach(() => { renameFault.target = undefined; renameFault.land = false; });

async function checkout(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-outputs-")));
  await execFileAsync("git", ["init", "-q", root]);
  return root;
}

const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, environmentOutputs: [{ path: ".env.{runtime}" }],
  processes: { app: { adapter: "command", command: ["node", "app.mjs"] } }, profiles: { default: { processes: ["app"] } } });

describe("environment-output claims", () => {
  it("recovers a named runtime's own file after a replacement interrupted before or after its rename, and refuses any other content", async () => {
    const root = await checkout();
    const file = path.join(root, ".env.p");
    const identity = await resolveInstanceIdentity("fixture", root, "p");
    // One start: claim, write, commit; an interrupted start never commits or restores, as a killed DevFn would not.
    const start = async (content: string) => {
      const claim = await claimEnvironmentOutputs(config, root, identity);
      await claim.write(file, content, 0o600);
      await claim.commit();
    };
    try {
      await start("A=1\n");
      // The new content lands, then the process dies before recording it as written.
      renameFault.target = file;
      renameFault.land = true;
      await expect((await claimEnvironmentOutputs(config, root, identity)).write(file, "B=2\n", 0o600)).rejects.toThrow("interrupted");
      renameFault.target = undefined;
      expect(await readFile(file, "utf8")).toBe("B=2\n");
      // Preflight and doctor accept it, and the next start replaces it.
      await assertEnvironmentOutputsAvailable(config, root, identity);
      await start("C=3\n");
      expect(await readFile(file, "utf8")).toBe("C=3\n");
      // The process dies before the rename: the file still holds what it last wrote.
      renameFault.target = file;
      renameFault.land = false;
      await expect((await claimEnvironmentOutputs(config, root, identity)).write(file, "D=4\n", 0o600)).rejects.toThrow("interrupted");
      renameFault.target = undefined;
      expect(await readFile(file, "utf8")).toBe("C=3\n");
      await assertEnvironmentOutputsAvailable(config, root, identity);
      await start("E=5\n");
      // Content matching neither what it wrote nor what it intended is someone else's.
      renameFault.target = file;
      renameFault.land = true;
      await expect((await claimEnvironmentOutputs(config, root, identity)).write(file, "F=6\n", 0o600)).rejects.toThrow("interrupted");
      renameFault.target = undefined;
      await writeFile(file, "USER=edit\n");
      await expect(assertEnvironmentOutputsAvailable(config, root, identity)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("changed since runtime p wrote it") });
      await expect(claimEnvironmentOutputs(config, root, identity)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
      expect(await readFile(file, "utf8")).toBe("USER=edit\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("recovers the checkout's claim lock from a holder verified dead without waiting out a live one", { timeout: 60_000 }, async () => {
    const root = await checkout();
    const lock = path.join(root, ".devfn", "outputs", "claims.lock");
    const holder = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => holder.once("spawn", resolve));
      const pid = holder.pid!;
      await mkdir(lock, { recursive: true });
      await writeFile(path.join(lock, "owner.json"), JSON.stringify({ token: "fixture", pid, birthSignature: await processBirthSignature(pid), createdAt: new Date(Date.now() - 60_000).toISOString() }));
      let claimed = false;
      const claiming = claimEnvironmentOutputs(config, root, await resolveInstanceIdentity("fixture", root, "b")).then((claim) => { claimed = true; return claim; });
      // A live holder keeps the lock however long ago it took it.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(claimed).toBe(false);
      holder.kill("SIGKILL");
      await new Promise((resolve) => holder.once("exit", resolve));
      const started = Date.now();
      await (await claiming).commit();
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(JSON.parse(await readFile(path.join(root, ".devfn", "outputs", `${(await resolveInstanceIdentity("fixture", root, "b")).instanceId}.json`), "utf8")))
        .toMatchObject({ runtime: "b", targets: [path.join(root, ".env.b")] });
    } finally {
      holder.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
});
