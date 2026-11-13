import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

import { changeHunksDiffArguments, isolatedGitEnvironment, isCommitId, parseChangeHunks, resolveTrustedExecutable, compareCodePoints, sha256, type ChangeHunksCapture, type ChangeSnapshot, type CodeAnchor, type SourceControlAdapter } from "@superfunctions/reviewfn-core";

const execFileAsync = promisify(execFile);
export type GitRunner = (args: string[], cwd: string) => Promise<string>;
const defaultRunner: GitRunner = async (args, cwd) => {
  const [command, ...parameters] = args;
  const options = { cwd, env: isolatedGitEnvironment(), maxBuffer: 50 * 1024 * 1024 };
  // Keep each permitted subcommand literal at the process boundary. Repository input cannot select git transport commands.
  switch (command) {
    case "rev-parse": return (await execFileAsync("git", ["rev-parse", ...parameters], options)).stdout;
    case "config": return (await execFileAsync("git", ["config", ...parameters], options)).stdout;
    case "status": return (await execFileAsync("git", ["status", ...parameters], options)).stdout;
    case "merge-base": return (await execFileAsync("git", ["merge-base", ...parameters], options)).stdout;
    case "diff": return (await execFileAsync("git", ["diff", "--no-ext-diff", "--no-textconv", ...parameters], options)).stdout;
    case "cat-file": return (await execFileAsync("git", ["cat-file", ...parameters], options)).stdout;
    case "show": return (await execFileAsync("git", ["show", ...parameters], options)).stdout;
    default: throw new Error("Unsupported read-only Git operation.");
  }
};

export interface GitSourceOptions {
  runner?: GitRunner;
  currentPullRequestHead?: (pullRequest: number) => Promise<string>;
  host?: string;
  targetBranch?: string;
}

export class GitSourceControlAdapter implements SourceControlAdapter {
  public readonly id = "git";
  private readonly runner: GitRunner;
  public constructor(private readonly options: GitSourceOptions = {}) { this.runner = options.runner ?? defaultRunner; }

  public async capture(root: string, base: string, head: string, pullRequest?: number): Promise<ChangeSnapshot> {
    const [baseCommit, headCommit, rawRepositoryId, checkoutHead] = await Promise.all([
      this.runner(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], root),
      this.runner(["rev-parse", "--verify", "--end-of-options", `${head}^{commit}`], root),
      this.runner(["config", "--get", "remote.origin.url"], root).catch(error => { if (error?.code === 1) return "local"; throw error; }),
      this.runner(["rev-parse", "HEAD"], root),
    ]).then(values => values.map(value => value.trim()));
    const repositoryId = redactRepositoryRemote(rawRepositoryId);
    if ((await this.runner(["status", "--porcelain", "--untracked-files=all"], root)).trim()) throw new Error("Review requires a clean immutable checkout, including untracked files.");
    if (checkoutHead !== headCommit) throw new Error(`Review workspace is at ${checkoutHead}, but requested head is ${headCommit}. Check out the exact head in an isolated workspace.`);
    const mergeBaseCommit = (await this.runner(["merge-base", baseCommit, headCommit], root)).trim();
    const [diffDigest, names, targetBranch] = await Promise.all([
      this.options.runner ? this.runner(["diff", "--binary", "--full-index", mergeBaseCommit, headCommit], root).then(sha256) : streamDiffDigest(root, mergeBaseCommit, headCommit),
      this.runner(["diff", "--name-only", "-z", mergeBaseCommit, headCommit], root),
      this.runner(["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", base], root),
    ]);
    return {
      repositoryId,
      host: this.options.host ?? hostFromRemote(repositoryId),
      pullRequest,
      targetBranch: this.options.targetBranch ?? (targetBranch.trim().startsWith("refs/") ? targetBranch.trim().replace(/^refs\/(heads|remotes)\//, "") : "unknown"),
      baseCommit,
      headCommit,
      mergeBaseCommit,
      diffDigest,
      changedPaths: names.split("\0").filter(Boolean).sort(compareCodePoints),
      capturedAt: new Date().toISOString(),
    };
  }

  public async currentHead(root: string, pullRequest?: number): Promise<string> {
    if (pullRequest !== undefined && this.options.currentPullRequestHead) return this.options.currentPullRequestHead(pullRequest);
    return (await this.runner(["rev-parse", "HEAD"], root)).trim();
  }

  public async pathExists(root: string, commit: string, file: string): Promise<boolean> {
    if (!/^[a-f0-9]{40,64}$/.test(commit) || !file || file.startsWith("/") || file.split(/[\\/]/).includes("..")) return false;
    try { await this.runner(["cat-file", "-e", `${commit}:${file}`], root); return true; }
    catch (error) { if ([1, 128].includes((error as { code?: number }).code ?? 0)) return false; throw error; }
  }

  /** Hunk-level model of `from..to` in the owned checkout; output over `maxBytes` is not parsed. */
  public async changeHunks(root: string, from: string, to: string, maxBytes: number, signal?: AbortSignal): Promise<ChangeHunksCapture> {
    if (!isCommitId(from) || !isCommitId(to)) throw new Error("Change hunks require full commit IDs.");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Change hunks require a positive byte limit.");
    let diff: string | undefined;
    if (this.options.runner) {
      const output = await this.runner(["diff", ...changeHunksDiffArguments(from, to)], root);
      diff = Buffer.byteLength(output) > maxBytes ? undefined : output;
    } else diff = await boundedDiff(root, changeHunksDiffArguments(from, to), maxBytes, signal);
    return diff === undefined ? { status: "too_large", limitBytes: maxBytes } : { status: "parsed", hunks: parseChangeHunks(diff, from, to) };
  }

  public async isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
    if (!isCommitId(ancestor) || !isCommitId(descendant)) return false;
    for (const commit of [ancestor, descendant]) {
      const type = await this.runner(["cat-file", "-t", commit], root).catch((error: { code?: number }) => { if (error?.code === 128) return ""; throw error; });
      if (type.trim() !== "commit") return false;
    }
    try { await this.runner(["merge-base", "--is-ancestor", ancestor, descendant], root); return true; }
    catch (error) { if ((error as { code?: number }).code === 1) return false; throw error; }
  }

