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
 * - every git failure is an error (exit 2), never a new contract.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
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

class Git {
  private readonly listings = new Map<string, TreeEntry[]>();
  private ignoreCase: boolean | undefined;

  constructor(
    private readonly executable: string,
    readonly root: string
  ) {}

  run(args: string[], options: { maxBuffer?: number } = {}): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(this.executable, ["--no-replace-objects", ...args], {
      cwd: this.root,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) {
      throw new CheckUsageError(`Failed to run git ${args.join(" ")}: ${result.error.message}`);
    }
    const stdout = decodeUtf8(result.stdout);
    if (stdout === null) {
      throw new CheckUsageError(`git ${args.join(" ")} printed bytes that are not valid UTF-8`);
    }
    return { code: result.status ?? 1, stdout, stderr: result.stderr.toString("utf8") };
  }

  ok(args: string[], options?: { maxBuffer?: number }): string {
    const result = this.run(args, options);
    if (result.code !== 0) {
      const detail = result.stderr.trim() || `exit status ${result.code}`;
      throw new CheckUsageError(`git ${args.join(" ")} failed: ${detail}`);
    }
    return result.stdout;
  }

  /** The direct entries of one tree object. */
  entries(tree: string): TreeEntry[] {
    let listing = this.listings.get(tree);
    if (!listing) {
      listing = parseTreeListing(this.ok(["ls-tree", "-z", "-l", "--full-tree", tree]));
      this.listings.set(tree, listing);
    }
    return listing;
  }

  ignoresCase(): boolean {
    if (this.ignoreCase === undefined) {
      const value = this.ok(["config", "--type=bool", "--default=false", "--get", "core.ignorecase"]).trim();
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

function parseTreeListing(listing: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const line of listing.split("\0")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, object, size] = line.slice(0, tab).split(/ +/);
    entries.push({ mode, type, object, size: Number(size), name: line.slice(tab + 1) });
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
    if (target.startsWith("/")) {
      this.fail(`${this.here(entry)} at ${this.ref} is a symbolic link that leaves the repository (${target}).`);
    }
    this.pending = [...target.split("/"), ...this.pending];
  }
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
 * A non-directory where the path goes on. A blob before a further name means nothing is tracked
 * at the path; a blob before only `/` or `/.` is an error (the kernel's ENOTDIR), never the spec.
 */
function throughFile(walk: Walk, entry: TreeEntry): Lookup {
  if (entry.type !== "blob") walk.fail(`${walk.here(entry)} at ${walk.ref} is a ${entry.type}; apifn check does not read into it.`);
  if (walk.pending.every((part) => part === "" || part === ".")) {
    walk.fail(`${walk.here(entry)} at ${walk.ref} is a file, but the spec path needs it to be a directory.`);
  }
  return { found: false };
}

/**
 * The spec path as given (resolved, no symlink followed) relative to the logical repository root:
 * the shallowest ancestor whose native realpath is the repository's, so a path through an
 * in-repository link back to the root keeps that link's tracked spelling. Null when no ancestor
 * is the repository root.
 */
function literalRepoPath(target: string, root: string): string | null {
  const resolved = path.resolve(target);
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

/** Reads the spec committed at `ref` (see the module comment). */
export function readSpecAtRef(ref: string, specPath: string): GitBaseline {
  if (ref.length === 0 || ref.startsWith("-")) {
    throw new CheckUsageError(`Invalid git ref '${ref}'`);
  }
  const executable = resolveGitExecutable();
  const probe = new Git(executable, nearestExistingDir(specPath));
  const toplevel = probe.run(["rev-parse", "--show-toplevel"]);
  if (toplevel.code !== 0) {
    throw new CheckUsageError(`--base needs a git work tree; ${probe.root} is not inside one: ${toplevel.stderr.trim()}`);
  }
  const git = new Git(executable, realpathSync.native(toplevel.stdout.trim()));

  // The file the check reads and --write writes must be inside the repository.
  const destination = canonicalPath(writeDestination(specPath));
  const destinationPath = toRepoPath(path.relative(git.root, destination));
  if (destinationPath === null) {
    throw new CheckUsageError(`Spec ${specPath} (${destination}) is outside the git repository at ${git.root}`);
  }

  const resolved = git.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  if (resolved.code !== 0) {
    const detail = resolved.stderr.trim();
    throw new CheckUsageError(detail ? `Unknown git ref '${ref}': ${detail}` : `Unknown git ref '${ref}'`);
  }
  const commit = resolved.stdout.trim();
  const label = `${ref} (${commit})`;

  const candidates = [literalRepoPath(specPath, git.root), destinationPath].filter(
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
    return { commit, path: lookup.path, text };
  }
  return { commit, path: null, text: null };
}
