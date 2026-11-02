import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

  it("refuses an output that is a hard link to another runtime's held file, at the claim and at the default runtime's in-place write", async () => {
    const root = await checkout();
    const review = path.join(root, ".env.review"), fallback = path.join(root, ".env.default");
    const reviewIdentity = await resolveInstanceIdentity("fixture", root, "review");
    const defaultIdentity = await resolveInstanceIdentity("fixture", root);
    try {
      // review holds its file: its claimant (this process) runs.
      const held = await claimEnvironmentOutputs(config, root, reviewIdentity);
      await held.write(review, "DEVFN_INSTANCE_ID=review\n", 0o600);
      await held.commit();
      await link(review, fallback);
      await expect(assertEnvironmentOutputsAvailable(config, root, defaultIdentity)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("same file (a hard link) as .env.review"), details: { owner: { runtime: "review" } } });
      await expect(claimEnvironmentOutputs(config, root, defaultIdentity)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
      await unlink(fallback);
      // A link made after the default claimed its absent file is refused at the write, before any byte changes.
      const claim = await claimEnvironmentOutputs(config, root, defaultIdentity);
      await link(review, fallback);
      await expect(claim.write(fallback, "DEVFN_INSTANCE_ID=default\n", 0o600)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("hard link") });
      expect(await readFile(review, "utf8")).toBe("DEVFN_INSTANCE_ID=review\n");
      await claim.restore();
      // A hard link to a file no runtime holds is overwritten in place, as DevFn v0.1 did.
      await unlink(fallback);
      await writeFile(path.join(root, "user.env"), "USER=1\n");
      await link(path.join(root, "user.env"), fallback);
      const own = await claimEnvironmentOutputs(config, root, defaultIdentity);
      await own.write(fallback, "DEVFN_INSTANCE_ID=default\n", 0o600);
      await own.commit();
      expect(await readFile(path.join(root, "user.env"), "utf8")).toBe("DEVFN_INSTANCE_ID=default\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses an output whose file lands in DevFn's own state through a runtime name, a symlinked directory or a state directory in the checkout", async () => {
    const root = await checkout();
    const at = (output: string) => validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), environmentOutputs: [{ path: output }] });
    try {
      await mkdir(path.join(root, ".devfn", "receipts"), { recursive: true });
      await symlink(path.join(root, ".devfn", "receipts"), path.join(root, "alias"));
      for (const [output, runtime, stateDir] of [
        [".devfn/{runtime}", "outputs", undefined], // the claims directory itself
        [".devfn/{runtime}", "instances", undefined],
        ["alias/{runtime}.json", "b", undefined],
        ["state/{runtime}.env", "b", path.join(root, "state")],
      ] as const) {
        const identity = await resolveInstanceIdentity("fixture", root, runtime);
        await expect(assertEnvironmentOutputsAvailable(at(output), root, identity, stateDir), output).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("inside DevFn's own state") });
        await expect(claimEnvironmentOutputs(at(output), root, identity, stateDir), output).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
      }
      // A state directory outside the checkout reserves nothing in it.
      await expect(assertEnvironmentOutputsAvailable(at("state/{runtime}.env"), root, await resolveInstanceIdentity("fixture", root, "b"), path.join(os.tmpdir(), "devfn-state"))).resolves.toBeUndefined();
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
