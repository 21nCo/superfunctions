/**
 * The base contract of `apifn check --base <ref>`: the one blob a single pinned commit holds at
 * the spec's repository path, resolved inside that commit's tree.
 *
 * - git runs from one absolute executable (APIFN_GIT, or the first of a fixed list of system
 *   locations), never a `git` found through the inherited PATH;
 * - git resolves the ref once (`rev-parse --verify <ref>^{commit}`); every later call names that
 *   commit;
 * - the path is walked one component at a time, as the kernel resolves a path: a tracked symbolic
 *   link met on the way is followed inside the same tree (never through the working tree) from
 *   the directory that holds it, and `..` returns to the directory the walk actually resolved
 *   (never a lexical parent); a link leaving the tree, more than MAX_TREE_LINKS links or a
 *   submodule on the way is an error;
 * - only when the walk proves a component missing is the spec a new contract; when the
 *   repository ignores case (core.ignorecase, which must be readable), a missing component is
 *   matched under NFC and case folding first, and two matches are an error;
 * - the path tried first is the spec as given relative to the repository root, keeping the tracked
 *   spelling of an in-repository symlinked directory (even one back to the root); only when it is
 *   proven absent is the file a write to the spec lands on (an untracked spec symlink followed)
 *   tried;
 * - every git call runs with replace objects disabled (`--no-replace-objects` and
 *   GIT_NO_REPLACE_OBJECTS), so `refs/replace` cannot substitute the commit, a tree or the blob;
 *   the spec is read as the very blob object the walk found;
 * - a component followed by `/` or `/.` must be a directory, as for the kernel: a blob there is
 *   an error, never the spec;
 * - git output is decoded as strict UTF-8; malformed bytes are an error;
 * - the repository is the git work tree of the directory the check runs in; a spec whose file (its
 *   symlinks followed) lies outside that work tree, or inside another work tree below it, is an
 *   error, so a symlink can never make another repository's commit the baseline; it is discovered
 *   once (its three paths from one rev-parse, the `.git` entries discovery reads bound before it
 *   runs and checked again before any ref is resolved and after every read), and every later git
 *   call names its git, common and work tree directories (GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE);
 * - every git failure is an error (exit 2), never a new contract.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { decodeUtf8 } from "./check-io.js";
import { MAX_SPEC_BYTES } from "./check-parse.js";
import {
  CheckUsageError,
  canonicalPath,
  foldPath,
  nearestExistingDir,
  writeDestination,
} from "./check-paths.js";

/** System locations searched for git, in order, when APIFN_GIT is not set. */
function gitLocations(): string[] {
  if (process.platform === "win32") {
    return [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]
      .filter((dir): dir is string => typeof dir === "string" && path.isAbsolute(dir))
      .map((dir) => path.join(dir, "Git", "cmd", "git.exe"));
  }
  return ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/bin/git"];
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The absolute git executable every git call of this run uses. */
export function resolveGitExecutable(): string {
  const configured = process.env.APIFN_GIT;
  if (configured !== undefined && configured !== "") {
    if (!path.isAbsolute(configured) || !isExecutableFile(configured)) {
      throw new CheckUsageError(`APIFN_GIT must name an executable file by absolute path; got '${configured}'.`);
    }
    return configured;
  }
  const found = gitLocations().find(isExecutableFile);
  if (!found) {
    throw new CheckUsageError(
      `--base needs git, which was not found at ${gitLocations().join(", ")}. Set APIFN_GIT to the absolute path of git.`
    );
  }
  return found;
}

/**
 * Variables that select a repository, index or object store other than the one git discovers from
 * the directory it runs in (git exports GIT_DIR to hooks, wrappers set it): the check's repository
 * is the work tree of the directory it runs in, so no inherited selector reaches a git child.
 */
const REPOSITORY_SELECTORS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  // Discovery limits: the repository is the one git's default discovery finds from that directory.
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);

