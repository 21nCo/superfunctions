import { spawn } from "node:child_process";

import { isolatedGitEnvironment } from "../git-environment.js";

const DEFAULT_MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Git's diagnostics kept for an error message; the rest is drained and never limits or fails a command. */
const MAX_GIT_STDERR_CHARS = 4096;
/** How long a stopped Git may take to exit after its termination signal before it is killed. */
const GIT_STOP_GRACE_MS = 5_000;
/**
 * How long a stopped Git's output may stay open after Git itself has exited: a process Git started, such as a lazy
 * fetch helper, can hold the inherited pipes, and the caller must not wait for it.
 */
const GIT_STOP_DRAIN_MS = 1_000;

/** Git printed more than the run lets it buffer: a limit of the run, not something the slot did. */
export class GitOutputLimitError extends Error {}

export interface GitRunOptions {
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** The most standard output kept, 64 MiB by default; past it the command is stopped with `GitOutputLimitError`. */
  maxOutputBytes?: number;
  /** Receives standard output as it arrives instead of keeping it, so no output limit applies. */
  onOutput?: (chunk: Buffer) => void;
  /** Exit codes other than 0 that also succeed, such as 1 for a `git grep` without matches. */
  successExitCodes?: readonly number[];
}

/**
 * Run `executable` (an absolute, trusted Git) with the isolated Git environment and return its standard output. Only
 * standard output counts toward the limit; standard error, which a checkout's contents can make arbitrarily long, is
 * drained and only its start is kept for the error of a failed command. Rejects when Git fails or `signal` aborts.
 * Once Git has started, the promise settles only after its process has exited, also when `signal` aborts it, so a
 * caller that awaits it never outlives the Git it ran. A Git that does not exit within a few seconds of the abort is
 * killed. Once Git has exited after any stop (an abort, also one that arrives after Git exited, or the output limit),
 * the promise rejects when Git's output closes or a second later, whichever is first, so a process Git started that
 * keeps the output open does not hold the caller.
 */
export function runGit(executable: string, args: string[], options: GitRunOptions): Promise<string> {
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_GIT_OUTPUT_BYTES;
  const command = args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c") ?? "";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: { ...isolatedGitEnvironment(), ...options.env }, signal: options.signal, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let failure: { error: unknown } | undefined;
    let grace: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    let settled = false;
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    // Spawn's own abort listener is removed when Git exits, so a later abort is observed here.
    const onAbort = () => { if (exited() && options.signal) stop(abortError(options.signal)); };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      clearTimeout(drain);
      options.signal?.removeEventListener("abort", onAbort);
      finish();
    };
    // A stopped Git has exited: stop waiting for output that something else may still hold open.
    const drainAfterExit = () => {
      if (!failure || drain || settled) return;
      const { error } = failure;
      drain = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle(() => reject(error));
      }, GIT_STOP_DRAIN_MS);
    };
    // Stop Git with `error`: kill it if it does not exit within the grace period, then bound the wait for its output.
    const stop = (error: unknown) => {
      failure ??= { error };
      if (exited()) return drainAfterExit();
      if (grace) return;
      grace = setTimeout(() => { if (!exited()) child.kill("SIGKILL"); }, GIT_STOP_GRACE_MS);
      grace.unref();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onOutput) return options.onOutput(chunk);
      if (failure) return;
      bytes += chunk.length;
      if (bytes <= limit) {
        chunks.push(chunk);
        return;
      }
      chunks.length = 0;
      child.kill("SIGKILL");
      stop(new GitOutputLimitError(`git ${command} printed more than the run's ${limit}-byte limit for Git output.`));
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAX_GIT_STDERR_CHARS) stderr += chunk.toString("utf8").slice(0, MAX_GIT_STDERR_CHARS - stderr.length); });
    child.once("error", error => {
      // Without a process ID Git never started, so no close follows; otherwise wait for it to exit and close.
      if (child.pid === undefined) return settle(() => reject(error));
      stop(error);
    });
    child.once("exit", drainAfterExit);
    child.once("close", code => settle(() => {
      if (failure) reject(failure.error);
      else if (code === 0 || (code !== null && options.successExitCodes?.includes(code))) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`git ${command} exited with ${String(code)}: ${stderr.trim()}`));
    }));
  });
}

/** The error Node gives a child process its signal aborted, for an abort that arrives after Git has exited. */
function abortError(signal: AbortSignal): Error {
  return Object.assign(new Error("The operation was aborted", { cause: signal.reason }), { name: "AbortError", code: "ABORT_ERR" });
}
