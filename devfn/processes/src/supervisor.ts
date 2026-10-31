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

// A process a finite command left behind can hold its output open after the
// command exits; the wrapper stops waiting for that output after this long,
// so the run ends with the command and the leftover is stopped with its group.
const RUN_DRAIN_MS = 1_000;
const MAX_TIMER_MS = 2_147_483_647;

type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };
type RunLimit = "timed-out" | "cancelled";
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The first of a run's timeout and its abort signal, once either is reached. */
function runLimit(timeoutMs: number, signal?: AbortSignal) {
  let current: RunLimit | undefined;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const reached = new Promise<RunLimit>((resolve) => {
    const reach = (limit: RunLimit) => { current ??= limit; resolve(current); };
    timer = setTimeout(() => reach("timed-out"), timeoutMs);
    onAbort = () => reach("cancelled");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  return { reached, current: () => current, dispose: () => { clearTimeout(timer); if (onAbort) signal?.removeEventListener("abort", onAbort); } };
}

/** Why a run must never start its command once a limit was reached. */
function notStarted(input: RunProcessInput, reached: RunLimit | undefined): { reason: unknown } | undefined {
  if (reached === undefined) return undefined;
  const why = reached === "timed-out" ? `timed out after ${input.timeoutMs} ms` : "was cancelled";
  return { reason: new ProcessError("DEVFN_PROCESS_START_FAILED", `Task ${input.name} ${why} before it started.`) };
}

function runResult(managed: ManagedProcess, ended: ExitStatus | RunLimit, stopError: string | undefined, error: string | undefined): ProcessRunResult {
  let outcome: ProcessRunResult["outcome"];
  if (typeof ended === "string") outcome = ended;
  else outcome = ended.code === 0 ? "succeeded" : "failed";
  const status = typeof ended === "string" ? { code: null, signal: null } : ended;
  return { outcome, exitCode: status.code, signal: status.signal, process: managed, ...(error ? { error } : {}), ...(stopError ? { stopError } : {}) };
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
   * code 0 succeeds; nothing the command changed is undone. Both limits bound
   * the recording too: a run that throws never ran its command.
   */
  public async run(input: RunProcessInput): Promise<ProcessRunResult> {
    // A timer clamps anything else to 1 ms, which would end every run at once.
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMER_MS) {
      throw new ProcessError("DEVFN_PROCESS_START_FAILED", `Task ${input.name} has an invalid timeout of ${input.timeoutMs} ms.`);
    }
    const { child, managed, exited } = await this.launch({ ...input,
      wrapperEnvironment: { DEVFN_WRAPPER_DRAIN_MS: String(RUN_DRAIN_MS), ...(input.discardOutput ? { DEVFN_DISCARD_OUTPUT: "1" } : {}) } });
    let settle!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { settle = resolve; });
    if (exited()) settle({ code: child.exitCode, signal: child.signalCode });
    else child.once("exit", (code, signal) => settle({ code, signal }));
    // Once stopped, or past stopping, the wrapper no longer holds the caller's event loop open.
    // A stop failure never hides the command's own outcome; the caller reports both.
    const stop = async (): Promise<string | undefined> => {
      try { await stopProcessGroup(managed, managed.name, input.shutdownTimeoutMs ?? 10_000, { ownGroup: { leaderUnreaped: () => !exited() } }); return undefined; }
      catch (error) { return errorMessage(error); }
      finally { child.unref(); }
    };
    child.ref();
    // The timeout and abort bound the whole run: the identity recording and the gate too.
    const limit = runLimit(input.timeoutMs, input.signal);
    try {
      // Decided in the turn that sends start, so a limit reached any time before the send keeps the gate closed.
      const unstarted = await this.recordIdentity(input, managed, limit) ?? notStarted(input, limit.current());
      if (unstarted) {
        // Closing the channel before the gate opens makes the wrapper exit without running the command.
        if (child.connected) child.disconnect();
        const stopError = await stop();
        throw stopError ? new ProcessError("DEVFN_PROCESS_START_FAILED", errorMessage(unstarted.reason), { stopError }) : unstarted.reason;
      }
      const gate = openLaunchGate(child);
      gate.catch(() => undefined);
      let ended: ExitStatus | RunLimit;
      let error: string | undefined;
      try { ended = await Promise.race([gate.then(() => exit), limit.reached]); }
      catch (error_) {
        // The wrapper may have received the gate and started the command, so it ends as a failed run.
        ended = { code: null, signal: null };
        error = errorMessage(error_);
      }
      if (child.connected) child.disconnect();
      return runResult(managed, ended, await stop(), error);
    } finally {
      limit.dispose();
    }
  }

  /**
   * Await onStarted until it settles or a run limit is reached. Returns why
   * the recording failed; the caller checks the limits as it opens the gate,
   * so a recording that settles after the run gave up never opens it.
   */
  private async recordIdentity(input: RunProcessInput, managed: ManagedProcess, limit: ReturnType<typeof runLimit>): Promise<{ reason: unknown } | undefined> {
    const recorded = Promise.resolve().then(async () => { await input.onStarted?.(managed); });
    recorded.catch(() => undefined);
    try { await Promise.race([recorded, limit.reached]); return undefined; }
    catch (error) { return { reason: error }; }
  }

  /** Spawn the gated wrapper for a command, its identity read and its output going to a private log. */
  private async launch(input: { name: string; command: string[]; root: string; cwd?: string; runtimeDir: string; environment: NodeJS.ProcessEnv; redactKeys?: readonly string[]; shutdownTimeoutMs?: number;
    discardOutput?: boolean; wrapperEnvironment?: Record<string, string> }) {
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
    // Only discardOutput may ask the wrapper to discard output, never the
    // given environment (in any key casing, as Windows reads it).
    const environment = { ...input.environment };
    for (const key of Object.keys(environment)) if (key.toUpperCase() === "DEVFN_DISCARD_OUTPUT") delete environment[key];
    const { logFd, logOffset } = await prepareProcessLog(logPath, Boolean(input.redactKeys?.length) || input.discardOutput === true);
    const wrapperPath = fileURLToPath(new URL("./wrapper.js", import.meta.url));
    const child = spawn(process.execPath, [wrapperPath], {
      cwd,
      env: { ...environment, DEVFN_WRAPPED_COMMAND: JSON.stringify(command), DEVFN_REDACT_KEYS: JSON.stringify(input.redactKeys ?? []), ...input.wrapperEnvironment },
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
