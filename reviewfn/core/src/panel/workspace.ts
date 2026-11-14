import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";

import { resolveTrustedExecutable } from "../executable.js";
import { GitOutputLimitError, runGit, type GitRunOptions } from "./git.js";

/** Unset every attribute that would make checkout or hashing transform file bytes. */
const LITERAL_ATTRIBUTES = "* -text -eol -working-tree-encoding -filter -ident -diff -merge\n";
/** Configuration for Git commands the run trusts: no hooks, filesystem monitors, external ignores or line-ending conversion. */
const TRUSTED_CONFIG = ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", `core.attributesFile=${devNull}`, "-c", `core.excludesFile=${devNull}`, "-c", "core.symlinks=true", "-c", "core.fileMode=true", "-c", "core.ignoreCase=false", "-c", "core.precomposeUnicode=false", "-c", "core.protectNTFS=true", "-c", "core.longpaths=true"];
const MAX_REPORTED_PATHS = 10;

/** Run a Git command the run trusts, with the trusted configuration, through the resolved absolute Git executable. */
function git(executable: string, args: string[], options: GitRunOptions): Promise<string> {
  return runGit(executable, [...TRUSTED_CONFIG, ...args], options);
}

export interface WorkspaceCheck {
  /** True only when the checkout's tree is exactly the head tree, with no extra directories. */
  unchanged: boolean;
  /**
   * True when the comparison was stopped, by its signal or by the run's Git output limit, before a difference was
   * observed, so the checkout was not shown to be unchanged either. Once the checkout's tree differs from head it is
   * reported changed, never incomplete.
   */
  incomplete?: boolean;
  /** Why the checkout is not shown to be unchanged: the observed difference, or why the comparison did not complete. */
  reason?: string;
}

/** One slot's owned checkout of the head commit. */
export interface SlotWorkspace {
  readonly path: string;
  /**
   * Compare the checkout with the head tree. A comparison stopped by `signal`, or by the run's Git output limit, before
   * a difference was observed reports `incomplete`; one that fails for any other reason reports the checkout as changed,
   * because the slot left it in a state that cannot be compared.
   */
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
  /**
   * Other commits a slot reads, such as the merge base, the base and the delta's `since`. Each checkout holds these and
   * the head commit, with their trees, in its own object store.
   */
  referenceCommits?: string[];
  /** A run-owned directory to create checkouts in. */
  parent: string;
  /**
   * The most standard output a Git command may return; 64 MiB by default. Git's diagnostics never count toward it. A
   * comparison that reaches it before a difference is observed is incomplete; one that already observed a difference
   * reports it without the changed names.
   */
  maxGitOutputBytes?: number;
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

interface WalkResult {
  /** Directories under the checkout other than the top-level `.git`, as `/`-separated relative paths. */
  directories: string[];
  /** Entries named `.git` in any letter case, other than the checkout's own top-level `.git`, which Git never hashes. */
  nestedGitEntries: string[];
  /** Submodule (gitlink) paths with any content: Git does not look inside them, so they must stay as checked out, empty. */
  nonEmptyGitlinks: string[];
  /** Entries that are not regular files, directories or symlinks (FIFOs, sockets, devices): Git does not hash them. */
  specialEntries: string[];
}

/** Walk `root` without following symlinks, checking `signal` before each directory read. */
async function walk(root: string, gitlinks: Set<string>, signal?: AbortSignal): Promise<WalkResult> {
  const result: WalkResult = { directories: [], nestedGitEntries: [], nonEmptyGitlinks: [], specialEntries: [] };
  const visit = async (relative: string): Promise<void> => {
    signal?.throwIfAborted();
    const entries = await readdir(path.join(root, relative), { withFileTypes: true });
    if (gitlinks.has(relative)) {
      if (entries.length) result.nonEmptyGitlinks.push(relative);
      return;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      // Only the checkout's own `.git` is skipped. Any other case variant, even at the top level of a case-sensitive
      // filesystem, is something the slot wrote and Git may not compare.
      if (entry.name.toLowerCase() === ".git") {
        if (relative || entry.name !== ".git") result.nestedGitEntries.push(child);
        continue;
      }
      if (!entry.isDirectory()) {
        if (!entry.isFile() && !entry.isSymbolicLink()) result.specialEntries.push(child);
        continue;
      }
      result.directories.push(child);
      await visit(child);
    }
  };
  await visit("");
  return result;
}

function listed(paths: string[]): string {
  return `${paths.slice(0, MAX_REPORTED_PATHS).join(", ")}${paths.length > MAX_REPORTED_PATHS ? ` and ${paths.length - MAX_REPORTED_PATHS} more` : ""}`;
}

class GitSlotWorkspace implements SlotWorkspace {
  private removed = false;

