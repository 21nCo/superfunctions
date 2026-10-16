import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import type { RunOptions } from "../types.js";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}
export function frameworkCli(name: string, binName = name): string {
  const require = createRequire(join(process.cwd(), "package.json"));
  const manifestPath = require.resolve(`${name}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const bin =
    typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[binName];
  if (typeof bin !== "string")
    throw new Error(`No CLI found for installed ${name}`);
  return join(dirname(manifestPath), bin);
}

/** Invoke installed framework code without a shell or downloads; terminate its process group on cancellation. */
export function executeNode(
  args: string[],
  options: RunOptions,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Test run aborted"));
      return;
    }
    const child = spawn(process.execPath, args, {
      shell: false,
      env: { ...process.env, ...options.env },
      detached: process.platform !== "win32",
    });
    let stdout = "",
      stderr = "",
      timedOut = false,
      aborted = false,
      overflow = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* Process already exited. */
      }
    };
    const stop = () => {
      kill("SIGTERM");
      killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeout ?? 30000);
    const append = (kind: "stdout" | "stderr", data: string) => {
      if (overflow) return;
      if (stdout.length + stderr.length + data.length > 16 * 1024 * 1024) {
        overflow = true;
        stderr += "\nFramework output exceeded 16 MiB";
        stop();
        return;
      }
      if (kind === "stdout") stdout += data;
      else stderr += data;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => append("stdout", data));
    child.stderr.on("data", (data) => append("stderr", data));
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      if (timedOut || aborted || overflow) kill("SIGKILL");
      cleanup();
      resolve({ code: overflow ? 1 : code, stdout, stderr, timedOut, aborted });
    });
  });
}