  public async verifyAnchor(root: string, anchor: CodeAnchor): Promise<boolean> {
    if (!/^[a-f0-9]{40,64}$/.test(anchor.commit)) return false;
    if (!anchor.startLine && !anchor.symbol) return false;
    if (!anchor.path || anchor.path.startsWith("/") || anchor.path.split(/[\\/]/).includes("..")) return false;
    const objectType = await this.runner(["cat-file", "-t", `${anchor.commit}:${anchor.path}`], root).catch(() => undefined);
    if (objectType?.trim() !== "blob") return false;
    const content = await this.runner(["show", `${anchor.commit}:${anchor.path}`], root).catch(() => undefined);
    if (content === undefined) return false;
    if (anchor.symbol && !content.includes(anchor.symbol)) return false;
    const lines = content.split(/\r?\n/);
    if (anchor.startLine !== undefined && (anchor.startLine < 1 || anchor.startLine > lines.length)) return false;
    if (anchor.endLine !== undefined && (anchor.endLine < (anchor.startLine ?? 1) || anchor.endLine > lines.length)) return false;
    return true;
  }
}

function hostFromRemote(remote: string): string {
  if (/^[A-Za-z]:/.test(remote)) return "local";
  try { const url = new URL(remote); if (["http:", "https:", "ssh:"].includes(url.protocol)) return url.hostname; } catch { /* SCP and local paths are not URLs. */ }
  return !remote.includes("://") ? remote.match(/^(?:[^@/]+@)?([^/@:]+):/)?.[1] ?? "local" : "local";
}

export function redactRepositoryRemote(remote: string): string {
  if (/^[A-Za-z]:/.test(remote)) return remote;
  try { const url = new URL(remote); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); } catch { return remote.replace(/^[^@/]+@(?=[^/:]+:)/, ""); }
}

/** Normalize a recorded Git remote for comparison with a trusted GitHub repository. */
export function githubRepositoryIdentity(remote: string, expectedHost = "github.com"): string | undefined {
  const scp = /^(?:[^@/]+@)?([^/:]+):([^?#]+)$/.exec(remote);
  let repository = scp?.[1].toLowerCase() === expectedHost.toLowerCase() ? scp[2] : undefined;
  if (!repository) {
    try { const url = new URL(remote); if (url.hostname.toLowerCase() !== expectedHost.toLowerCase() || !["https:", "ssh:"].includes(url.protocol) || url.port && !(url.protocol === "ssh:" && url.port === "22") || url.search || url.hash) return undefined; repository = url.pathname.slice(1); } catch { return undefined; }
  }
  repository = repository.replace(/\/$/, "").replace(/\.git$/, "");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ? repository.toLowerCase() : undefined;
}


async function streamDiffDigest(root: string, base: string, head: string): Promise<string> {
  const executable = await resolveTrustedExecutable("git");
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const child = spawn(executable, ["diff", "--no-ext-diff", "--no-textconv", "--binary", "--full-index", base, head], { cwd: root, env: isolatedGitEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 120_000);
    child.stdout.on("data", (chunk: Buffer) => hash.update(chunk));
    child.stderr.resume();
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code === 0 && !timedOut) resolve(hash.digest("hex"));
      else reject(new Error(timedOut ? "Git diff hashing timed out." : `Git diff hashing failed (${String(code)}).`));
    });
  });
}

/** Run `git diff` and return its output, or undefined once it exceeds `maxBytes` (the process is stopped). */
async function boundedDiff(root: string, args: string[], maxBytes: number, signal?: AbortSignal): Promise<string | undefined> {
  const executable = await resolveTrustedExecutable("git");
  if (signal?.aborted) throw new Error("Change hunk capture canceled.");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["diff", ...args], { cwd: root, env: isolatedGitEnvironment(), stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stopped: "too_large" | "timeout" | "canceled" | undefined;
    let stderr = "";
    const stop = (reason: NonNullable<typeof stopped>) => { stopped ??= reason; child.kill("SIGKILL"); };
    const timeout = setTimeout(() => stop("timeout"), 120_000);
    const abort = () => stop("canceled");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      bytes += chunk.length;
      if (bytes > maxBytes) { chunks.length = 0; stop("too_large"); return; }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
    const settle = () => { clearTimeout(timeout); signal?.removeEventListener("abort", abort); };
    child.once("error", error => { settle(); reject(error); });
    child.once("close", code => {
      settle();
      if (stopped === "too_large") resolve(undefined);
      else if (stopped) reject(new Error(stopped === "timeout" ? "Git diff for change hunks timed out." : "Change hunk capture canceled."));
      else if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`Git diff for change hunks failed (${String(code)}): ${stderr.trim().slice(0, 500)}`));
    });
  });
}
