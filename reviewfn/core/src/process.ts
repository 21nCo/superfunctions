import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/** The outcome of one bounded child process run. */
export interface CommandResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean; canceled: boolean; /** Raw bytes kept from each stream, before decoding. */ stdoutBytes?: number; stderrBytes?: number }

export interface CommandRunnerOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The process group is terminated once this elapses; the result reports `timedOut`. */
  timeoutMs: number;
  /** Combined stdout and stderr bytes; exceeding it terminates the process group as a timeout. */
  maxOutputBytes: number;
  /** Aborting terminates the process group; the result reports `canceled`. */
  signal?: AbortSignal;
  stdin?: string;
  /** Called with the byte length of each stdout or stderr chunk the runner keeps, so a caller can enforce a live budget. */
  onOutput?: (bytes: number) => void;
}

/** Runs one command to completion. Harness adapters accept an injected runner so tests never spawn a real harness. */
export type CommandRunner = (command: string, args: string[], options: CommandRunnerOptions) => Promise<CommandResult>;

/**
 * The shared process-group runner used by harness adapters. On POSIX the child leads its own process group, so a
 * timeout, an output overrun or cancellation sends SIGTERM to the whole group and SIGKILL one second later; the group is
 * also killed once the child exits, so no descendant outlives the run. A spawn error rejects.
 */
export const runProcessGroup: CommandRunner = async (command, args, options) => new Promise((resolve, reject) => {
  if (options.signal?.aborted) { resolve({ code: null, signal: null, stdout: "", stderr: "", timedOut: false, canceled: true }); return; }
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => { /* child may reject before consuming input */ });
  child.stdin.end(options.stdin ?? "");
  // One decoder per stream keeps a multi-byte UTF-8 character that is split across pipe chunks intact.
  const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  let stdout = "";
  let stderr = "";
  let total = 0;
  const kept = { stdout: 0, stderr: 0 };
  let timedOut = false;
  let canceled = false;
  const terminate = (reason: "timeout" | "cancel") => {
    timedOut ||= reason === "timeout";
    canceled ||= reason === "cancel";
    try { process.platform === "win32" ? child.kill("SIGTERM") : process.kill(-child.pid!, "SIGTERM"); } catch { /* already exited */ }
    setTimeout(() => { try { process.platform === "win32" ? child.kill("SIGKILL") : process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ } }, 1_000).unref();
  };
  const timer = setTimeout(() => terminate("timeout"), options.timeoutMs);
  const onAbort = () => terminate("cancel");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const append = (target: "stdout" | "stderr", chunk: Buffer) => {
    total += chunk.length;
    if (total > options.maxOutputBytes) { terminate("timeout"); return; }
    kept[target] += chunk.length; options.onOutput?.(chunk.length);
    if (target === "stdout") stdout += decoders.stdout.write(chunk); else stderr += decoders.stderr.write(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
  const cleanup = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* process group gone */ }
  };
  if (options.signal?.aborted) onAbort();
  child.once("error", error => { cleanup(); reject(error); });
  child.once("exit", cleanup);
  child.once("close", (code, signal) => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    stdout += decoders.stdout.end();
    stderr += decoders.stderr.end();
    resolve({ code, signal, stdout, stderr, timedOut, canceled, stdoutBytes: kept.stdout, stderrBytes: kept.stderr });
  });
});
