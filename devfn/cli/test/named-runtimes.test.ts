import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FilePortRegistry, withRoutingLock } from "@devfn/ports";
import { processExists } from "@devfn/config";
import { resolveInstanceIdentity } from "@devfn/core";
import { runCli } from "../src/index.js";

const execFileAsync = promisify(execFile);
const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Serves which runtime directory and mode it received; waits while a hold file exists so a start can be caught mid-flight.
const SERVER = `import http from "node:http";
import { existsSync } from "node:fs";
while (process.env.HOLD_FILE && existsSync(process.env.HOLD_FILE)) await new Promise((resolve) => setTimeout(resolve, 50));
const body = JSON.stringify({ artifactArg: process.argv[2], artifactEnv: process.env.DEVFN_ARTIFACT_DIR, instance: process.env.DEVFN_INSTANCE_ID, mode: process.env.MODE ?? "base" });
http.createServer((_request, response) => { response.writeHead(200); response.end(body); }).listen(Number(process.env.PORT), "127.0.0.1", () => console.log("ready " + process.env.DEVFN_INSTANCE_ID));
`;

const MANIFEST = {
  version: 1,
  project: { id: "runtimes-fixture" },
  ports: { app: { range: [45100, 45499], env: "PORT" } },
  processes: { app: { adapter: "command", command: [process.execPath, "server.mjs", "{{env.DEVFN_ARTIFACT_DIR}}"], artifacts: "runtime", ports: ["app"],
    env: { HOLD_FILE: "hold" }, health: { type: "http", port: "app", timeoutMs: 20_000 } } },
  profiles: { default: { processes: ["app"] }, alt: { processes: ["app"], environment: { MODE: "alt" } } },
  environmentOutputs: [{ path: ".env.{runtime}" }],
};

interface Receipt { state: string; instanceId: string; invocationId: string; runtime?: string; runtimeDir: string; profile: string; allocations: Array<{ port: number }>; processes: Array<{ pid: number; logPath: string }> }
interface Failure { error: { code: string; message: string; details?: Record<string, unknown> } }

const served = async (port: number) => JSON.parse(await (await fetch(`http://127.0.0.1:${port}/`)).text()) as { artifactArg: string; artifactEnv: string; instance: string; mode: string };
const groupSize = async (pgid: number) => (await execFileAsync("ps", ["-A", "-o", "pgid="])).stdout.split("\n").filter((line) => Number(line.trim()) === pgid).length;
const refused = async (port: number) => await fetch(`http://127.0.0.1:${port}/`).then(() => false, () => true);

