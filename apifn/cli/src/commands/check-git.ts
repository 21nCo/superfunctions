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
 * - every git failure is an error (exit 2), never a new contract.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";
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
    const result = spawnSync(this.executable, args, {
      cwd: this.root,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) {
      throw new CheckUsageError(`Failed to run git ${args.join(" ")}: ${result.error.message}`);
    }
    return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
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

/** True when nothing but `.` and empty components is left: the component just read is the last. */
function isLast(pending: string[]): boolean {
  return pending.every((part) => part === "" || part === ".");
}

/**
 * Walks `relative` in the commit's tree component by component, following tracked symlinks from
 * the directory that holds them and resolving `..` against the directories actually walked.
 */
function walkTree(git: Git, commit: string, relative: string, ref: string): Lookup {
  const rootTree = `${commit}^{tree}`;
  const frames: Frame[] = [];
  const at = () => frames.map((frame) => frame.name).join("/");
  let pending = relative.split("/");
  let links = 0;
  while (pending.length > 0) {
    const part = pending[0];
    pending = pending.slice(1);
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (frames.length === 0) throw new CheckUsageError(`The spec path ${relative} at ${ref} leaves the repository.`);
      frames.pop();
      continue;
    }
    const entry = findEntry(git, frames.at(-1)?.tree ?? rootTree, part, at());
    if (!entry) return { found: false };
    const here = at() ? `${at()}/${entry.name}` : entry.name;
    if (entry.mode === "120000") {
      links += 1;
      if (links > MAX_TREE_LINKS) throw new CheckUsageError(`Too many symbolic links in ${relative} at ${ref}.`);
      const target = git.ok(["cat-file", "blob", entry.object]);
      if (target.startsWith("/")) {
        throw new CheckUsageError(`${here} at ${ref} is a symbolic link that leaves the repository (${target}).`);
      }
      pending = [...target.split("/"), ...pending];
      continue;
    }
    if (isLast(pending)) {
      if (entry.type !== "blob") throw new CheckUsageError(`${here} at ${ref} is a ${entryKind(entry)}, not a spec file.`);
      return { found: true, path: here, entry };
    }
    // A file where the path needs a directory: nothing is tracked at the path.
    if (entry.type === "blob") return { found: false };
    if (entry.type !== "tree") {
      throw new CheckUsageError(`${here} at ${ref} is a ${entry.type}; apifn check does not read into it.`);
    }
    frames.push({ name: entry.name, tree: entry.object });
  }
  throw new CheckUsageError(`The spec path ${relative} at ${ref} resolves to a directory.`);
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
    const text = git.ok(["show", `${commit}:${lookup.path}`], { maxBuffer: MAX_SPEC_BYTES + 1 });
    return { commit, path: lookup.path, text };
  }
  return { commit, path: null, text: null };
}
