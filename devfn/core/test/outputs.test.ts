import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { access, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { processBirthSignature, validateDevFnConfig } from "@devfn/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DevFnOrchestrator, resolveInstanceIdentity, writeEnvironmentOutputs, writeReceipt } from "../src/index.js";
import { assertEnvironmentOutputsAvailable, claimEnvironmentOutputs, releaseEnvironmentOutputs } from "../src/outputs.js";

const execFileAsync = promisify(execFile);

/** Interrupts an output replacement at its rename, before or after the new content lands, as a killed DevFn would. */
const renameFault = vi.hoisted(() => ({ target: undefined as string | undefined, land: false }));
/** Fails mkdir of one directory with each queued code in turn, as a sibling removing the empty claims directories in between would. */
const mkdirFault = vi.hoisted(() => ({ target: undefined as string | undefined, codes: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (target: string, options?: Parameters<typeof actual.mkdir>[1]) => {
      const code = target === mkdirFault.target ? mkdirFault.codes.shift() : undefined;
      if (code) throw Object.assign(new Error(`${code}: injected, mkdir '${target}'`), { code, path: target });
      return await actual.mkdir(target, options);
    },
    rename: async (from: string, to: string) => {
      if (renameFault.target === undefined || to !== renameFault.target) return await actual.rename(from, to);
      if (renameFault.land) await actual.rename(from, to);
      throw Object.assign(new Error("interrupted"), { code: "EINTR" });
    },
  };
});

afterEach(() => { renameFault.target = undefined; renameFault.land = false; mkdirFault.target = undefined; mkdirFault.codes = []; });

async function checkout(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-outputs-")));
  await execFileAsync("git", ["init", "-q", root]);
  return root;
}

const config = validateDevFnConfig({ version: 1, project: { id: "fixture" }, environmentOutputs: [{ path: ".env.{runtime}" }],
  processes: { app: { adapter: "command", command: ["node", "app.mjs"] } }, profiles: { default: { processes: ["app"] } } });

describe("environment-output claims", { timeout: 30_000 }, () => {
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
    const at = (output: string, extra: Record<string, unknown> = {}) => validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), environmentOutputs: [{ path: output }], ...extra });
    try {
      await mkdir(path.join(root, ".devfn", "receipts"), { recursive: true });
      await symlink(path.join(root, ".devfn", "receipts"), path.join(root, "alias"));
      // The manifest loads (at() validates it); the start and doctor refuse it.
      for (const [output, runtime, stateDir] of [
        [".devfn/receipts/{runtime}", "outputs", undefined], // the claims directory itself
        [".devfn/receipts/{runtime}.json", "b", undefined],
        [".devfn/instances/{runtime}.env", "b", undefined],
        [".devfn/{runtime}", "instances", undefined],
        ["alias/{runtime}.json", "b", undefined],
        ["state/{runtime}.env", "b", path.join(root, "state")],
      ] as const) {
        const identity = await resolveInstanceIdentity("fixture", root, runtime);
        await expect(assertEnvironmentOutputsAvailable(at(output), root, identity, stateDir), output).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("inside DevFn's own state") });
        await expect(claimEnvironmentOutputs(at(output), root, identity, stateDir), output).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
      }
      await expect(assertEnvironmentOutputsAvailable(at("run/instances/{runtime}.env", { runtimeDir: "run" }), root, await resolveInstanceIdentity("fixture", root, "b"))).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
      // A state directory outside the checkout reserves nothing in it.
      await expect(assertEnvironmentOutputsAvailable(at("state/{runtime}.env"), root, await resolveInstanceIdentity("fixture", root, "b"), path.join(os.tmpdir(), "devfn-state"))).resolves.toBeUndefined();
      // .devfn/outputs is no DevFn state: a DevFn v0.1 default-runtime output there is claimed and written.
      const v01 = at(".devfn/outputs/app.env");
      const claim = await claimEnvironmentOutputs(v01, root, await resolveInstanceIdentity("fixture", root));
      await claim.write(path.join(root, ".devfn", "outputs", "app.env"), "A=1\n", 0o600);
      await claim.commit();
      expect(await readFile(path.join(root, ".devfn", "outputs", "app.env"), "utf8")).toBe("A=1\n");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("holds another runtime's recorded runtime directory, wherever runtimeDir put it, until it stops", async () => {
    const root = await checkout();
    const review = await resolveInstanceIdentity("fixture", root, "review");
    const fallback = await resolveInstanceIdentity("fixture", root);
    const withDir = (runtimeDir: string, output: string) => validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), runtimeDir, environmentOutputs: [{ path: output }] });
    try {
      // review starts under runtimeDir old-run; its claimant (this process) runs.
      const held = await claimEnvironmentOutputs(withDir("old-run", ".env.{runtime}"), root, review);
      await held.commit();
      // The manifest moves to new-run; an output in review's old runtime directory is refused, naming review.
      const log = path.join("old-run", "instances", review.instanceId, "logs", "app.log");
      const moved = withDir("new-run", log);
      for (const check of [() => assertEnvironmentOutputsAvailable(moved, root, fallback), () => claimEnvironmentOutputs(moved, root, fallback)]) {
        await expect(check()).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("the runtime directory of runtime review"), details: { owner: { runtime: "review" } } });
      }
      // Conversely, a runtime whose own runtime directory holds a file another runtime writes is refused, whatever it declares.
      const intruder = await claimEnvironmentOutputs(withDir("old-run", path.join("new-run", "instances", review.instanceId, "x.env")), root, fallback);
      await intruder.commit();
      await expect(assertEnvironmentOutputsAvailable(validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), runtimeDir: "new-run", environmentOutputs: [] }), root, review))
        .rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("keeps its logs and runtime.env in"), details: { owner: { runtime: "default" } } });
      await releaseEnvironmentOutputs(root, fallback.instanceId);
      // Once review stops, its former location is free.
      await releaseEnvironmentOutputs(root, review.instanceId);
      await expect(assertEnvironmentOutputsAvailable(moved, root, fallback)).resolves.toBeUndefined();
      await (await claimEnvironmentOutputs(moved, root, fallback)).commit();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("holds a start's runtime directory from its claim, with or without outputs, so an overlapping claim is refused in either order", async () => {
    const root = await checkout();
    const review = await resolveInstanceIdentity("fixture", root, "review");
    const fallback = await resolveInstanceIdentity("fixture", root);
    const withDir = (runtimeDir: string, outputs: string[]) => validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), runtimeDir, environmentOutputs: outputs.map((output) => ({ path: output })) });
    const claimFile = (id: string) => path.join(root, ".devfn", "receipts", "outputs", `${id}.json`);
    const intoReview = withDir("old-run", [path.join("new-run", "instances", review.instanceId, "runtime.env")]);
    try {
      // review, declaring no output, has claimed but not yet committed (it would be writing runtime.env now).
      const starting = await claimEnvironmentOutputs(withDir("new-run", []), root, review);
      expect(JSON.parse(await readFile(claimFile(review.instanceId), "utf8")))
        .toMatchObject({ runtime: "review", targets: [], runtimeDirectory: path.join(root, "new-run", "instances", review.instanceId) });
      // An output in that directory is refused at once, before the uncommitted start finishes.
      await expect(claimEnvironmentOutputs(intoReview, root, fallback))
        .rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("the runtime directory of runtime review") });
      // A failed start gives its directory back and removes the claim it created.
      await starting.restore();
      await expect(readFile(claimFile(review.instanceId), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      // In a checkout that had no DevFn state, it leaves none behind.
      await expect(access(path.join(root, ".devfn"))).rejects.toMatchObject({ code: "ENOENT" });
      const sibling = await claimEnvironmentOutputs(intoReview, root, fallback);
      // The reverse order: review's no-output start is refused while the default's claim lies in its directory.
      await expect(claimEnvironmentOutputs(withDir("new-run", []), root, review))
        .rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("keeps its logs and runtime.env in") });
      await expect(readFile(claimFile(review.instanceId), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      // A failed start removes only empty directories: another file there keeps them.
      const keptFile = path.join(root, ".devfn", "receipts", "keep.json");
      await writeFile(keptFile, "{}");
      await sibling.restore();
      await expect(readFile(claimFile(fallback.instanceId), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(keptFile, "utf8")).toBe("{}");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps every start's runtime directory disjoint from another's: not equal through a symlink, not nested either way", async () => {
    const root = await checkout();
    const a = await resolveInstanceIdentity("fixture", root, "a");
    const b = await resolveInstanceIdentity("fixture", root, "b");
    const withDir = (runtimeDir: string, outputs: string[]) => validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), runtimeDir, environmentOutputs: outputs.map((output) => ({ path: output })) });
    const claimFile = (id: string) => path.join(root, ".devfn", "receipts", "outputs", `${id}.json`);
    const refused = (relation: string) => ({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringMatching(new RegExp(`which ${relation} .*the runtime directory of runtime a`)) });
    try {
      // A claim refused under the lock in a checkout without DevFn state leaves none behind.
      await expect(claimEnvironmentOutputs(withDir(".devfn", [".devfn/receipts/app.env"]), root, a)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
      await expect(access(path.join(root, ".devfn"))).rejects.toMatchObject({ code: "ENOENT" });

      // a holds run/instances/<a>, with and without an output.
      for (const outputs of [[], [".env.{runtime}"]]) {
        const started = await claimEnvironmentOutputs(withDir("run", outputs), root, a);
        // Equal: b's directory is a symlink to a's.
        await mkdir(path.join(root, "run", "instances"), { recursive: true });
        const alias = path.join(root, "run", "instances", b.instanceId);
        await symlink(a.instanceId, alias);
        await expect(assertEnvironmentOutputsAvailable(withDir("run", outputs), root, b)).rejects.toMatchObject(refused("is"));
        await expect(claimEnvironmentOutputs(withDir("run", outputs), root, b)).rejects.toMatchObject(refused("is"));
        await rm(alias);
        // Nested inside a's directory through runtimeDir.
        const nested = path.join("run", "instances", a.instanceId);
        await expect(claimEnvironmentOutputs(withDir(nested, outputs), root, b)).rejects.toMatchObject(refused("lies in"));
        await expect(readFile(claimFile(b.instanceId), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await started.restore();
        await rm(path.join(root, "run"), { recursive: true, force: true });
      }
      // Containing it: a lives under run/instances/<b>, and b's own directory is that.
      const inner = await claimEnvironmentOutputs(withDir(path.join("run", "instances", b.instanceId), []), root, a);
      await expect(claimEnvironmentOutputs(withDir("run", []), root, b)).rejects.toMatchObject(refused("contains"));
      // Once a's start is over, its directory is free.
      await inner.restore();
      await (await claimEnvironmentOutputs(withDir("run", []), root, b)).restore();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("holds both runtime directories of a replacement under a changed runtimeDir, in either order", async () => {
    const root = await checkout();
    const a = await resolveInstanceIdentity("fixture", root, "a");
    const fallback = await resolveInstanceIdentity("fixture", root);
    const withDir = (runtimeDir: string, outputs: string[]) => validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), runtimeDir, environmentOutputs: outputs.map((output) => ({ path: output })) });
    const into = (runtimeDir: string) => withDir("other-run", [path.join(runtimeDir, "instances", a.instanceId, "runtime.env")]);
    const refused = { code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("the runtime directory of runtime a"), details: { owner: { runtime: "a" } } };
    try {
      // a is ready under runtimeDir old-run: its receipt is live and records that directory.
      await (await claimEnvironmentOutputs(withDir("old-run", []), root, a)).commit();
      await mkdir(path.join(root, ".devfn", "receipts"), { recursive: true });
      await writeFile(path.join(root, ".devfn", "receipts", `${a.instanceId}.json`), JSON.stringify({ version: 1, projectId: "fixture", instanceId: a.instanceId, runtime: "a", invocationId: "fixture",
        profile: "default", state: "ready", root, runtimeDir: path.join(root, "old-run", "instances", a.instanceId), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        allocations: [], processes: [], services: [], startedNodes: [], routes: [], urls: {}, environmentOutputs: [] }));
      // The manifest moves to new-run and a restarts: its new start has claimed new-run/instances/<a>, its receipt still records old-run.
      const replacing = await claimEnvironmentOutputs(withDir("new-run", []), root, a);
      // An output in either directory is refused, naming a, before any write.
      for (const runtimeDir of ["old-run", "new-run"]) {
        await expect(assertEnvironmentOutputsAvailable(into(runtimeDir), root, fallback), runtimeDir).rejects.toMatchObject(refused);
        await expect(claimEnvironmentOutputs(into(runtimeDir), root, fallback), runtimeDir).rejects.toMatchObject(refused);
      }
      await expect(access(path.join(root, "new-run", "instances", a.instanceId, "runtime.env"))).rejects.toMatchObject({ code: "ENOENT" });
      // Once the replacement gives up, only the live receipt's directory stays held.
      await replacing.restore();
      await expect(assertEnvironmentOutputsAvailable(into("old-run"), root, fallback)).rejects.toMatchObject(refused);
      const first = await claimEnvironmentOutputs(into("new-run"), root, fallback);
      // The reverse order: with the default's claim there held first, a's replacement under new-run is refused.
      await expect(claimEnvironmentOutputs(withDir("new-run", []), root, a)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("keeps its logs and runtime.env in") });
      await first.restore();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("binds a start to the real runtime directory it claimed, so a symlink swapped in afterwards redirects no write", async () => {
    const root = await checkout();
    const a = await resolveInstanceIdentity("fixture", root, "a");
    const b = await resolveInstanceIdentity("fixture", root, "b");
    const noOutputs = validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), environmentOutputs: [] });
    const directory = (id: string) => path.join(root, ".devfn", "instances", id);
    try {
      await (await claimEnvironmentOutputs(noOutputs, root, a)).commit();
      await writeFile(path.join(directory(a.instanceId), "runtime.env"), "OWNER=a\n");
      // The claim creates b's runtime directory as a real directory.
      const started = await claimEnvironmentOutputs(noOutputs, root, b);
      expect((await lstat(directory(b.instanceId))).isDirectory()).toBe(true);
      await expect(started.assertRuntimeDirectory()).resolves.toBeUndefined();
      // It is replaced by a symlink to a's directory after the claim: the start refuses before any write.
      await rm(directory(b.instanceId), { recursive: true });
      await symlink(a.instanceId, directory(b.instanceId));
      await expect(started.assertRuntimeDirectory()).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("changed during startup"), details: { claimed: directory(b.instanceId) } });
      await started.restore();
      expect(await readFile(path.join(directory(a.instanceId), "runtime.env"), "utf8")).toBe("OWNER=a\n");
      await expect(access(path.join(root, ".devfn", "receipts", "outputs", `${b.instanceId}.json`))).rejects.toMatchObject({ code: "ENOENT" });
      // A directory recreated in its place is another directory, also refused.
      await unlink(directory(b.instanceId));
      const again = await claimEnvironmentOutputs(noOutputs, root, b);
      await rm(directory(b.instanceId), { recursive: true });
      await mkdir(directory(b.instanceId));
      await expect(again.assertRuntimeDirectory()).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
      await again.restore();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("detaches a generated name that reaches another runtime's file through a link inside its own directory", async () => {
    const root = await checkout();
    const a = await resolveInstanceIdentity("fixture", root, "a");
    const b = await resolveInstanceIdentity("fixture", root, "b");
    const noOutputs = validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), environmentOutputs: [] });
    const dir = (id: string) => path.join(root, ".devfn", "instances", id);
    const generated = [path.join("compose", "api.override.yaml"), path.join("logs", "app.log"), "runtime.env", "receipt.json"];
    try {
      const held = await claimEnvironmentOutputs(noOutputs, root, a);
      await held.commit();
      for (const file of generated) {
        await mkdir(path.dirname(path.join(dir(a.instanceId), file)), { recursive: true });
        await writeFile(path.join(dir(a.instanceId), file), `${a.instanceId} ${file}\n`);
      }
      const claim = await claimEnvironmentOutputs(noOutputs, root, b);
      await mkdir(path.join(dir(b.instanceId), "kept"), { recursive: true });
      for (const [index, file] of generated.entries()) {
        // b's name is a link to a file of b's own directory, which is a hard link to a's.
        const kept = path.join(dir(b.instanceId), "kept", `shared-${index}`);
        await link(path.join(dir(a.instanceId), file), kept);
        await mkdir(path.dirname(path.join(dir(b.instanceId), file)), { recursive: true });
        await symlink(path.relative(path.dirname(path.join(dir(b.instanceId), file)), kept), path.join(dir(b.instanceId), file));
        const target = await claim.runtimePath(file);
        expect((await lstat(target).catch(() => undefined))?.isSymbolicLink() ?? false).toBe(false);
        await writeFile(target, `${b.instanceId} ${file}\n`);
        expect(await readFile(path.join(dir(a.instanceId), file), "utf8")).toBe(`${a.instanceId} ${file}\n`);
        expect(await readFile(path.join(dir(b.instanceId), file), "utf8")).toBe(`${b.instanceId} ${file}\n`);
      }
      // A link inside to a file with one name is b's own, and is kept.
      await writeFile(path.join(dir(b.instanceId), "kept", "own.log"), "own\n");
      await rm(path.join(dir(b.instanceId), "logs", "app.log"));
      await symlink(path.join("..", "kept", "own.log"), path.join(dir(b.instanceId), "logs", "app.log"));
      await claim.runtimePath(path.join("logs", "app.log"));
      expect((await lstat(path.join(dir(b.instanceId), "logs", "app.log"))).isSymbolicLink()).toBe(true);
      await claim.restore();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses a default output that is a hard link to another runtime's log, receipt or claim, at the claim and at the in-place write", async () => {
    const root = await checkout();
    const fallback = path.join(root, ".env.default");
    const review = await resolveInstanceIdentity("fixture", root, "review");
    const defaultIdentity = await resolveInstanceIdentity("fixture", root);
    const reviewDir = path.join(root, ".devfn", "instances", review.instanceId);
    try {
      const held = await claimEnvironmentOutputs(config, root, review);
      await held.write(path.join(root, ".env.review"), "DEVFN_INSTANCE_ID=review\n", 0o600);
      const receipt = { version: 1, projectId: "fixture", instanceId: review.instanceId, runtime: "review", invocationId: "i", profile: "default", state: "ready", root, runtimeDir: reviewDir,
        stateDir: path.join(root, "state"), startedAt: "", updatedAt: "", allocations: [], processes: [], services: [], routes: [], urls: {}, environmentOutputs: [path.join(root, ".env.review")] } as unknown as Parameters<typeof writeReceipt>[0];
      await writeReceipt(receipt, { runtimeCopy: held.runtimePath });
      await held.commit();
      await mkdir(path.join(reviewDir, "logs"), { recursive: true });
      await writeFile(path.join(reviewDir, "logs", "app.log"), "REVIEW-LOG\n");
      const victims = [path.join(reviewDir, "logs", "app.log"), path.join(reviewDir, "receipt.json"),
        path.join(root, ".devfn", "receipts", `${review.instanceId}.json`), path.join(root, ".devfn", "receipts", "outputs", `${review.instanceId}.json`)];
      for (const victim of victims) {
        const before = await readFile(victim, "utf8");
        await link(victim, fallback);
        await expect(assertEnvironmentOutputsAvailable(config, root, defaultIdentity)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("same file (a hard link)"), details: { owner: { runtime: "review" } } });
        await unlink(fallback);
        // A link made after the default claimed its absent file is refused at the write, before any byte changes.
        const claim = await claimEnvironmentOutputs(config, root, defaultIdentity);
        await link(victim, fallback);
        await expect(claim.write(fallback, "DEVFN_INSTANCE_ID=default\n", 0o600)).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("hard link") });
        await claim.restore();
        await unlink(fallback);
        expect(await readFile(victim, "utf8")).toBe(before);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("checks every generated path of a start against the directory it bound, through readiness", async () => {
    const root = await checkout();
    const a = await resolveInstanceIdentity("fixture", root, "a");
    const b = await resolveInstanceIdentity("fixture", root, "b");
    const noOutputs = validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), environmentOutputs: [] });
    const dir = (id: string) => path.join(root, ".devfn", "instances", id);
    try {
      const held = await claimEnvironmentOutputs(noOutputs, root, a);
      await writeEnvironmentOutputs(root, dir(a.instanceId), [], { DEVFN_INSTANCE_ID: a.instanceId }, "a", { runtimePath: held.runtimePath });
      await writeFile(path.join(dir(a.instanceId), "receipt.json"), `${JSON.stringify({ instanceId: a.instanceId })}\n`);
      await held.commit();
      const aFiles = async () => await Promise.all(["runtime.env", "receipt.json"].map(async (file) => await readFile(path.join(dir(a.instanceId), file), "utf8")));
      const before = await aFiles();
      // b's runtime.env is a hard link to a's: b writes a new file of its own.
      await mkdir(dir(b.instanceId), { recursive: true });
      await link(path.join(dir(a.instanceId), "runtime.env"), path.join(dir(b.instanceId), "runtime.env"));
      const claim = await claimEnvironmentOutputs(noOutputs, root, b);
      await writeEnvironmentOutputs(root, dir(b.instanceId), [], { DEVFN_INSTANCE_ID: b.instanceId }, "b", { runtimePath: claim.runtimePath });
      expect(await readFile(path.join(dir(b.instanceId), "runtime.env"), "utf8")).toBe(`DEVFN_INSTANCE_ID=${b.instanceId}\n`);
      expect(await aFiles()).toEqual(before);
      // A generated file hard-linked to a's (a Compose override) loses only b's name, so its writer creates b's own file.
      await mkdir(path.join(dir(a.instanceId), "compose"));
      await writeFile(path.join(dir(a.instanceId), "compose", "api.override.yaml"), `# ${a.instanceId}\n`);
      await mkdir(path.join(dir(b.instanceId), "compose"));
      await link(path.join(dir(a.instanceId), "compose", "api.override.yaml"), path.join(dir(b.instanceId), "compose", "api.override.yaml"));
      await writeFile(await claim.runtimePath(path.join("compose", "api.override.yaml")), `# ${b.instanceId}\n`);
      expect(await readFile(path.join(dir(a.instanceId), "compose", "api.override.yaml"), "utf8")).toBe(`# ${a.instanceId}\n`);
      expect((await lstat(path.join(dir(a.instanceId), "compose", "api.override.yaml"))).nlink).toBe(1);
      expect(await readFile(path.join(dir(b.instanceId), "compose", "api.override.yaml"), "utf8")).toBe(`# ${b.instanceId}\n`);
      // A child link out of b's directory is refused; one that stays inside it is b's own.
      await rm(path.join(dir(b.instanceId), "runtime.env"));
      await symlink(path.join(dir(a.instanceId), "runtime.env"), path.join(dir(b.instanceId), "runtime.env"));
      await expect(claim.runtimePath("runtime.env")).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("symlink to") });
      await symlink(dir(a.instanceId), path.join(dir(b.instanceId), "logs"));
      await expect(claim.runtimePath(path.join("logs", "app.log"))).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
      await rm(path.join(dir(b.instanceId), "logs"));
      await mkdir(path.join(dir(b.instanceId), "kept"));
      await symlink("kept", path.join(dir(b.instanceId), "logs"));
      expect(await claim.runtimePath(path.join("logs", "app.log"))).toBe(path.join(await realpath(dir(b.instanceId)), "logs", "app.log"));
      // After its first writes, b's directory becomes a link to a's: each later receipt write records b's state stably and refuses the copy.
      const receipt = { version: 1, projectId: "fixture", instanceId: b.instanceId, runtime: "b", invocationId: "i", profile: "default", state: "ready", root, runtimeDir: dir(b.instanceId),
        stateDir: path.join(root, "state"), startedAt: "", updatedAt: "", allocations: [], processes: [], services: [], routes: [], urls: {}, environmentOutputs: [] } as unknown as Parameters<typeof writeReceipt>[0];
      await writeReceipt(receipt, { runtimeCopy: claim.runtimePath });
      await rename(dir(b.instanceId), `${dir(b.instanceId)}.moved`);
      await symlink(a.instanceId, dir(b.instanceId));
      await expect(writeReceipt(receipt, { runtimeCopy: claim.runtimePath })).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("changed during startup") });
      await expect(writeEnvironmentOutputs(root, dir(b.instanceId), [], { DEVFN_INSTANCE_ID: b.instanceId }, "b", { runtimePath: claim.runtimePath })).rejects.toMatchObject({ code: "DEVFN_RUNTIME_INVALID" });
      expect(JSON.parse(await readFile(path.join(root, ".devfn", "receipts", `${b.instanceId}.json`), "utf8"))).toMatchObject({ instanceId: b.instanceId });
      // A later write without the claim (down) never replaces the copy of a's receipt it now reaches.
      await writeReceipt({ ...receipt, state: "stopped" });
      expect(await aFiles()).toEqual(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("retries creating the claims directory and its lock while a sibling removes the empty directories it created", async () => {
    const root = await checkout();
    const identity = await resolveInstanceIdentity("fixture", root, "a");
    try {
      // The claims directory vanishes under mkdir, and a mkdir there reports EINVAL while it is being removed (macOS).
      mkdirFault.target = path.join(root, ".devfn", "receipts", "outputs");
      mkdirFault.codes = ["ENOENT", "EINVAL", "ENOENT"];
      const claim = await claimEnvironmentOutputs(config, root, identity);
      expect(mkdirFault.codes).toEqual([]);
      expect(JSON.parse(await readFile(path.join(root, ".devfn", "receipts", "outputs", `${identity.instanceId}.json`), "utf8"))).toMatchObject({ instanceId: identity.instanceId });
      await claim.restore();
      // A failure that is not that race is not retried.
      mkdirFault.target = path.join(root, ".devfn", "receipts", "outputs");
      mkdirFault.codes = ["EACCES"];
      await expect(claimEnvironmentOutputs(config, root, identity)).rejects.toMatchObject({ code: "EACCES" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reports an output that escapes the checkout as a doctor diagnostic alongside the others", async () => {
    const root = await checkout();
    const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "devfn-outside-")));
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "devfn-doctor-state-"));
    try {
      await symlink(outside, path.join(root, "ext"));
      const escaping = validateDevFnConfig({ ...JSON.parse(JSON.stringify(config)), environmentOutputs: [{ path: "ext/app.env" }] });
      const result = await new DevFnOrchestrator().doctor({ config: escaping, root, stateDir });
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "DEVFN_CONFIG_PATH_ESCAPE", severity: "error" }));
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "DEVFN_NODE_VERSION" }));
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("recovers the checkout's claim lock from a holder verified dead without waiting out a live one", { timeout: 60_000 }, async () => {
    const root = await checkout();
    const lock = path.join(root, ".devfn", "receipts", "outputs", "claims.lock");
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
      expect(JSON.parse(await readFile(path.join(root, ".devfn", "receipts", "outputs", `${(await resolveInstanceIdentity("fixture", root, "b")).instanceId}.json`), "utf8")))
        .toMatchObject({ runtime: "b", targets: [path.join(root, ".env.b")] });
    } finally {
      holder.kill("SIGKILL");
      await rm(root, { recursive: true, force: true });
    }
  });
});