/** The environment of every git child: the caller's, without repository selectors (any case). */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Inherited config (GIT_CONFIG*, GIT_CONFIG_KEY_n/VALUE_n) could set core.worktree or core.ignorecase.
  const config = /^GIT_CONFIG(_GLOBAL|_SYSTEM|_COUNT|_PARAMETERS|_KEY_\d+|_VALUE_\d+)?$/;
  const kept = Object.entries(env).filter(([name]) => !REPOSITORY_SELECTORS.has(name.toUpperCase()) && !config.test(name.toUpperCase()));
  return { ...Object.fromEntries(kept), GIT_NO_REPLACE_OBJECTS: "1" };
}

class Git {
  private readonly listings = new Map<string, TreeEntry[]>();
  private ignoreCase: boolean | undefined;

  constructor(
    private readonly executable: string,
    readonly root: string,
    /** GIT_DIR and GIT_WORK_TREE of the repository discovered once: every later child reads that one. */
    private readonly bound: NodeJS.ProcessEnv = {}
  ) {}

  run(args: string[], options: { maxBuffer?: number; env?: NodeJS.ProcessEnv } = {}): { code: number; stdout: string; stderr: string } {
    const result = this.spawn(args, options);
    const stdout = decodeUtf8(result.stdout);
    if (stdout === null) {
      throw new CheckUsageError(`git ${args.join(" ")} printed bytes that are not valid UTF-8`);
    }
    return { ...result, stdout };
  }

  private spawn(args: string[], options: { maxBuffer?: number; env?: NodeJS.ProcessEnv }): { code: number; stdout: Buffer; stderr: string } {
    const result = spawnSync(this.executable, ["--no-replace-objects", ...args], {
      cwd: this.root,
      env: { ...gitEnvironment(), ...this.bound, ...options.env },
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) {
      throw new CheckUsageError(`Failed to run git ${args.join(" ")}: ${result.error.message}`);
    }
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr.toString("utf8") };
  }

