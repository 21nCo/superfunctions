import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, fchmodSync, mkdirSync, openSync } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveContainedPath } from "@devfn/config";

import { createProcessEnvironment, resolveAdapterCommand } from "./adapters.js";
import { stopProcessGroup } from "./group.js";
import { processExists, processGroupStatus, startedProcessBirthSignature } from "./identity.js";
import { waitForReadiness } from "./readiness.js";
import { ProcessError, type ManagedProcess, type ProcessRunResult, type RunProcessInput, type StartProcessInput } from "./types.js";

/** Let the wrapper run its command and wait until it detached from the channel. */
async function openLaunchGate(child: ChildProcess): Promise<void> {
  if (!child.connected) throw new ProcessError("DEVFN_PROCESS_START_FAILED", "Process wrapper exited before its launch gate opened.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ProcessError("DEVFN_PROCESS_START_FAILED", "Process wrapper did not acknowledge its launch gate.")), 10_000);
    child.once("disconnect", () => { clearTimeout(timer); resolve(); });
    child.send("start", (error) => {
      if (!error) return;
      clearTimeout(timer);
      reject(new ProcessError("DEVFN_PROCESS_START_FAILED", "Unable to open the process launch gate.", { cause: error.message }));
    });
  });
}

export async function prepareProcessLog(logPath: string, resetSensitiveHistory: boolean): Promise<{ logFd: number; logOffset: number }> {
  const existing = await lstat(logPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new ProcessError("DEVFN_PROCESS_START_FAILED", `Refusing symlinked process log ${logPath}.`);
  const logOffset = resetSensitiveHistory ? 0 : existing?.size ?? 0;
  const flags = constants.O_WRONLY | constants.O_CREAT | (resetSensitiveHistory ? constants.O_TRUNC : constants.O_APPEND) | (constants.O_NOFOLLOW ?? 0);
  let logFd: number | undefined;
  try {
    logFd = openSync(logPath, flags, 0o600);
    fchmodSync(logFd, 0o600);
    return { logFd, logOffset };
  } catch (error) {
    if (logFd !== undefined) closeSync(logFd);
    if (error instanceof ProcessError) throw error;
    throw new ProcessError("DEVFN_PROCESS_START_FAILED", `Unable to open process log ${logPath} safely.`, { cause: error instanceof Error ? error.message : String(error) });
  }
}

export class ProcessSupervisor {
  public async start(input: StartProcessInput): Promise<ManagedProcess> {
    const command = resolveAdapterCommand(input.spec);
    const { child, managed, logOffset, cwd, environment, exited } = await this.launch({ name: input.name, command, root: input.root, cwd: input.spec.cwd,
      runtimeDir: input.runtimeDir, environment: createProcessEnvironment(input.spec, input.environment), redactKeys: input.spec.secretEnv ?? [],
      ...(input.spec.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: input.spec.shutdownTimeoutMs }) });
    try {
      try {
        await input.onStarted?.(managed);
        await openLaunchGate(child);
      } finally {
        if (child.connected) child.disconnect();
      }
      await waitForReadiness({ health: input.spec.health, ports: input.ports ?? {}, logPath: managed.logPath, logOffset, cwd, environment, isAlive: () => !exited() && processExists(managed.pid) });
      managed.readyAt = new Date().toISOString();
      return managed;
    } catch (error) {
      await stopProcessGroup(managed, managed.name, input.spec.shutdownTimeoutMs ?? 10_000, { ownGroup: { leaderUnreaped: () => !exited() } }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Run a finite command to completion through the same gated wrapper: it
   * starts only after onStarted recorded its identity (a failed recording
   * means it never ran), and a timeout or abort stops its whole process
   * group. Whatever it left in its group is stopped once it exits. Only exit
   * code 0 succeeds; nothing the command changed is undone.
   */
  public async run(input: RunProcessInput): Promise<ProcessRunResult> {
    const { child, managed, exited } = await this.launch(input);
    let settle!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { settle = resolve; });
    if (exited()) settle({ code: child.exitCode, signal: child.signalCode });
    else child.once("exit", (code, signal) => settle({ code, signal }));
    const stop = async () => await stopProcessGroup(managed, managed.name, input.shutdownTimeoutMs ?? 10_000, { ownGroup: { leaderUnreaped: () => !exited() } });
    child.ref();
    try {
      await input.onStarted?.(managed);
      if (input.signal?.aborted) throw new ProcessError("DEVFN_PROCESS_START_FAILED", `Task ${input.name} was cancelled before it started.`);
    } catch (error) {
      // Closing the channel before the gate opens makes the wrapper exit without running the command.
      if (child.connected) child.disconnect();
      await exit;
      throw error;
    }
    try { await openLaunchGate(child); }
    catch (error) {
      // The wrapper may have received the gate and started the command, so it ends as a failed run.
      if (child.connected) child.disconnect();
      let stopError: string | undefined;
      try { await stop(); } catch (failure) { stopError = failure instanceof Error ? failure.message : String(failure); }
      return { outcome: "failed", exitCode: null, signal: null, process: managed, error: error instanceof Error ? error.message : String(error), ...(stopError ? { stopError } : {}) };
    }
    if (child.connected) child.disconnect();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const limited = new Promise<"timed-out" | "cancelled">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), input.timeoutMs);
      onAbort = () => resolve("cancelled");
      if (input.signal?.aborted) onAbort();
      else input.signal?.addEventListener("abort", onAbort, { once: true });
    });
    const outcome = await Promise.race([exit, limited]);
    clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    // A stop failure never hides the command's own outcome; the caller reports both.
    let stopError: string | undefined;
    try { await stop(); } catch (error) { stopError = error instanceof Error ? error.message : String(error); }
    const status = typeof outcome === "string" ? { code: null, signal: null } : outcome;
    return {
      outcome: typeof outcome === "string" ? outcome : outcome.code === 0 ? "succeeded" : "failed",
      exitCode: status.code, signal: status.signal, process: managed, ...(stopError ? { stopError } : {}),
    };
  }

  /** Spawn the gated wrapper for a command, its identity read and its output going to a private log. */
  private async launch(input: { name: string; command: string[]; root: string; cwd?: string; runtimeDir: string; environment: NodeJS.ProcessEnv; redactKeys?: readonly string[]; shutdownTimeoutMs?: number }) {
    const { command } = input;
    if (command.length === 0) throw new ProcessError("DEVFN_PROCESS_START_FAILED", `Process ${input.name} has no command.`);
    const cwd = await resolveContainedPath(input.root, input.cwd ?? ".", `processes.${input.name}.cwd`).catch((error) => {
      throw new ProcessError("DEVFN_PROCESS_START_FAILED", `Process cwd escapes repository: ${input.cwd ?? "."}`, { cause: error instanceof Error ? error.message : String(error) });
    });
    const logsDir = path.join(input.runtimeDir, "logs");
    await mkdir(logsDir, { recursive: true, mode: 0o700 });
    if (!/^[A-Za-z0-9_.-]+$/.test(input.name) || input.name !== input.name.trim()) throw new ProcessError("DEVFN_PROCESS_START_FAILED", `Invalid process name ${input.name}.`);
    const logPath = path.join(logsDir, `${input.name}.log`);
    mkdirSync(path.dirname(logPath), { recursive: true });
    const environment = input.environment;
    const { logFd, logOffset } = await prepareProcessLog(logPath, Boolean(input.redactKeys?.length));
    const wrapperPath = fileURLToPath(new URL("./wrapper.js", import.meta.url));
    const child = spawn(process.execPath, [wrapperPath], {
      cwd,
      env: { ...environment, DEVFN_WRAPPED_COMMAND: JSON.stringify(command), DEVFN_REDACT_KEYS: JSON.stringify(input.redactKeys ?? []) },
      detached: process.platform !== "win32",
      windowsHide: true,
      // The IPC channel gates the command until its identity is recorded.
      stdio: ["ignore", logFd, logFd, "ipc"],
    });
    let exited = false;
    child.once("exit", () => { exited = true; });
    closeSync(logFd);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 50);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("spawn", () => { clearTimeout(timer); resolve(); });
    }).catch((error) => { throw new ProcessError("DEVFN_PROCESS_START_FAILED", `Unable to start ${input.name}.`, { cause: error instanceof Error ? error.message : String(error) }); });
    if (!child.pid) throw new ProcessError("DEVFN_PROCESS_START_FAILED", `Process ${input.name} did not receive a PID.`);
    child.unref();
    const birthSignature = await startedProcessBirthSignature(child.pid);
    if (!birthSignature) {
      if (child.connected) child.disconnect();
      try { if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM"); else child.kill(); } catch { /* process may already have exited */ }
      throw new ProcessError("DEVFN_PROCESS_START_FAILED", `Could not establish a birth identity for ${input.name}; refusing unmanaged supervision.`);
    }
    const managed: ManagedProcess = {
      name: input.name,
      pid: child.pid,
      birthSignature,
      command,
      cwd,
      logPath,
      startedAt: new Date().toISOString(),
      ...(input.shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs: input.shutdownTimeoutMs }),
    };
    return { child, managed, logOffset, cwd, environment, exited: () => exited };
  }

  /**
   * Stop a process and everything its wrapper's group still runs. A reused
   * PID is reported as a mismatch; an unreadable identity, or a wrapper that
   * exited while its group lives on, is never signalled and never reported
   * gone.
   */
  public async stop(managed: ManagedProcess, timeoutMs = managed.shutdownTimeoutMs ?? 10_000): Promise<void> {
    if (await processGroupStatus(managed.pid, managed.birthSignature, managed.startedAt) === "identity-mismatch") {
      throw new ProcessError("DEVFN_PROCESS_OWNERSHIP_MISMATCH", `PID ${managed.pid} no longer matches the DevFn process identity.`, { name: managed.name, pid: managed.pid });
    }
    await stopProcessGroup(managed, managed.name, timeoutMs);
  }

  /**
   * "stopped" and "identity-mismatch" prove nothing the process ran remains;
   * "unverified" is a live PID whose identity cannot be read, or a wrapper
   * that exited while processes remain in its group, either of which may
   * still be it and must never be treated as stopped.
   */
  public async status(managed: ManagedProcess): Promise<"running" | "stopped" | "identity-mismatch" | "unverified"> {
    const status = await processGroupStatus(managed.pid, managed.birthSignature, managed.startedAt);
    return status === "exited" ? "stopped" : status;
  }
}
