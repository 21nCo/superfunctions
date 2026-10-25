import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import {
  executeOwnedProcess,
  ProcessGroupUncertainError,
} from "../executor/owned-shell.js";
import { redactSecrets } from "../reporting/redact.js";
export interface HostFnDeployOptions {
  environment: string;
  ci?: boolean;
  local?: boolean;
  workspace: string;
  env?: Record<string, string>;
  /** Trusted host configuration, never derived from pipeline with/environment. */
  executable?: string;
  timeoutMs?: number;
  secretValues?: string[];
}
export interface HostFnDeployAsyncOptions extends HostFnDeployOptions {
  signal?: AbortSignal;
  onLines?: (lines: string[]) => void;
  /** Host-owned base environment; defaults to PATH/LANG/TMPDIR only. */
  baseEnv?: NodeJS.ProcessEnv;
}
export interface HostFnDeployResult {
  success: boolean;
  exitCode: number;
  lines: string[];
  error?: string;
  truncated?: boolean;
  streamed?: boolean;
}
function prepare(options: HostFnDeployOptions) {
  if (
    typeof options.environment !== "string" ||
    !options.environment ||
    /[\0\r\n]/.test(options.environment) ||
    Buffer.byteLength(options.environment) > 4096
  )
    throw Error("Invalid HostFn environment");
  if (
    (options.ci !== undefined && typeof options.ci !== "boolean") ||
    (options.local !== undefined && typeof options.local !== "boolean")
  )
    throw Error("Invalid HostFn flags");
  const timeout = options.timeoutMs ?? 600000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600000)
    throw Error("Invalid HostFn timeout");
  const flags = [
    ...(options.local ? ["--local"] : []),
    ...(options.ci !== false ? ["--ci"] : []),
  ];
  const secrets =
    options.secretValues ?? Object.values(options.env ?? {}).filter(Boolean);
  if (
    !Array.isArray(secrets) ||
    secrets.some((value) => typeof value !== "string")
  )
    throw Error("Invalid HostFn redaction policy");
  return {
    args: ["deploy", ...flags, "--", options.environment],
    timeout,
    secrets: [...secrets],
    description: `Deploying: hostfn deploy ${options.environment}${flags.length ? " " + flags.join(" ") : ""}`,
  };
}
function resolveExecutable(options: HostFnDeployOptions): string {
  let executable: string | undefined;
  const resolve = (path: string) => {
    const real = realpathSync(path);
    if (!statSync(real).isFile()) throw Error("Invalid HostFn executable");
    accessSync(real, constants.X_OK);
    return real;
  };
  if (options.executable !== undefined) {
    if (!isAbsolute(options.executable))
      throw Error("HostFn executable must be absolute");
    executable = resolve(options.executable);
  } else
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (!isAbsolute(directory)) continue;
      try {
        executable = resolve(join(directory, "hostfn"));
        break;
      } catch {}
    }
  if (!executable) throw Error("HostFn executable unavailable");
  return executable;
}
/** Compatibility-only synchronous argv execution; no asynchronous process-group cancellation guarantee. */
export function executeHostFnDeploy(
  options: HostFnDeployOptions,
): HostFnDeployResult {
  let lines: string[] = [];
  try {
    const prepared = prepare(options);
    lines = redactSecrets([prepared.description], prepared.secrets);
    try {
      const output = execFileSync(resolveExecutable(options), prepared.args, {
        cwd: options.workspace,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: prepared.timeout,
        killSignal: "SIGKILL",
        maxBuffer: 1048576,
        env: { ...process.env, ...options.env },
      });
      lines.push(
        ...redactSecrets(output.split("\n").filter(Boolean), prepared.secrets),
        "Deploy succeeded",
      );
      return { success: true, exitCode: 0, lines };
    } catch (error) {
      const failure = error as {
        code?: string;
        signal?: string;
        status?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      if (
        failure.code === "ETIMEDOUT" ||
        failure.code === "ENOBUFS" ||
        failure.signal
      )
        throw new ProcessGroupUncertainError();
      const code = Number.isInteger(failure.status) ? failure.status! : 1;
      for (const value of [failure.stdout, failure.stderr])
        if (value)
          lines.push(
            ...redactSecrets(
              String(value).split("\n").filter(Boolean),
              prepared.secrets,
            ),
          );
      lines.push(`Deploy failed with exit code ${code}`);
      return {
        success: false,
        exitCode: code,
        lines,
        error: `Deploy failed with exit code ${code}`,
      };
    }
  } catch (error) {
    if (error instanceof ProcessGroupUncertainError) throw error;
    const message = "HostFn execution could not be admitted";
    return {
      success: false,
      exitCode: 1,
      lines: [...lines, message],
      error: message,
    };
  }
}
/** Runner path: explicit argv plus existing owned POSIX process-group termination and bounded capture. */
export async function executeHostFnDeployAsync(
  options: HostFnDeployAsyncOptions,
): Promise<HostFnDeployResult> {
  let prepared: ReturnType<typeof prepare>;
  try {
    prepared = prepare(options);
  } catch {
    const error = "HostFn execution could not be admitted";
    return { success: false, exitCode: 1, lines: [error], error };
  }
  const lines: string[] = [],
    controller = new AbortController();
  let callbackFailed = false;
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const emit = (values: string[]) => {
    const safe = redactSecrets(values, prepared.secrets);
    lines.push(...safe);
    try {
      options.onLines?.(safe);
    } catch {
      callbackFailed = true;
      controller.abort();
    }
  };
  try {
    emit([prepared.description]);
    const result = await executeOwnedProcess(
      resolveExecutable(options),
      prepared.args,
      options.workspace,
      {
        ...(options.baseEnv ?? {
          PATH: process.env.PATH,
          LANG: process.env.LANG,
          TMPDIR: process.env.TMPDIR,
        }),
        ...options.env,
      },
      controller.signal,
      emit,
      prepared.timeout,
    );
    const success =
      result.exitCode === 0 && !controller.signal.aborted && !callbackFailed;
    const message = callbackFailed
      ? "HostFn log delivery failed"
      : success
        ? "Deploy succeeded"
        : `Deploy failed with exit code ${result.exitCode || 1}`;
    emit([message]);
    return {
      success: success && !callbackFailed,
      exitCode: success && !callbackFailed ? 0 : result.exitCode || 1,
      lines,
      error: callbackFailed
        ? "HostFn log delivery failed"
        : success
          ? undefined
          : message,
      truncated: result.truncated,
      streamed: !!options.onLines,
    };
  } catch (error) {
    if (error instanceof ProcessGroupUncertainError) throw error;
    const message = "HostFn execution could not be admitted";
    emit([message]);
    return {
      success: false,
      exitCode: 1,
      lines,
      error: message,
      streamed: !!options.onLines,
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