  public constructor(private readonly directory: string, public readonly path: string, private readonly verifyGitDir: string, private readonly expectedTree: string, private readonly headCommit: string, private readonly gitExecutable: string, private readonly maxOutputBytes?: number) {}

  public async verify(signal?: AbortSignal): Promise<WorkspaceCheck> {
    try {
      const info = await lstat(this.path).catch(() => undefined);
      if (!info?.isDirectory()) return { unchanged: false, reason: "The checkout is no longer a directory." };
      // An index outside the checkout, seeded from the head tree and hashed through the run-owned Git directory: the
      // slot's own .git (config, hooks, index, HEAD) is never consulted, so the slot cannot hide a change or run code
      // through it. Seeding keeps submodule (gitlink) entries, which `git add` never creates from a checkout.
      const index = path.join(this.directory, "verify.index");
      await rm(index, { force: true });
      const env = { GIT_INDEX_FILE: index };
      const run = (args: string[], overrides: Partial<GitRunOptions> = {}) => git(this.gitExecutable, args, { cwd: this.directory, signal, env, maxOutputBytes: this.maxOutputBytes, ...overrides });
      const gitDir = [`--git-dir=${this.verifyGitDir}`, `--work-tree=${this.path}`];
      await run([...gitDir, "read-tree", this.expectedTree]);
      await run([...gitDir, "add", "--all", "--force", "--", "."]);
      // Only standard output counts toward the run's Git output limit, so the slot cannot stop the comparison through the
      // diagnostics its checkout provokes (embedded repositories, long paths): those are drained.
      const tree = (await run([...gitDir, "write-tree"])).trim();
      if (tree !== this.expectedTree) {
        // Once the tree differs the checkout is changed, whatever the listing does: a failed listing only loses the names.
        const changed = await run([`--git-dir=${this.verifyGitDir}`, "diff-tree", "-r", "-z", "--no-renames", "--name-only", this.expectedTree, tree])
          .then(listing => listing.split("\0").filter(Boolean), () => []);
        return { unchanged: false, reason: `The checkout differs from head ${this.headCommit}: ${changed.length ? listed(changed) : "tree differs"}.` };
      }
      // Git trees cannot record empty directories, and Git skips nested .git entries, submodule contents and special
      // files (FIFOs, sockets, devices), so check those separately.
      // The listing is streamed: only directories and submodules are kept, so a clean checkout of any size verifies.
      const expected = new Set<string>();
      const gitlinks = new Set<string>();
      let pending: Buffer = Buffer.alloc(0);
      await run([`--git-dir=${this.verifyGitDir}`, "ls-tree", "-r", "-t", "-z", this.expectedTree], {
        onOutput: chunk => {
          const data = pending.length ? Buffer.concat([pending, chunk]) : chunk;
          let start = 0;
          for (let end = data.indexOf(0, start); end !== -1; end = data.indexOf(0, start)) {
            const entry = data.toString("utf8", start, end);
            const name = entry.slice(entry.indexOf("\t") + 1);
            if (entry.startsWith("040000 ")) expected.add(name);
            else if (entry.startsWith("160000 ")) { expected.add(name); gitlinks.add(name); }
            start = end + 1;
          }
          pending = data.subarray(start);
        },
      });
      const found = await walk(this.path, gitlinks, signal);
      if (found.nestedGitEntries.length) return { unchanged: false, reason: `The checkout has .git entries other than its own that Git does not compare: ${listed(found.nestedGitEntries)}.` };
      if (found.specialEntries.length) return { unchanged: false, reason: `The checkout has entries that are not files, directories or symlinks, which Git does not compare: ${listed(found.specialEntries)}.` };
      if (found.nonEmptyGitlinks.length) return { unchanged: false, reason: `The checkout has content in submodule paths: ${listed(found.nonEmptyGitlinks)}.` };
      const extra = found.directories.filter(directory => !expected.has(directory));
      if (extra.length) return { unchanged: false, reason: `The checkout has directories that head ${this.headCommit} does not: ${listed(extra)}.` };
      return { unchanged: true };
    } catch (error) {
      if (signal?.aborted) return { unchanged: false, incomplete: true, reason: `The comparison with head ${this.headCommit} was stopped before it finished.` };
      if (error instanceof GitOutputLimitError) return { unchanged: false, incomplete: true, reason: `The comparison with head ${this.headCommit} did not finish: ${error.message}` };
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
 * Owned checkouts created from the run's object store at the head commit. Each checkout is self-contained: its own
 * object store holds the head and reference commits with their trees (a depth-1 fetch by object ID), with no
 * alternates, remote or other path outside it, so a harness that sees only the checkout (for example, in a container)
 * can still read head, the merge base and the diff. It has no hooks or line-ending conversion, so its files are the
 * head blobs byte for byte.
 */
export class GitSlotWorkspaceProvider implements SlotWorkspaceProvider {
  /** Resolved once per provider: every Git process of its checkouts runs this absolute executable, never a PATH lookup. */
  private executable?: Promise<string>;

  public constructor(private readonly options: GitSlotWorkspaceOptions) {}

  public async create(slotId: string, signal?: AbortSignal): Promise<SlotWorkspace> {
    const executable = await (this.executable ??= resolveTrustedExecutable("git"));
    signal?.throwIfAborted();
    const run = (args: string[], options: GitRunOptions) => git(executable, args, options);
    const directory = await mkdtemp(path.join(this.options.parent, `${slotId}-`));
    try {
      const checkout = path.join(directory, "checkout");
      const verifyGitDir = path.join(directory, "verify.git");
      const store = path.resolve(this.options.objectStore);
      const objects = (await run(["rev-parse", "--path-format=absolute", "--git-path", "objects"], { cwd: store, signal })).trim();
      const objectFormat = (await run(["rev-parse", "--show-object-format"], { cwd: store, signal })).trim();
      const commits = [...new Set([this.options.headCommit, ...(this.options.referenceCommits ?? [])].filter(commit => /\S/.test(commit)))];
      await run(["init", "--quiet", "--template=", `--object-format=${objectFormat}`, checkout], { cwd: directory, signal });
      // Protocol v2 serves any object by ID, so commits that no ref reaches are fetched too; nothing is written to the store.
      await run(["-c", "protocol.version=2", "fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--depth=1", "--", store, ...commits], { cwd: checkout, signal });
      // info/attributes outranks every committed .gitattributes, so checkout writes the head blobs unchanged.
      await mkdir(path.join(checkout, ".git", "info"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(checkout, ".git", "info", "attributes"), LITERAL_ATTRIBUTES, { mode: 0o600 });
      await run(["checkout", "--quiet", "--detach", this.options.headCommit], { cwd: checkout, signal });
      // The run-owned comparison directory reads the store through alternates; the slot never sees it.
      await run(["init", "--quiet", "--bare", "--template=", `--object-format=${objectFormat}`, verifyGitDir], { cwd: directory, signal });
      await mkdir(path.join(verifyGitDir, "objects", "info"), { recursive: true, mode: 0o700 });
      await mkdir(path.join(verifyGitDir, "info"), { recursive: true, mode: 0o700 });
      await writeFile(path.join(verifyGitDir, "objects", "info", "alternates"), `${objects}\n`, { mode: 0o600 });
      await writeFile(path.join(verifyGitDir, "info", "attributes"), LITERAL_ATTRIBUTES, { mode: 0o600 });
      const expectedTree = (await run([`--git-dir=${verifyGitDir}`, "rev-parse", "--verify", "--end-of-options", `${this.options.headCommit}^{tree}`], { cwd: directory, signal })).trim();
      return new GitSlotWorkspace(directory, checkout, verifyGitDir, expectedTree, this.options.headCommit, executable, this.options.maxGitOutputBytes);
    } catch (error) {
      await removeTree(directory).catch(() => undefined);
      throw error;
    }
  }
}
