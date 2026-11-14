import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { isolatedGitEnvironment } from "../git-environment.js";

const execFileAsync = promisify(execFile);

/** Unset every attribute that would make checkout or hashing transform file bytes. */
const LITERAL_ATTRIBUTES = "* -text -eol -working-tree-encoding -filter -ident -diff -merge\n";
/** Configuration for Git commands the run trusts: no hooks, filesystem monitors, external ignores or line-ending conversion. */
const TRUSTED_CONFIG = ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", `core.attributesFile=${devNull}`, "-c", `core.excludesFile=${devNull}`, "-c", "core.symlinks=true", "-c", "core.fileMode=true", "-c", "core.ignoreCase=false", "-c", "core.precomposeUnicode=false", "-c", "core.protectNTFS=true", "-c", "core.longpaths=true"];
const MAX_REPORTED_PATHS = 10;

export interface WorkspaceCheck {
  /** True only when the checkout's tree is exactly the head tree, with no extra directories. */
  unchanged: boolean;
  /** Why the checkout is considered mutated, including a check that could not complete. */
  reason?: string;
}

/** One slot's owned checkout of the head commit. */
export interface SlotWorkspace {
  readonly path: string;
  /** Compare the checkout with the head tree. A check that cannot complete reports the checkout as mutated. */
  verify(signal?: AbortSignal): Promise<WorkspaceCheck>;
  /** Remove the checkout and everything the slot wrote into it. Safe to call more than once. */
  remove(): Promise<void>;
}

export interface SlotWorkspaceProvider {
  create(slotId: string, signal?: AbortSignal): Promise<SlotWorkspace>;
}

export interface GitSlotWorkspaceOptions {
  /** The run's repository, whose object store holds the head commit. It is read, never written. */
  objectStore: string;
  headCommit: string;
  /** A run-owned directory to create checkouts in. */
  parent: string;
}

async function git(args: string[], options: { cwd: string; signal?: AbortSignal; env?: NodeJS.ProcessEnv }): Promise<string> {
  const { stdout } = await execFileAsync("git", [...TRUSTED_CONFIG, ...args], { cwd: options.cwd, env: { ...isolatedGitEnvironment(), ...options.env }, maxBuffer: 64 * 1024 * 1024, signal: options.signal, encoding: "utf8" });
  return stdout;
}

/** Make every directory under `root` writable and searchable so a slot cannot block its own cleanup with permissions. */
async function restorePermissions(root: string): Promise<void> {
  const info = await lstat(root).catch(() => undefined);
  if (!info?.isDirectory()) return;
  await chmod(root, 0o700).catch(() => undefined);
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await restorePermissions(path.join(root, entry.name));
  }
}

