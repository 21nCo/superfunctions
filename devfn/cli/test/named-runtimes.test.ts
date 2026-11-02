import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { FilePortRegistry } from "@devfn/ports";
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
      expect(JSON.parse(await readFile(lockOwner, "utf8"))).toMatchObject({ pid: child.pid });
      expect((await run(primary, "down", "--runtime", "a")).value.state).toBe("stopped");
      expect((await run(primary, "up", "--runtime", "a")).value.state).toBe("ready");
      expect((await run(primary, "status", "--runtime", "c")).value).toMatchObject({ runtime: "c", state: "starting" });
      // Once the dead holder's lock is past its stale window (aged here instead of waited for), recovering c,
      // which takes over that lock, stops the orphan and starts again, runs concurrently with stopping a.
      const aged = JSON.parse(await readFile(lockOwner, "utf8")) as Record<string, unknown>;
      await writeFile(lockOwner, JSON.stringify({ ...aged, createdAt: new Date(Date.now() - 600_000).toISOString() }));
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
});
