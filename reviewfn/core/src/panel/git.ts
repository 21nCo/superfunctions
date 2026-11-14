import { spawn } from "node:child_process";

import { isolatedGitEnvironment } from "../git-environment.js";

const DEFAULT_MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Git's diagnostics kept for an error message; the rest is drained and never limits or fails a command. */
const MAX_GIT_STDERR_CHARS = 4096;

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
}

/**
 * Run `executable` (an absolute, trusted Git) with the isolated Git environment and return its standard output. Only
 * standard output counts toward the limit; standard error, which a checkout's contents can make arbitrarily long, is
 * drained and only its start is kept for the error of a failed command. Rejects when Git fails or `signal` aborts.
 */
export function runGit(executable: string, args: string[], options: GitRunOptions): Promise<string> {
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_GIT_OUTPUT_BYTES;
  const command = args.find((arg, index) => !arg.startsWith("-") && args[index - 1] !== "-c") ?? "";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: { ...isolatedGitEnvironment(), ...options.env }, signal: options.signal, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (options.onOutput) return options.onOutput(chunk);
      if (overflow) return;
      bytes += chunk.length;
      if (bytes > limit) { overflow = true; chunks.length = 0; child.kill("SIGKILL"); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAX_GIT_STDERR_CHARS) stderr += chunk.toString("utf8").slice(0, MAX_GIT_STDERR_CHARS - stderr.length); });
    child.once("error", reject);
    child.once("close", code => {
      if (overflow) reject(new GitOutputLimitError(`git ${command} printed more than the run's ${limit}-byte limit for Git output.`));
      else if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`git ${command} exited with ${String(code)}: ${stderr.trim()}`));
    });
  });
}