  ok(args: string[], options?: { maxBuffer?: number; env?: NodeJS.ProcessEnv }): string {
    const result = this.run(args, options);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `exit status ${result.code}`;
      throw new CheckUsageError(`git ${args.join(" ")} failed: ${detail}`);
    }
    return result.stdout;
  }

  /**
   * The direct entries of one tree object, read as bytes: a name that is not UTF-8 is left out (it
   * cannot equal a component of the spec path), so an unrelated sibling never stops the walk.
   */
  entries(tree: string): TreeEntry[] {
    let listing = this.listings.get(tree);
    if (!listing) {
      const args = ["ls-tree", "-z", "-l", "--full-tree", tree];
      const result = this.spawn(args, {});
      if (result.code !== 0) {
        throw new CheckUsageError(`git ${args.join(" ")} failed: ${result.stderr.trim() || `exit status ${result.code}`}`);
      }
      listing = parseTreeListing(result.stdout);
      this.listings.set(tree, listing);
    }
    return listing;
  }

  ignoresCase(): boolean {
    if (this.ignoreCase === undefined) {
      // The repository's own config (local and worktree) only: no global or system file decides.
      const value = this.ok(["config", "--type=bool", "--default=false", "--get", "core.ignorecase"], { env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
      if (value !== "true" && value !== "false") {
        throw new CheckUsageError(`git config core.ignorecase returned '${value}', not a boolean`);
      }
      this.ignoreCase = value === "true";
    }
    return this.ignoreCase;
  }
}

interface TreeEntry {
  mode: string;
  type: string;
  object: string;
  size: number;
  name: string;
}

function parseTreeListing(listing: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (let start = 0; start < listing.length; ) {
    let end = listing.indexOf(0, start);
    if (end < 0) end = listing.length;
    const record = listing.subarray(start, end);
    start = end + 1;
    const tab = record.indexOf(0x09);
    const name = tab < 0 ? null : decodeUtf8(record.subarray(tab + 1));
    if (name === null) continue;
    const [mode, type, object, size] = record.subarray(0, tab).toString("latin1").split(/ +/);
    entries.push({ mode, type, object, size: Number(size), name });
  }
  return entries;
}

const MAX_TREE_LINKS = 40;

type Lookup = { found: false } | { found: true; path: string; entry: TreeEntry };

/** Finds one name in a tree: exactly, else (when git ignores case) under folding. */
function findEntry(git: Git, tree: string, name: string, at: string): TreeEntry | undefined {
  const entries = git.entries(tree);
  const exact = entries.find((entry) => entry.name === name);
  if (exact || !git.ignoresCase()) return exact;
  const folded = foldPath(name);
  const matches = entries.filter((entry) => foldPath(entry.name) === folded);
  if (matches.length > 1) {
    throw new CheckUsageError(
      `${at || "."} holds several entries that match '${name}' ignoring case: ${matches.map((m) => m.name).join(", ")}`
    );
  }
  return matches[0];
}

/** A directory the walk resolved: its entry name and tree object. */
interface Frame {
  name: string;
  tree: string;
}

function entryKind(entry: TreeEntry): string {
  return entry.type === "tree" ? "directory" : entry.type;
}

/** The walk's state: the directories resolved so far and the components still to read. */
class Walk {
  readonly frames: Frame[] = [];
  links = 0;

  constructor(
    readonly git: Git,
    readonly rootTree: string,
    readonly relative: string,
    readonly ref: string,
    public pending: string[]
  ) {}

  at(): string {
    return this.frames.map((frame) => frame.name).join("/");
  }

  here(entry: TreeEntry): string {
    const at = this.at();
    return at ? `${at}/${entry.name}` : entry.name;
  }

  fail(message: string): never {
    throw new CheckUsageError(message);
  }

  /** `..`: back to the directory that holds the one the walk is in. */
  up(): void {
    if (this.frames.length === 0) this.fail(`The spec path ${this.relative} at ${this.ref} leaves the repository.`);
    this.frames.pop();
  }

  /** A tracked symbolic link: its target is read next, from the directory that holds it. */
  follow(entry: TreeEntry): void {
    this.links += 1;
    if (this.links > MAX_TREE_LINKS) this.fail(`Too many symbolic links in ${this.relative} at ${this.ref}.`);
    const target = this.git.ok(["cat-file", "blob", entry.object]);
    if (leavesTree(target)) {
      this.fail(`${this.here(entry)} at ${this.ref} is a symbolic link that leaves the repository (${target}).`);
    }
    this.pending = [...target.split("/"), ...this.pending];
  }
}

/**
 * True when a tracked link target is not a relative `/`-separated path inside the tree: absolute
 * (`/x`), or on Windows drive-qualified (`C:/x`, `C:x`) or spelled with a backslash, which
 * Windows reads as a separator (`\x`, `..\..\x`) and the walk, splitting on `/`, would not.
 */
export function leavesTree(target: string, platform: NodeJS.Platform = process.platform): boolean {
  if (target.startsWith("/")) return true;
  return platform === "win32" && (/^[A-Za-z]:/.test(target) || target.includes("\\"));
}

/**
 * Walks `relative` in the commit's tree component by component, following tracked symlinks from
 * the directory that holds them and resolving `..` against the directories actually walked.
 */
function walkTree(git: Git, commit: string, relative: string, ref: string): Lookup {
  const walk = new Walk(git, `${commit}^{tree}`, relative, ref, relative.split("/"));
  while (walk.pending.length > 0) {
    const part = walk.pending.shift() as string;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      walk.up();
      continue;
    }
    const entry = findEntry(git, walk.frames.at(-1)?.tree ?? walk.rootTree, part, walk.at());
    if (!entry) return { found: false };
    if (entry.mode === "120000") {
      walk.follow(entry);
    } else if (walk.pending.length === 0) {
      return lastEntry(walk, entry);
    } else if (entry.type === "tree") {
      walk.frames.push({ name: entry.name, tree: entry.object });
    } else {
      return throughFile(walk, entry);
    }
  }
  return walk.fail(`The spec path ${relative} at ${ref} resolves to a directory.`);
}