/** Remove a directory tree, restoring permissions a slot may have removed; rejects only if the tree still exists. */
export async function removeTree(directory: string): Promise<void> {
  try { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
  catch {
    await restorePermissions(directory);
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
  if (await lstat(directory).catch(() => undefined)) throw new Error(`Checkout ${directory} could not be removed.`);
}

/** Directories under `root` other than the top-level `.git`, as `/`-separated relative paths; symlinks are not followed. */
async function directories(root: string, relative = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (!relative && entry.name === ".git") continue;
    if (!entry.isDirectory()) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    found.push(child, ...await directories(root, child));
  }
  return found;
}

class GitSlotWorkspace implements SlotWorkspace {
  private removed = false;

  public constructor(private readonly directory: string, public readonly path: string, private readonly verifyGitDir: string, private readonly expectedTree: string, private readonly headCommit: string) {}

  public async verify(signal?: AbortSignal): Promise<WorkspaceCheck> {
    try {
      const info = await lstat(this.path).catch(() => undefined);
      if (!info?.isDirectory()) return { unchanged: false, reason: "The checkout is no longer a directory." };
      // A fresh index outside the checkout, hashed through the run-owned Git directory: the slot's own .git (config,
      // hooks, index, HEAD) is never consulted, so the slot cannot hide a change or run code through it.
      const index = path.join(this.directory, "verify.index");
      await rm(index, { force: true });
      const env = { GIT_INDEX_FILE: index };
      const options = { cwd: this.directory, signal, env };
      const gitDir = [`--git-dir=${this.verifyGitDir}`, `--work-tree=${this.path}`];
      await git([...gitDir, "add", "--all", "--force", "--", "."], options);
      const tree = (await git([...gitDir, "write-tree"], options)).trim();
      if (tree !== this.expectedTree) {
        const changed = (await git([`--git-dir=${this.verifyGitDir}`, "diff-tree", "-r", "-z", "--no-renames", "--name-only", this.expectedTree, tree], options)).split("\0").filter(Boolean);
        const shown = changed.slice(0, MAX_REPORTED_PATHS).join(", ");
        return { unchanged: false, reason: `The checkout differs from head ${this.headCommit}: ${shown || "tree differs"}${changed.length > MAX_REPORTED_PATHS ? ` and ${changed.length - MAX_REPORTED_PATHS} more` : ""}.` };
      }
      // Git trees cannot record empty directories, so compare directories separately.
      const expected = new Set((await git([`--git-dir=${this.verifyGitDir}`, "ls-tree", "-r", "-d", "-z", "--name-only", this.expectedTree], options)).split("\0").filter(Boolean));
      const extra = (await directories(this.path)).filter(directory => !expected.has(directory));
      if (extra.length) return { unchanged: false, reason: `The checkout has directories that head ${this.headCommit} does not: ${extra.slice(0, MAX_REPORTED_PATHS).join(", ")}.` };
      return { unchanged: true };
    } catch (error) {
      return { unchanged: false, reason: `The checkout could not be compared with head ${this.headCommit}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  public async remove(): Promise<void> {
    if (this.removed) return;
    await removeTree(this.directory);
    this.removed = true;
  }
}

/**
 * Owned checkouts created from the run's object store at the head commit. Each checkout is a `--shared` clone with no
 * remote, hooks or line-ending conversion, so its files are the head blobs byte for byte.
 */
export class GitSlotWorkspaceProvider implements SlotWorkspaceProvider {
  public constructor(private readonly options: GitSlotWorkspaceOptions) {}

  public async create(slotId: string, signal?: AbortSignal): Promise<SlotWorkspace> {
    const directory = await mkdtemp(path.join(this.options.parent, `${slotId}-`));
    try {
      const checkout = path.join(directory, "checkout");
      const verifyGitDir = path.join(directory, "verify.git");
      const store = path.resolve(this.options.objectStore);
      const objects = (await git(["rev-parse", "--path-format=absolute", "--git-path", "objects"], { cwd: store, signal })).trim();
      await git(["clone", "--quiet", "--template=", "--shared", "--no-checkout", "--", store, checkout], { cwd: directory, signal });
      // info/attributes outranks every committed .gitattributes, so checkout writes the head blobs unchanged.
      await mkdir(path.join(checkout, ".git", "info"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(checkout, ".git", "info", "attributes"), LITERAL_ATTRIBUTES, { mode: 0o600 });
      await git(["checkout", "--quiet", "--detach", this.options.headCommit], { cwd: checkout, signal });
      await git(["remote", "remove", "origin"], { cwd: checkout, signal });
      await git(["init", "--quiet", "--bare", "--template=", verifyGitDir], { cwd: directory, signal });
      await mkdir(path.join(verifyGitDir, "objects", "info"), { recursive: true, mode: 0o700 });
      await mkdir(path.join(verifyGitDir, "info"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(verifyGitDir, "objects", "info", "alternates"), `${objects}\n`, { mode: 0o600 });
      await writeFile(path.join(verifyGitDir, "info", "attributes"), LITERAL_ATTRIBUTES, { mode: 0o600 });
      const expectedTree = (await git([`--git-dir=${verifyGitDir}`, "rev-parse", "--verify", "--end-of-options", `${this.options.headCommit}^{tree}`], { cwd: directory, signal })).trim();
      return new GitSlotWorkspace(directory, checkout, verifyGitDir, expectedTree, this.options.headCommit);
    } catch (error) {
      await removeTree(directory).catch(() => undefined);
      throw error;
    }
  }
}