describe("named runtimes", () => {
  it("runs named runtimes of one checkout and another worktree side by side through stop, reconfiguration, crashes and ambiguous cleanup", async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), "devfn-runtimes-")));
    const primary = path.join(parent, "checkout");
    const second = path.join(parent, "second");
    const stateDir = path.join(parent, "state");
    const children: number[] = [];
    await mkdir(primary);
    await execFileAsync("git", ["init", primary]);
    await writeFile(path.join(primary, ".gitignore"), ".devfn/\n.env.*\nhold\n");
    await execFileAsync("git", ["-C", primary, "add", ".gitignore"]);
    await execFileAsync("git", ["-C", primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "init"]);
    await execFileAsync("git", ["-C", primary, "worktree", "add", "--detach", second]);
    for (const root of [primary, second]) {
      await writeFile(path.join(root, "server.mjs"), SERVER);
      await writeFile(path.join(root, "devfn.config.json"), JSON.stringify(MANIFEST));
    }
    const run = async (cwd: string, ...args: string[]) => {
      let output = "";
      const code = await runCli([...args, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { output += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(output) as Receipt & Failure & Record<string, unknown> };
    };
    const runtimes = [[primary, []], [primary, ["--runtime", "a"]], [primary, ["--runtime", "b"]], [second, ["--runtime", "a"]]] as const;
    try {
      // Concurrent first starts of three runtimes of one checkout and a same-named runtime of another worktree.
      const started = await Promise.all(runtimes.map(async ([cwd, flags]) => await run(cwd, "up", ...flags)));
      for (const result of started) expect(result.code, JSON.stringify(result.value)).toBe(0);
      const [base, a, b, otherA] = started.map((result) => result.value);
      expect(new Set(started.map((result) => result.value.instanceId)).size).toBe(4);
      expect(new Set(started.map((result) => result.value.allocations[0].port)).size).toBe(4);
      expect(new Set(started.map((result) => result.value.runtimeDir)).size).toBe(4);
      expect(new Set(started.map((result) => result.value.processes[0].logPath)).size).toBe(4);
      // The default runtime keeps the v0.1 identity and receipt shape.
      const commonDir = await realpath(path.join(primary, ".git"));
      expect(base.instanceId).toBe(createHash("sha256").update(`${commonDir}\0${primary}\0runtimes-fixture`).digest("hex").slice(0, 12));
      expect(Object.hasOwn(JSON.parse(await readFile(path.join(primary, ".devfn", "receipts", `${base.instanceId}.json`), "utf8")), "runtime")).toBe(false);
      expect([a.runtime, b.runtime, otherA.runtime]).toEqual(["a", "b", "a"]);
      expect(otherA.instanceId).toBe((await resolveInstanceIdentity("runtimes-fixture", second, "a")).instanceId);
      // Each runtime has its own generated environment file and artifact directory.
      for (const [runtime, receipt] of [["default", base], ["a", a], ["b", b]] as const) {
        expect(await readFile(path.join(primary, `.env.${runtime}`), "utf8")).toContain(`DEVFN_PORT_APP=${receipt.allocations[0].port}`);
        const observed = await served(receipt.allocations[0].port);
        expect(observed).toMatchObject({ artifactArg: path.join(receipt.runtimeDir, "artifacts", "app"), artifactEnv: path.join(receipt.runtimeDir, "artifacts", "app"), instance: receipt.instanceId });
        expect((await stat(observed.artifactEnv)).mode & 0o777).toBe(0o700);
      }
      expect((await run(primary, "logs", "--runtime", "b")).value.app).toContain(`ready ${b.instanceId}`);
      expect((await run(primary, "runtimes")).value.runtimes).toEqual([
        expect.objectContaining({ runtime: "a", instanceId: a.instanceId, state: "ready", attributed: true }),
        expect.objectContaining({ runtime: "b", instanceId: b.instanceId, state: "ready", attributed: true }),
        expect.objectContaining({ runtime: "default", instanceId: base.instanceId, state: "ready", attributed: true }),
      ]);
      // A duplicate start of one runtime does not touch the others.
      expect((await run(primary, "up", "--runtime", "a")).value.error).toMatchObject({ code: "DEVFN_ALREADY_RUNNING", message: expect.stringContaining("runtime a") });

      // Reconfiguring one runtime replaces only it.
      const reconfigured = (await run(primary, "up", "--runtime", "a", "--profile", "alt")).value;
      expect(reconfigured).toMatchObject({ state: "ready", instanceId: a.instanceId, profile: "alt" });
      expect(reconfigured.invocationId).not.toBe(a.invocationId);
      expect((await served(reconfigured.allocations[0].port)).mode).toBe("alt");
      for (const receipt of [base, b]) expect((await run(primary, "status", ...(receipt.runtime ? ["--runtime", receipt.runtime] : []))).value).toMatchObject({ state: "ready", runtime: receipt.runtime ?? "default" });
      expect(await served(otherA.allocations[0].port)).toMatchObject({ mode: "base", instance: otherA.instanceId });

      // Stopping one runtime releases only its leases; same-named runtimes of other worktrees keep running.
      expect((await run(primary, "down", "--runtime", "b")).value.state).toBe("stopped");
      expect(processExists(b.processes[0].pid)).toBe(false);
      expect(await refused(b.allocations[0].port)).toBe(true);
      const leases = (await new FilePortRegistry(path.join(stateDir, "registry.json")).read()).allocations.filter((item) => item.state === "active");
      expect(new Set(leases.map((item) => item.instanceId))).toEqual(new Set([base.instanceId, a.instanceId, otherA.instanceId]));
      expect((await run(primary, "down", "--runtime", "a")).value.state).toBe("stopped");
      expect(await served(otherA.allocations[0].port)).toMatchObject({ instance: otherA.instanceId });
      expect(await served(base.allocations[0].port)).toMatchObject({ instance: base.instanceId });

      // A crashed process degrades only its runtime, and its restart leaves the others alone.
      const restartedA = (await run(primary, "up", "--runtime", "a")).value;
      // The recorded process leads its group; the crash takes the whole group.
      process.kill(-restartedA.processes[0].pid, "SIGKILL");
      await expect.poll(() => processExists(restartedA.processes[0].pid)).toBe(false);
      expect((await run(primary, "status", "--runtime", "a")).value).toMatchObject({ ok: false, state: "degraded" });
      expect((await run(primary, "status")).value).toMatchObject({ ok: true, state: "ready" });
      const recoveredA = (await run(primary, "up", "--runtime", "a")).value;
      expect(recoveredA).toMatchObject({ state: "ready", instanceId: a.instanceId });
      expect((await run(primary, "status")).value).toMatchObject({ state: "ready" });
      expect(await served(base.allocations[0].port)).toMatchObject({ instance: base.instanceId });

      // A DevFn killed mid-start leaves runtime c with a held lock, a starting receipt and an orphaned process.
      const c = await resolveInstanceIdentity("runtimes-fixture", primary, "c");
      await writeFile(path.join(primary, "hold"), "");
      const child = spawn(process.execPath, ["--input-type=module", "-e", `
        import { DevFnOrchestrator } from "@devfn/core";
        import { loadTrustedDevFnConfig } from "@devfn/config";
        const [root, stateDir] = process.argv.slice(1);
        const { config } = await loadTrustedDevFnConfig({ cwd: root, stateDir });
        await new DevFnOrchestrator().up({ config, root, stateDir, runtime: "c" });`, primary, stateDir], { cwd: packageDir, stdio: "ignore" });
      children.push(child.pid!);
      const receiptFile = path.join(primary, ".devfn", "receipts", `${c.instanceId}.json`);
      await expect.poll(async () => await readFile(receiptFile, "utf8").then((text) => (JSON.parse(text) as Receipt).processes.length, () => 0), { timeout: 20_000 }).toBe(1);
      const orphan = (JSON.parse(await readFile(receiptFile, "utf8")) as Receipt).processes[0].pid;
      // The wrapper runs the command only once DevFn opened its launch gate: wait for the command in its group.
      await expect.poll(async () => await groupSize(orphan), { timeout: 20_000 }).toBeGreaterThan(1);
      child.kill("SIGKILL");
      await expect.poll(() => processExists(child.pid!)).toBe(false);
      await rm(path.join(primary, "hold"));
      expect(processExists(orphan)).toBe(true);
      // While the dead DevFn's lock still holds runtime c, every other runtime keeps changing.
      const lockOwner = path.join(stateDir, `lifecycle-${c.instanceId}.lock`, "owner.json");
      // So does its checkout-wide instance lock.
      const instanceLockOwner = path.join(primary, ".devfn", "receipts", "outputs", `lifecycle-${c.instanceId}.lock`, "owner.json");
      for (const owner of [lockOwner, instanceLockOwner]) expect(JSON.parse(await readFile(owner, "utf8"))).toMatchObject({ pid: child.pid });
      expect((await run(primary, "down", "--runtime", "a")).value.state).toBe("stopped");
      expect((await run(primary, "up", "--runtime", "a")).value.state).toBe("ready");
      expect((await run(primary, "status", "--runtime", "c")).value).toMatchObject({ runtime: "c", state: "starting" });
      // Recovering c takes over both of the dead holder's locks within the lock timeout (nothing is aged),
      // stops the orphan and starts again, concurrently with stopping a.
      const [recoveredC, stoppedA, baseStatus] = await Promise.all([run(primary, "up", "--runtime", "c"), run(primary, "down", "--runtime", "a"), run(primary, "status")]);
      expect(recoveredC.value, JSON.stringify(recoveredC.value)).toMatchObject({ state: "ready", runtime: "c", instanceId: c.instanceId });
      expect(processExists(orphan)).toBe(false);
      expect(stoppedA.value.state).toBe("stopped");
      expect(baseStatus.value).toMatchObject({ state: "ready" });

      // Cleanup never guesses which runtime was meant.
      expect((await run(primary, "down")).value.state).toBe("stopped");
      const notRunning = await run(primary, "down");
      expect(notRunning.value.error).toMatchObject({ code: "DEVFN_NOT_RUNNING", details: { runtime: "default", otherRuntimes: ["c"] } });
      expect(processExists(recoveredC.value.processes[0].pid)).toBe(true);
      // A receipt at runtime d's paths that records runtime c is refused, not adopted or stopped.
      const d = await resolveInstanceIdentity("runtimes-fixture", primary, "d");
      const forged = JSON.parse(await readFile(receiptFile, "utf8")) as Receipt;
      await writeFile(path.join(primary, ".devfn", "receipts", `${d.instanceId}.json`), JSON.stringify({ ...forged, instanceId: d.instanceId }));
      for (const command of ["status", "down", "up"]) {
        expect((await run(primary, command, "--runtime", "d")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("will not guess") });
      }
      expect(processExists(recoveredC.value.processes[0].pid)).toBe(true);
      expect((await run(primary, "runtimes")).value.runtimes).toContainEqual(expect.objectContaining({ runtime: "c", instanceId: d.instanceId, attributed: false }));
      await rm(path.join(primary, ".devfn", "receipts", `${d.instanceId}.json`));
    } finally {
      for (const pid of children) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
      await rm(path.join(primary, "hold"), { force: true });
      for (const [cwd, flags] of [...runtimes, [primary, ["--runtime", "c"]] as const]) await run(cwd, "down", ...flags).catch(() => undefined);
      await execFileAsync("git", ["-C", primary, "worktree", "remove", "--force", second]).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  }, 180_000);

  it("refuses runtime selections that would share checkout state before any lifecycle state exists", async () => {
    const cwd = await realpath(await mkdtemp(path.join(tmpdir(), "devfn-runtime-refusals-")));
    const stateDir = path.join(cwd, "state");
    const run = async (...args: string[]) => {
      let output = "";
      const code = await runCli([...args, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { output += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(output) as Failure };
    };
    try {
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ ...MANIFEST, environmentOutputs: [{ path: ".env.local" }] }));
      expect((await run("up", "--runtime", "review")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", details: { environmentOutputs: [".env.local"] } });
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ ...MANIFEST, processes: { worker: { adapter: "wrangler", command: ["dev"] } }, profiles: { default: { processes: ["worker"] } } }));
      expect((await run("up", "--runtime", "review")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", details: { processes: ["worker"] } });
      // extfn dev writes dist/<target>-dev in the checkout too.
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ ...MANIFEST, processes: { extension: { adapter: "extfn" } }, profiles: { default: { processes: ["extension"] } } }));
      expect((await run("up", "--runtime", "review")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", details: { processes: ["extension"] } });
      // Outputs that two runtimes could resolve to one file never load: runtime b's .env.a-b would be runtime a-b's .env.a-b.
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ ...MANIFEST, environmentOutputs: [{ path: ".env.{runtime}" }, { path: ".env.a-{runtime}" }] }));
      for (const runtime of ["b", "a-b"]) expect((await run("up", "--runtime", runtime)).value.error).toMatchObject({ code: "DEVFN_CONFIG_INVALID", message: expect.stringContaining("can name one file") });
      for (const name of ["Review", "-x", "a".repeat(25), "a_b"]) expect((await run("status", "--runtime", name)).value.error.code).toBe("DEVFN_RUNTIME_INVALID");
      expect((await run("ports", "--runtime", "review")).value.error.message).toContain("--runtime applies only to");
      expect((await run("tunnel", "list", "--runtime", "review")).value.error.message).toContain("--runtime applies only to");
      await expect(access(path.join(cwd, ".devfn"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.join(stateDir, "registry.json"))).rejects.toMatchObject({ code: "ENOENT" });
      // doctor reports what up refuses for the selected runtime, and nothing of it for the default runtime.
      await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ ...MANIFEST, environmentOutputs: [{ path: ".env.local" }] }));
      const diagnosed = async (...args: string[]) => {
        const { code, value } = await run("doctor", ...args);
        return { code, refusals: (value as unknown as { diagnostics: Array<{ code: string; severity: string; details?: unknown }> }).diagnostics.filter((item) => item.code === "DEVFN_RUNTIME_INVALID") };
      };
      expect(await diagnosed("--runtime", "review")).toEqual({ code: 1, refusals: [expect.objectContaining({ severity: "error", details: { runtime: "review", environmentOutputs: [".env.local"] } })] });
      expect((await diagnosed()).refusals).toEqual([]);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });

  it("claims environment-output files so no runtime overwrites another runtime's or a user's file", async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), "devfn-output-claims-")));
    const cwd = path.join(parent, "checkout");
    const stateDir = path.join(parent, "state");
    await mkdir(cwd);
    await execFileAsync("git", ["init", cwd]);
    await writeFile(path.join(cwd, "server.mjs"), SERVER);
    const manifest = async (...outputs: string[]) => await writeFile(path.join(cwd, "devfn.config.json"), JSON.stringify({ ...MANIFEST, environmentOutputs: outputs.map((item) => ({ path: item })) }));
    const run = async (...args: string[]) => {
      let output = "";
      const code = await runCli([...args, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { output += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(output) as Receipt & Failure & { diagnostics?: Array<{ code: string; severity: string; details?: Record<string, unknown> }> } };
    };
    const id = async (runtime?: string) => (await resolveInstanceIdentity("runtimes-fixture", cwd, runtime)).instanceId;
    const read = async (file: string) => await readFile(path.join(cwd, file), "utf8");
    const leased = async (instanceId: string) => (await new FilePortRegistry(path.join(stateDir, "registry.json")).read().catch(() => ({ allocations: [] as Array<{ instanceId: string; state: string }> })))
      .allocations.some((item) => item.instanceId === instanceId && item.state !== "released");
    const claimFile = async (runtime?: string) => path.join(cwd, ".devfn", "receipts", "outputs", `${await id(runtime)}.json`);
    try {
      // (a) A user's .env.local is never a named runtime's .env.{runtime}: refused before any lease, receipt or claim, and doctor says so.
      await writeFile(path.join(cwd, ".env.local"), "SECRET=user-owned\n");
      await manifest(".env.{runtime}");
      const userFile = await run("up", "--runtime", "local");
      expect(userFile.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("already exists"), details: { runtime: "local", target: path.join(cwd, ".env.local") } });
      expect(await read(".env.local")).toBe("SECRET=user-owned\n");
      await expect(access(path.join(cwd, ".devfn", "receipts", `${await id("local")}.json`))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(await claimFile("local"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await leased(await id("local"))).toBe(false);
      const doctor = await run("doctor", "--runtime", "local");
      expect(doctor.code).toBe(1);
      expect(doctor.value.diagnostics).toContainEqual(expect.objectContaining({ code: "DEVFN_RUNTIME_INVALID", severity: "error", details: expect.objectContaining({ target: path.join(cwd, ".env.local") }) }));
      // A named runtime never writes through a symlink.
      await symlink(".env.local", path.join(cwd, ".env.link"));
      expect((await run("up", "--runtime", "link")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("symlink") });
      await unlink(path.join(cwd, ".env.link"));

      // (e) The default runtime keeps v0.1 literal outputs, also over an existing file. Started by an earlier release, it has no claim record:
      // its live receipt still holds what it wrote, and a live receipt that records nothing holds every file.
      await manifest(".env.local");
      const base = (await run("up")).value;
      expect(base.state).toBe("ready");
      expect(await read(".env.local")).toContain(`DEVFN_INSTANCE_ID=${base.instanceId}`);
      await rm(await claimFile());
      await manifest(".env.{runtime}");
      expect((await run("up", "--runtime", "local")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", details: { target: path.join(cwd, ".env.local"), owner: { runtime: "default", instanceId: base.instanceId } } });
      const baseReceipt = path.join(cwd, ".devfn", "receipts", `${base.instanceId}.json`);
      const recorded = await readFile(baseReceipt, "utf8");
      await writeFile(baseReceipt, JSON.stringify({ ...JSON.parse(recorded), environmentOutputs: [] }));
      expect((await run("up", "--runtime", "x")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("records no environment outputs"), details: { owner: { runtime: "default" } } });
      await expect(access(path.join(cwd, ".env.x"))).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(baseReceipt, recorded);
      expect(await served(base.allocations[0].port)).toMatchObject({ instance: base.instanceId });
      expect((await run("down")).value.state).toBe("stopped");
      // Stopped, the default runtime's .env.local is still not runtime local's to overwrite.
      expect((await run("up", "--runtime", "local")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("did not write it") });
      await rm(path.join(cwd, ".env.local"));

      // (b) A later manifest cannot point runtime b at running runtime a-b's file.
      const ab = (await run("up", "--runtime", "a-b")).value;
      expect(ab.state).toBe("ready");
      const abFile = await read(".env.a-b");
      await manifest(".env.a-{runtime}");
      expect((await run("up", "--runtime", "b")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", details: { target: path.join(cwd, ".env.a-b"), owner: { runtime: "a-b", instanceId: ab.instanceId } } });
      expect(await read(".env.a-b")).toBe(abFile);
      expect(await served(ab.allocations[0].port)).toMatchObject({ instance: ab.instanceId });
      await expect(access(path.join(cwd, ".devfn", "receipts", `${await id("b")}.json`))).rejects.toMatchObject({ code: "ENOENT" });

      // (c) A symlinked directory is the directory it names: a restart of a-b takes the new outputs, b may not reach them through the alias.
      await mkdir(path.join(cwd, "config"));
      await symlink("config", path.join(cwd, "alias"));
      await manifest("config/app.{runtime}.env", "alias/app.a-{runtime}.env");
      const restarted = (await run("restart", "--runtime", "a-b")).value;
      expect(restarted).toMatchObject({ state: "ready", instanceId: ab.instanceId });
      const configFile = await read("config/app.a-b.env");
      expect(configFile).toContain(`DEVFN_PORT_APP=${restarted.allocations[0].port}`);
      expect((await run("up", "--runtime", "b")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", details: { target: path.join(cwd, "config", "app.a-b.env"), owner: { runtime: "a-b" } } });
      expect(await read("config/app.a-b.env")).toBe(configFile);
      expect((await run("down", "--runtime", "a-b")).value.state).toBe("stopped");

      // (d) Started concurrently, runtimes whose outputs coincide get exactly one winner, which owns the file.
      for (const file of ["app.a-b.env", "app.a-a-b.env"]) await rm(path.join(cwd, "config", file));
      const raced = await Promise.all(["a-b", "b"].map(async (runtime) => ({ runtime, ...await run("up", "--runtime", runtime) })));
      const winners = raced.filter((item) => item.code === 0);
      expect(winners, JSON.stringify(raced.map((item) => item.value.error ?? item.value.state))).toHaveLength(1);
      const loser = raced.find((item) => item.code !== 0)!;
      expect(loser.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", details: { owner: { runtime: winners[0].runtime } } });
      expect(await read("config/app.a-b.env")).toContain(`DEVFN_INSTANCE_ID=${winners[0].value.instanceId}`);
      expect(await leased(await id(loser.runtime))).toBe(false);

      // (f) The winner rewrites its own files on a profile switch and after down and up; down releases only its claim.
      const winner = winners[0].runtime;
      const switched = (await run("up", "--runtime", winner, "--profile", "alt")).value;
      expect(switched).toMatchObject({ state: "ready", profile: "alt" });
      expect(await read("config/app.a-b.env")).toContain(`DEVFN_PORT_APP=${switched.allocations[0].port}`);
      expect((await run("down", "--runtime", winner)).value.state).toBe("stopped");
      expect(JSON.parse(await readFile(await claimFile(winner), "utf8"))).toMatchObject({ targets: [] });
      const again = (await run("up", "--runtime", winner)).value;
      expect(again.state).toBe("ready");
      expect(await read("config/app.a-b.env")).toContain(`DEVFN_PORT_APP=${again.allocations[0].port}`);
      expect((await run("down", "--runtime", winner)).value.state).toBe("stopped");

      // A claim holds while the DevFn that made it runs or its receipt is live: a dead claimant without a receipt holds nothing.
      await manifest(".env.{runtime}");
      const exited = spawn(process.execPath, ["-e", ""]);
      await new Promise((resolve) => exited.on("exit", resolve));
      const forged = async (pid: number) => await writeFile(await claimFile("q"), JSON.stringify({ version: 1, instanceId: await id("q"), runtime: "q", targets: [path.join(cwd, ".env.r")], written: [], pid, createdAt: new Date().toISOString() }));
      await forged(process.pid);
      expect((await run("up", "--runtime", "r")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", details: { owner: { runtime: "q" } } });
      await forged(exited.pid!);
      expect((await run("up", "--runtime", "r")).value.state).toBe("ready");
      expect((await run("down", "--runtime", "r")).value.state).toBe("stopped");
    } finally {
      for (const runtime of [[], ["--runtime", "a-b"], ["--runtime", "b"], ["--runtime", "r"], ["--runtime", "local"]]) await run("down", ...runtime).catch(() => undefined);
      await rm(parent, { recursive: true, force: true });
    }
  }, 180_000);

  it("creates a named runtime's output files only where nothing else appeared, attributing each as it is written", async () => {
    const parent = await realpath(await mkdtemp(path.join(tmpdir(), "devfn-output-writes-")));
    const cwd = path.join(parent, "checkout");
    const stateDir = path.join(parent, "state");
    await mkdir(cwd);
    await mkdir(stateDir);
    await execFileAsync("git", ["init", cwd]);
    await writeFile(path.join(cwd, "server.mjs"), SERVER);
    const manifest = async (outputs: string[], projectId = "runtimes-fixture") => await writeFile(path.join(cwd, "devfn.config.json"),
      JSON.stringify({ ...MANIFEST, project: { id: projectId }, environmentOutputs: outputs.map((item) => ({ path: item })) }));
    const run = async (...args: string[]) => {
      let output = "";
      const code = await runCli([...args, "--trust", "--json", "--state-dir", stateDir], { cwd, stdout: (text) => { output += text; }, stderr: () => undefined });
      return { code, value: JSON.parse(output) as Receipt & Failure & { diagnostics?: Array<{ code: string; severity: string; message: string; details?: Record<string, unknown> }> } };
    };
    const id = async (runtime?: string, projectId = "runtimes-fixture") => (await resolveInstanceIdentity(projectId, cwd, runtime)).instanceId;
    const read = async (file: string) => await readFile(path.join(cwd, file), "utf8");
    const exists = async (file: string) => await access(file).then(() => true, () => false);
    const leased = async (instanceId: string) => (await new FilePortRegistry(path.join(stateDir, "registry.json")).read().catch(() => ({ allocations: [] as Array<{ instanceId: string; state: string }> })))
      .allocations.some((item) => item.instanceId === instanceId && item.state !== "released");
    const claimFile = async (runtime?: string) => path.join(cwd, ".devfn", "receipts", "outputs", `${await id(runtime)}.json`);
    const receiptFile = async (runtime?: string, projectId?: string) => path.join(cwd, ".devfn", "receipts", `${await id(runtime, projectId)}.json`);
    // Starts a runtime (review unless named) while the routing lock is held, so it waits after claiming its outputs; meanwhile plant() changes the checkout.
    const raceAfterClaim = async (plant: () => Promise<void>, runtime: string | null = "review") => {
      const claim = await claimFile(runtime ?? undefined);
      let release!: () => void;
      let locked!: () => void;
      const lockedNow = new Promise<void>((resolve) => { locked = resolve; });
      const holder = withRoutingLock(stateDir, async () => { locked(); await new Promise<void>((resolve) => { release = resolve; }); });
      await lockedNow;
      const started = run("up", ...runtime ? ["--runtime", runtime] : []);
      for (let attempt = 0; attempt < 400 && !await exists(claim); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(await exists(claim)).toBe(true);
      await plant();
      release();
      await holder;
      return await started;
    };
    try {
      // A write that fails partway leaves the files it wrote attributed: the runtime recovers them, with and without down.
      await mkdir(path.join(cwd, "ro"));
      await chmod(path.join(cwd, "ro"), 0o555);
      await manifest([".env.{runtime}", "ro/app.{runtime}.env"]);
      const partial = await run("up", "--runtime", "p");
      expect(partial.value.error).toMatchObject({ code: "DEVFN_START_FAILED", message: expect.stringContaining("environment output ro/app.p.env"), details: { causeCode: "EACCES" } });
      expect(await read(".env.p")).toContain(`DEVFN_INSTANCE_ID=${await id("p")}`);
      expect(JSON.parse(await readFile(await claimFile("p"), "utf8"))).toMatchObject({ targets: [], written: [{ target: path.join(cwd, ".env.p"), sha256: createHash("sha256").update(await read(".env.p")).digest("hex") }] });
      expect(await exists(await receiptFile("p"))).toBe(false);
      expect(await leased(await id("p"))).toBe(false);
      await chmod(path.join(cwd, "ro"), 0o755);
      const recovered = (await run("up", "--runtime", "p")).value;
      expect(recovered.state).toBe("ready");
      expect(await read(".env.p")).toContain(`DEVFN_PORT_APP=${recovered.allocations[0].port}`);
      expect(await read("ro/app.p.env")).toContain(`DEVFN_INSTANCE_ID=${recovered.instanceId}`);
      expect((await run("down", "--runtime", "p")).value.state).toBe("stopped");
      await rm(path.join(cwd, "ro", "app.p.env"));
      await chmod(path.join(cwd, "ro"), 0o555);
      expect((await run("up", "--runtime", "p")).value.error).toMatchObject({ code: "DEVFN_START_FAILED" });
      await chmod(path.join(cwd, "ro"), 0o755);
      expect((await run("down", "--runtime", "p")).value.error).toMatchObject({ code: "DEVFN_NOT_RUNNING" });
      expect((await run("up", "--runtime", "p")).value.state).toBe("ready");
      expect((await run("down", "--runtime", "p")).value.state).toBe("stopped");

      // A file created between the claim and the write is left as it is, and the start leaves no receipt and no lease.
      await manifest([".env.{runtime}"]);
      const userCreated = await raceAfterClaim(async () => await writeFile(path.join(cwd, ".env.review"), "USER=data\n"));
      expect(userCreated.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("created by someone else"), details: { runtime: "review", target: path.join(cwd, ".env.review") } });
      expect(await read(".env.review")).toBe("USER=data\n");
      expect(await exists(await receiptFile("review"))).toBe(false);
      expect(await leased(await id("review"))).toBe(false);
      expect(await exists(await claimFile("review"))).toBe(false);
      // A symlink planted in that window is not followed.
      await rm(path.join(cwd, ".env.review"));
      await writeFile(path.join(cwd, "victim.txt"), "VICTIM=1\n");
      const linked = await raceAfterClaim(async () => await symlink("victim.txt", path.join(cwd, ".env.review")));
      expect(linked.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("symlink") });
      expect(await read("victim.txt")).toBe("VICTIM=1\n");
      expect(await exists(await receiptFile("review"))).toBe(false);
      await unlink(path.join(cwd, ".env.review"));

      // Interrupted between creating a file and recording it: the file is adopted only if it holds the content recorded before it was created.
      const review = (await run("up", "--runtime", "review")).value;
      expect(review.state).toBe("ready");
      expect((await run("down", "--runtime", "review")).value.state).toBe("stopped");
      const interrupted = async () => {
        const claim = JSON.parse(await readFile(await claimFile("review"), "utf8")) as { written: string[] };
        const content = await readFile(path.join(cwd, ".env.review"));
        await writeFile(await claimFile("review"), JSON.stringify({ ...claim, written: [], pending: [{ target: path.join(cwd, ".env.review"), sha256: createHash("sha256").update(content).digest("hex") }] }));
      };
      await interrupted();
      const adopted = (await run("up", "--runtime", "review")).value;
      expect(adopted.state).toBe("ready");
      expect(await read(".env.review")).toContain(`DEVFN_PORT_APP=${adopted.allocations[0].port}`);
      expect((await run("down", "--runtime", "review")).value.state).toBe("stopped");
      await interrupted();
      await writeFile(path.join(cwd, ".env.review"), "USER=replaced\n");
      expect((await run("up", "--runtime", "review")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("did not write it") });
      expect(await read(".env.review")).toBe("USER=replaced\n");

      // A file the runtime wrote is replaced only while it holds what the runtime last wrote: a user's later edit is refused, also by doctor.
      await rm(path.join(cwd, ".env.review"));
      await rm(await claimFile("review"));
      expect((await run("up", "--runtime", "review")).value.state).toBe("ready");
      expect((await run("down", "--runtime", "review")).value.state).toBe("stopped");
      await writeFile(path.join(cwd, ".env.review"), "USER=edited\n");
      expect((await run("up", "--runtime", "review")).value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("changed since runtime review wrote it"), details: { target: path.join(cwd, ".env.review") } });
      expect(await read(".env.review")).toBe("USER=edited\n");
      const edited = await run("doctor", "--runtime", "review");
      expect(edited.code).toBe(1);
      expect(edited.value.diagnostics).toContainEqual(expect.objectContaining({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("changed since") }));
      await rm(path.join(cwd, ".env.review"));

      // A staging file an interrupted write left beside a claimed output is removed by the next claim.
      const leftover = path.join(cwd, "..env.review.00000000-0000-4000-8000-000000000000.devfn-tmp");
      await writeFile(leftover, "DEVFN_INSTANCE_ID=partial\n");
      const live = (await run("up", "--runtime", "review")).value;
      expect(live.state).toBe("ready");
      expect(await exists(leftover)).toBe(false);

      // Every runtime, default included, writes only the canonical file it claimed: a symlink planted at the default's
      // output after its claim cannot redirect the write onto running runtime review's file.
      const reviewFile = await read(".env.review");
      const redirected = await raceAfterClaim(async () => await symlink(".env.review", path.join(cwd, ".env.default")), null);
      expect(redirected.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("not the file it claimed"), details: { runtime: "default", target: path.join(cwd, ".env.review") } });
      expect(await read(".env.review")).toBe(reviewFile);
      expect(await served(live.allocations[0].port)).toMatchObject({ instance: live.instanceId });
      expect(await exists(await receiptFile())).toBe(false);
      expect(await leased(await id())).toBe(false);
      await unlink(path.join(cwd, ".env.default"));
      // Nor can a hard link to review's file, present before up (refused by up and doctor) or made after the claim (refused at the write).
      await link(path.join(cwd, ".env.review"), path.join(cwd, ".env.default"));
      const aliased = await run("up");
      expect(aliased.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("hard link"), details: { runtime: "default", owner: { runtime: "review", instanceId: live.instanceId } } });
      const aliasDoctor = await run("doctor");
      expect(aliasDoctor.code).toBe(1);
      expect(aliasDoctor.value.diagnostics).toContainEqual(expect.objectContaining({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("hard link") }));
      await unlink(path.join(cwd, ".env.default"));
      const linkedLater = await raceAfterClaim(async () => await link(path.join(cwd, ".env.review"), path.join(cwd, ".env.default")), null);
      expect(linkedLater.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("hard link"), details: { runtime: "default" } });
      for (const outcome of [aliased, linkedLater]) expect(outcome.code).toBe(1);
      expect(await read(".env.review")).toBe(reviewFile);
      expect(await served(live.allocations[0].port)).toMatchObject({ instance: live.instanceId });
      expect(await exists(await receiptFile())).toBe(false);
      expect(await leased(await id())).toBe(false);
      await unlink(path.join(cwd, ".env.default"));
      // Nor can a directory on its path that is swapped for a symlink after the claim.
      await manifest(["cfg/.env.review"]);
      await mkdir(path.join(cwd, "cfg"));
      const swapped = await raceAfterClaim(async () => { await rm(path.join(cwd, "cfg"), { recursive: true }); await symlink(".", path.join(cwd, "cfg")); }, null);
      expect(swapped.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", details: { runtime: "default", target: path.join(cwd, ".env.review") } });
      expect(await read(".env.review")).toBe(reviewFile);
      expect(await exists(await receiptFile())).toBe(false);
      await unlink(path.join(cwd, "cfg"));
      await manifest([".env.{runtime}"]);
      // Nor can another runtime whose runtime directory is a symlink to review's: its logs, receipt and runtime.env would land in review's.
      const reviewDir = path.join(cwd, ".devfn", "instances", live.instanceId);
      const snapshot = async () => await Promise.all(["receipt.json", "runtime.env", path.join("logs", "app.log")].map(async (file) => await readFile(path.join(reviewDir, file), "utf8").catch(() => null)));
      const before = await snapshot();
      await symlink(live.instanceId, path.join(cwd, ".devfn", "instances", await id("b")));
      const sharedDir = await run("up", "--runtime", "b");
      expect(sharedDir.code).toBe(1);
      expect(sharedDir.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("the runtime directory of runtime review"), details: { runtime: "b", owner: { runtime: "review", instanceId: live.instanceId } } });
      expect(await snapshot()).toEqual(before);
      expect(await served(live.allocations[0].port)).toMatchObject({ instance: live.instanceId });
      expect(await exists(await receiptFile("b"))).toBe(false);
      expect(await exists(await claimFile("b"))).toBe(false);
      expect(await leased(await id("b"))).toBe(false);
      await unlink(path.join(cwd, ".devfn", "instances", await id("b")));
      // Nor when that symlink replaces b's runtime directory after b claimed it: b refuses before its first generated write.
      const redirectedDir = await raceAfterClaim(async () => {
        await rm(path.join(cwd, ".devfn", "instances", await id("b")), { recursive: true, force: true });
        await symlink(live.instanceId, path.join(cwd, ".devfn", "instances", await id("b")));
      }, "b");
      expect(redirectedDir.code).toBe(1);
      expect(redirectedDir.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining("changed during startup"), details: { runtime: "b" } });
      expect(await snapshot()).toEqual(before);
      expect(await served(live.allocations[0].port)).toMatchObject({ instance: live.instanceId });
      expect(await exists(await receiptFile("b"))).toBe(false);
      expect(await exists(await claimFile("b"))).toBe(false);
      expect(await leased(await id("b"))).toBe(false);
      await unlink(path.join(cwd, ".devfn", "instances", await id("b")));
      expect((await run("down", "--runtime", "review")).value.state).toBe("stopped");

      // Every file a start generates in its runtime directory is its own, in
      // the directory it claimed, through readiness: b's runtime.env, receipt
      // and log survive c's runtime.env linked to b's, c's logs linked to b's
      // logs, and c's runtime directory redirected to b's mid-start.
      await manifest([]);
      const sibling = (await run("up", "--runtime", "b")).value;
      expect(sibling.state).toBe("ready");
      const bDir = path.join(cwd, ".devfn", "instances", sibling.instanceId);
      const cDir = path.join(cwd, ".devfn", "instances", await id("c"));
      const bFiles = async () => await Promise.all(["receipt.json", "runtime.env", path.join("logs", "app.log")].map(async (file) => await readFile(path.join(bDir, file), "utf8")));
      const bBefore = await bFiles();
      expect(bBefore[1]).toContain(`DEVFN_INSTANCE_ID=${sibling.instanceId}`);
      await mkdir(cDir, { recursive: true });
      await link(path.join(bDir, "runtime.env"), path.join(cDir, "runtime.env"));
      const hardLinked = (await run("up", "--runtime", "c")).value;
      expect(hardLinked.state).toBe("ready");
      expect(await readFile(path.join(cDir, "runtime.env"), "utf8")).toContain(`DEVFN_INSTANCE_ID=${hardLinked.instanceId}`);
      expect((await stat(path.join(bDir, "runtime.env"))).nlink).toBe(1);
      expect(await bFiles()).toEqual(bBefore);
      expect((await run("down", "--runtime", "c")).value.state).toBe("stopped");
      await rm(path.join(cDir, "runtime.env"));
      await symlink(path.join(bDir, "runtime.env"), path.join(cDir, "runtime.env"));
      const envLinked = await run("up", "--runtime", "c");
      expect(envLinked.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining(`symlink to ${await realpath(path.join(bDir, "runtime.env"))}`) });
      expect(await bFiles()).toEqual(bBefore);
      await unlink(path.join(cDir, "runtime.env"));
      await rm(path.join(cDir, "logs"), { recursive: true, force: true });
      await symlink(path.join(bDir, "logs"), path.join(cDir, "logs"));
      const logsLinked = await run("up", "--runtime", "c");
      expect(logsLinked.code).toBe(1);
      expect(logsLinked.value.error.message).toContain("is a symlink to");
      expect(await bFiles()).toEqual(bBefore);
      await unlink(path.join(cDir, "logs"));
      // c is held in its readiness wait, after its runtime.env, receipt and log are written, while its runtime directory becomes a link to b's.
      await writeFile(path.join(cwd, "hold"), "");
      const midStart = run("up", "--runtime", "c");
      for (let attempt = 0; attempt < 400 && !await exists(path.join(cDir, "logs", "app.log")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await rename(cDir, `${cDir}.moved`);
      await symlink(sibling.instanceId, cDir);
      await unlink(path.join(cwd, "hold"));
      const redirectedMidStart = await midStart;
      expect(redirectedMidStart.code).toBe(1);
      expect(redirectedMidStart.value.error).toMatchObject({ code: "DEVFN_START_FAILED", message: expect.stringContaining("changed during startup") });
      expect(await bFiles()).toEqual(bBefore);
      expect(JSON.parse(await readFile(await receiptFile("c"), "utf8"))).toMatchObject({ state: "failed", instanceId: await id("c") });
      expect(await served(sibling.allocations[0].port)).toMatchObject({ instance: sibling.instanceId });
      expect(await leased(await id("c"))).toBe(false);
      await unlink(cDir);
      // c's receipt copy is a link out of its directory: the first save lands the stable receipt and refuses the copy, and the stable receipt records the failure.
      await mkdir(cDir);
      await symlink(path.join(bDir, "receipt.json"), path.join(cDir, "receipt.json"));
      const copyRefused = await run("up", "--runtime", "c");
      expect(copyRefused.value.error).toMatchObject({ code: "DEVFN_START_FAILED", message: expect.stringContaining("symlink to") });
      expect(JSON.parse(await readFile(await receiptFile("c"), "utf8"))).toMatchObject({ state: "failed", error: { code: "DEVFN_RUNTIME_INVALID" } });
      expect(await bFiles()).toEqual(bBefore);
      expect(await leased(await id("c"))).toBe(false);
      await unlink(path.join(cDir, "receipt.json"));
      expect((await run("up", "--runtime", "c")).value.state).toBe("ready");
      expect((await run("down", "--runtime", "c")).value.state).toBe("stopped");
      expect((await run("down", "--runtime", "b")).value.state).toBe("stopped");
      await manifest([".env.{runtime}"]);

      // v0.1 compatibility: the default runtime writes through a symlink that existed before up and over a user's file.
      await writeFile(path.join(cwd, "shared.env"), "USER=owned\n");
      await symlink("shared.env", path.join(cwd, ".env.linked"));
      await writeFile(path.join(cwd, ".env.user"), "USER=owned\n");
      await manifest([".env.linked", ".env.user"]);
      const compatible = (await run("up")).value;
      expect(compatible.state).toBe("ready");
      for (const file of ["shared.env", ".env.user"]) expect(await read(file)).toContain(`DEVFN_INSTANCE_ID=${compatible.instanceId}`);
      expect((await lstat(path.join(cwd, ".env.linked"))).isSymbolicLink()).toBe(true);
      expect((await run("down")).value.state).toBe("stopped");

      // A live receipt this manifest cannot select (its project ID changed) is named with a remedy that reaches it.
      await manifest([".env.shared"], "renamed-a");
      expect((await run("up")).value.state).toBe("ready");
      await manifest([".env.shared"], "renamed-b");
      const unreachable = await run("up");
      const ownerReceipt = await receiptFile(undefined, "renamed-a");
      expect(unreachable.value.error).toMatchObject({ code: "DEVFN_RUNTIME_INVALID", details: { owner: { instanceId: await id(undefined, "renamed-a"), projectId: "renamed-a", receipt: ownerReceipt } } });
      expect(unreachable.value.error.message).toContain(`${ownerReceipt} records project "renamed-a"`);
      expect(unreachable.value.error.message).toContain('set project.id back to "renamed-a" and run devfn down');
      const doctor = await run("doctor");
      expect(doctor.code).toBe(1);
      expect(doctor.value.diagnostics).toContainEqual(expect.objectContaining({ code: "DEVFN_RUNTIME_INVALID", message: expect.stringContaining(ownerReceipt) }));
      await manifest([".env.shared"], "renamed-a");
      expect((await run("down")).value.state).toBe("stopped");
      await manifest([".env.shared"], "renamed-b");
      expect((await run("up")).value.state).toBe("ready");
      expect((await run("down")).value.state).toBe("stopped");
    } finally {
      await chmod(path.join(cwd, "ro"), 0o755).catch(() => undefined);
      for (const [projectId, runtime] of [["runtimes-fixture", "p"], ["runtimes-fixture", "review"], ["runtimes-fixture", "b"], ["runtimes-fixture", "c"], ["runtimes-fixture"], ["renamed-a"], ["renamed-b"]]) {
        await manifest([".env.{runtime}"], projectId).catch(() => undefined);
        await run("down", ...runtime ? ["--runtime", runtime] : []).catch(() => undefined);
      }
      await rm(parent, { recursive: true, force: true });
    }
  }, 180_000);
});