/** The last component: it must be a blob, which is the spec. */
function lastEntry(walk: Walk, entry: TreeEntry): Lookup {
  if (entry.type !== "blob") walk.fail(`${walk.here(entry)} at ${walk.ref} is a ${entryKind(entry)}, not a spec file.`);
  return { found: true, path: walk.here(entry), entry };
}

/**
 * A non-directory where the path goes on. On a plain path, a blob before a further name means
 * nothing is tracked at the path; a blob before only `/` or `/.`, or anywhere after a followed
 * link, is an error (the kernel's ENOTDIR), never the spec and never absence.
 */
function throughFile(walk: Walk, entry: TreeEntry): Lookup {
  if (entry.type !== "blob") walk.fail(`${walk.here(entry)} at ${walk.ref} is a ${entry.type}; apifn check does not read into it.`);
  if (walk.links > 0 || walk.pending.every((part) => part === "" || part === ".")) {
    walk.fail(`${walk.here(entry)} at ${walk.ref} is a file, but the spec path needs it to be a directory.`);
  }
  return { found: false };
}

/**
 * The spec path as given (resolved, no symlink followed) relative to the logical repository root:
 * the shallowest ancestor whose native realpath is the repository's, so a path through an
 * in-repository link back to the root keeps that link's tracked spelling. Null when no ancestor
 * is the repository root, or when the lexical spelling leads to another file than the one the check
 * reads and writes (the filesystem applies a `..` after a symlink in the link target's parent):
 * then only the destination's own path is looked up.
 */
function literalRepoPath(target: string, root: string, destination: string): string | null {
  const resolved = path.resolve(target);
  try {
    // Both spellings must still lead to the destination observe bound (a link retargeted since is not).
    if (writeDestination(resolved) !== destination || writeDestination(target) !== destination) return null;
  } catch {
    return null;
  }
  let found: string | null = null;
  for (let dir = path.dirname(resolved); ; dir = path.dirname(dir)) {
    let real: string | null;
    try {
      real = realpathSync.native(dir);
    } catch {
      real = null;
    }
    if (real === root) found = dir;
    if (path.dirname(dir) === dir) break;
  }
  return found === null ? null : toRepoPath(path.relative(found, resolved));
}

function toRepoPath(relative: string): string | null {
  const posix = relative.split(path.sep).join("/");
  if (posix === "" || posix === ".." || posix.startsWith("../") || path.isAbsolute(relative)) return null;
  return posix;
}

export interface GitBaseline {
  commit: string;
  /** The tracked path the blob was read from, or null for a new contract. */
  path: string | null;
  text: string | null;
}

