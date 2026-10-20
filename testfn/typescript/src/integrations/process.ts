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
    let termination: Promise<void> | undefined;
    let rejectTermination!: (error: unknown) => void;
    const terminationFailure = new Promise<never>((_, fail) => { rejectTermination = fail; });
    void terminationFailure.catch(() => {});
    const uncertain = () => new Error("Framework process group termination could not be confirmed");
    const alive = () => {
      if (!child.pid) return false;
      if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw uncertain();
      }
    };
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw uncertain();
      }
    };
    const pause = () => new Promise<void>(done => setTimeout(done, 20));
    const stop = () => {
      if (!termination) {
        termination = (async () => {
          kill("SIGTERM");
          const graceful = Date.now() + 1000;
          while (alive() && Date.now() < graceful) await pause();
          if (alive()) kill("SIGKILL");
          const deadline = Date.now() + 5000;
          while (alive() && Date.now() < deadline) await pause();
          if (alive()) throw uncertain();
        })();
        void termination.catch(rejectTermination);
      }
      return termination;
    };
    const onAbort = () => { aborted = true; void stop(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; void stop(); }, options.timeout ?? 30000);
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
      options.signal?.removeEventListener("abort", onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
    };
    // Wait for process exit independently of stdio: descendants can keep pipes open.
    let closed = false;
    const exited = new Promise<number | null>((done, fail) => {
      child.once("error", fail);
      child.once("exit", done);
      child.once("close", () => { closed = true; });
    });
    if (options.signal?.aborted) onAbort();
    const finish = async () => {
      const code = await Promise.race([exited, terminationFailure]);
      clearTimeout(timer); // Cleanup has its own deadline; it is not framework execution time.
      let orphaned = false;
      if (alive()) {
        orphaned = !timedOut && !aborted && !overflow;
        if (orphaned) stderr += "\nFramework exited with running descendants";
        await stop();
      }
      if (termination) await termination;
      if (alive()) throw uncertain();
      const deadline = Date.now() + 1000;
      while (!closed && Date.now() < deadline) await pause();
      if (!closed) throw uncertain();
      return { code: overflow || orphaned ? 1 : code, stdout, stderr, timedOut, aborted };
    };
    void finish().finally(cleanup).then(resolve, reject);
  });
}
