import type { ProcessSpec } from "@devfn/config";

export interface ManagedProcess {
  name: string;
  pid: number;
  birthSignature?: string;
  command: string[];
  cwd: string;
  logPath: string;
  startedAt: string;
  readyAt?: string;
  shutdownTimeoutMs?: number;
}

/** A recorded process identity; the birth signature tells a reused PID apart. */
export interface ProcessOwnerIdentity {
  pid: number;
  birthSignature?: string;
  /** When DevFn recorded this identity, after reading it from the live process. */
  startedAt?: string;
}

export interface StartProcessInput {
  name: string;
  spec: ProcessSpec;
  root: string;
  runtimeDir: string;
  environment?: Record<string, string>;
  ports?: Record<string, number>;
  onStarted?: (process: ManagedProcess) => Promise<void>;
}

export interface RunProcessInput {
  name: string;
  /** The complete command and environment; nothing is added to them. */
  command: string[];
  environment: NodeJS.ProcessEnv;
  root: string;
  /** Repository-relative working directory. */
  cwd?: string;
  runtimeDir: string;
  /** Environment keys whose values are redacted from the log. */
  redactKeys?: readonly string[];
  /** Keep none of the command's output, for output that may carry values redaction cannot know. */
  discardOutput?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  shutdownTimeoutMs?: number;
  /** Record the identity; the command runs only after this resolves. */
  onStarted?: (process: ManagedProcess) => Promise<void>;
}

export interface ProcessRunResult {
  outcome: "succeeded" | "failed" | "timed-out" | "cancelled";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  process: ManagedProcess;
  /** Why a run that may have started has no exit status. */
  error?: string;
  /** Something the command left behind could not be stopped. */
  stopError?: string;
}

export class ProcessError extends Error {
  public constructor(
    public readonly code: "DEVFN_PROCESS_START_FAILED" | "DEVFN_PROCESS_NOT_READY" | "DEVFN_PROCESS_OWNERSHIP_MISMATCH" | "DEVFN_PROCESS_IDENTITY_UNVERIFIED" | "DEVFN_PROCESS_STOP_FAILED",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProcessError";
  }
}