/** The native realpath of the git work tree holding `dir` and its git directory, or null with git's reason. */
function workTreeOf(executable: string, dir: string): { root: string; gitDir: string; commonDir: string } | { root: null; reason: string } {
  // All three paths come from one rev-parse, so they name one repository, never a mix of two.
  const out = new Git(executable, dir).run(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"]);
  if (out.code !== 0) return { root: null, reason: out.stderr.trim() || `exit status ${out.code}` };
  const paths = out.stdout.replace(/\n$/, "").split("\n");
  if (paths.length !== 3) throw new CheckUsageError(`git rev-parse in ${dir} printed a repository path that holds a line break; apifn check cannot bind it.`);
  const [top, gitDir, common] = paths;
  return { root: realpathSync.native(top), gitDir, commonDir: path.resolve(dir, common) };
}

/** The identity of each `.git` entry git's discovery reads from `dir` up to the filesystem root. */
function discoveryEntries(dir: string): string {
  const ids: string[] = [];
  for (let at = realpathSync.native(dir); ; at = path.dirname(at)) {
    try {
      const id = lstatSync(path.join(at, ".git"), { bigint: true, throwIfNoEntry: false });
      ids.push(id ? `${id.dev}:${id.ino}` : "-");
    } catch {
      ids.push("?");
    }
    if (path.dirname(at) === at) return ids.join("/");
  }
}

/**
 * Reads the spec committed at `ref` (see the module comment). `cwd` is the directory the check
 * runs in: its work tree is the repository, wherever the spec's symlinks lead. `destination` is
 * where the spec leads as the run bound it (observe), the file drift reads and --write writes:
 * the path is never resolved again here, so one binding selects the baseline too.
 */
export function readSpecAtRef(ref: string, specPath: string, destination: string, cwd: string): GitBaseline {
  if (ref.length === 0 || ref.startsWith("-")) {
    throw new CheckUsageError(`Invalid git ref '${ref}'`);
  }
  const executable = resolveGitExecutable();
  // The .git entries discovery reads are bound before it runs: one replaced during discovery is an error.
  const entries = discoveryEntries(cwd);
  const here = workTreeOf(executable, cwd);
  if (here.root === null) {
    throw new CheckUsageError(`--base needs a git work tree; ${cwd} is not inside one: ${here.reason}`);
  }
  const git = new Git(executable, here.root, { GIT_DIR: here.gitDir, GIT_COMMON_DIR: here.commonDir, GIT_WORK_TREE: here.root });
  // The git and common directories discovered once must still be those directories once every read is done.
  const bound = [here.gitDir, here.commonDir];
  const repository = bound.map((dir) => statSync(dir, { bigint: true }));
  const done = (baseline: GitBaseline): GitBaseline => {
    const now = bound.map((dir) => statSync(dir, { bigint: true, throwIfNoEntry: false }));
    if (discoveryEntries(cwd) !== entries || now.some((id, i) => id?.dev !== repository[i].dev || id.ino !== repository[i].ino)) {
      throw new CheckUsageError(`The git repository at ${here.gitDir} was replaced while apifn check read it.`);
    }
    return baseline;
  };
  // The identities are taken before any ref is resolved: a repository replaced during discovery stops here.
  done({ commit: "", path: null, text: null });

  // The file the check reads and --write writes must be inside the repository, and not inside
  // another work tree nested in it (an untracked clone, or a submodule's checkout).
  const canonical = canonicalPath(destination);
  const destinationPath = toRepoPath(path.relative(git.root, canonical));
  if (destinationPath === null) {
    throw new CheckUsageError(`Spec ${specPath} (${canonical}) is outside the git repository at ${git.root}`);
  }
  const owner = workTreeOf(executable, nearestExistingDir(canonical));
  if (owner.root !== git.root) {
    const where = owner.root === null ? `no git work tree (${owner.reason})` : `the git work tree at ${owner.root}`;
    throw new CheckUsageError(
      `Spec ${specPath} (${canonical}) is outside the git repository at ${git.root}: it belongs to ${where}`
    );
  }

  const resolved = git.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (resolved.code !== 0) {
    const detail = resolved.stderr.trim();
    throw new CheckUsageError(detail ? `Unknown git ref '${ref}': ${detail}` : `Unknown git ref '${ref}'`);
  }
  const commit = resolved.stdout.trim();
  const label = `${ref} (${commit})`;

  const candidates = [literalRepoPath(specPath, git.root, destination), destinationPath].filter(
    (candidate, index, all): candidate is string => candidate !== null && all.indexOf(candidate) === index
  );
  for (const candidate of candidates) {
    const lookup = walkTree(git, commit, candidate, label);
    if (!lookup.found) continue;
    if (lookup.entry.size > MAX_SPEC_BYTES) {
      throw new CheckUsageError(`${lookup.path} at ${label} is ${lookup.entry.size} bytes (limit ${MAX_SPEC_BYTES}).`);
    }
    // The blob object the walk found, by its id: nothing resolves the path a second time.
    const text = git.ok(["cat-file", "blob", lookup.entry.object], { maxBuffer: MAX_SPEC_BYTES + 1 });
    return done({ commit, path: lookup.path, text });
  }
  return done({ commit, path: null, text: null });
}
