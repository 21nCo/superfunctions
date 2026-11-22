/**
 * The base contract of `apifn check --base <ref>`: the one blob a single pinned commit holds at
 * the spec's repository path, resolved inside that commit's tree.
 *
 * - git runs from one absolute executable (APIFN_GIT, or the first of a fixed list of system
 *   locations), never a `git` found through the inherited PATH;
 * - git resolves the ref once (`rev-parse --verify <ref>^{commit}`); every later call names that
 *   commit;
 * - the path is walked one tree at a time; a tracked symbolic link met on the way is followed
 *   inside the same tree (never through the working tree), and one leaving the tree is an error;
 * - only when the walk proves a component missing is the spec a new contract; when the
 *   repository ignores case (core.ignorecase, which must be readable), a missing component is
 *   matched under NFC and case folding first, and two matches are an error;
 * - the path tried first is the spec as given relative to the repository root (an in-repository
 *   symlinked directory not followed); only when it is proven absent is the file a write to the
 *   spec lands on (an untracked spec symlink followed) tried;
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

/** Joins a symlink target onto its directory inside the tree; null when it leaves the tree. */
function joinInTree(dir: string[], target: string): string[] | null {
  if (target.startsWith("/")) return null;
  const parts = [...dir];
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts;
}

type Step =
  | { kind: "missing" }
  | { kind: "found"; path: string; entry: TreeEntry }
  | { kind: "link"; pending: string[] }
  | { kind: "tree"; tree: string; done: string[]; pending: string[] };

function entryKind(entry: TreeEntry): string {
  return entry.type === "tree" ? "directory" : entry.type;
}

/** Resolves one path component of the walk in `tree`. */
function walkStep(git: Git, tree: string, done: string[], pending: string[], ref: string): Step {
  const entry = findEntry(git, tree, pending[0], done.join("/"));
  if (!entry) return { kind: "missing" };
  const here = [...done, entry.name].join("/");
  const rest = pending.slice(1);
  if (entry.mode === "120000") {
    const target = git.ok(["cat-file", "blob", entry.object]);
    const next = joinInTree(done, target);
    if (next === null) {
      throw new CheckUsageError(`${here} at ${ref} is a symbolic link that leaves the repository (${target}).`);
    }
    return { kind: "link", pending: [...next, ...rest] };
  }
  if (rest.length === 0) {
    if (entry.type !== "blob") throw new CheckUsageError(`${here} at ${ref} is a ${entryKind(entry)}, not a spec file.`);
    return { kind: "found", path: here, entry };
  }
  // A file where the path needs a directory: nothing is tracked at the path.
  if (entry.type === "blob") return { kind: "missing" };
  if (entry.type !== "tree") {
    throw new CheckUsageError(`${here} at ${ref} is a ${entry.type}; apifn check does not read into it.`);
  }
  return { kind: "tree", tree: entry.object, done: [...done, entry.name], pending: rest };
}

/** Walks `relative` in the commit's tree, following tracked symlinks inside that tree. */
function walkTree(git: Git, commit: string, relative: string, ref: string): Lookup {
  const rootTree = `${commit}^{tree}`;
  let state = { tree: rootTree, done: [] as string[], pending: relative.split("/") };
  let links = 0;
  while (state.pending.length > 0) {
    const step = walkStep(git, state.tree, state.done, state.pending, ref);
    if (step.kind === "missing") return { found: false };
    if (step.kind === "found") return { found: true, path: step.path, entry: step.entry };
    if (step.kind === "tree") {
      state = step;
      continue;
    }
    links += 1;
    if (links > MAX_TREE_LINKS) throw new CheckUsageError(`Too many symbolic links in ${relative} at ${ref}.`);
    state = { tree: rootTree, done: [], pending: step.pending };
  }
  throw new CheckUsageError(`The spec path ${relative} at ${ref} resolves to the repository root.`);
}

/**
 * The spec path as given (resolved, no symlink followed) relative to the logical repository root:
 * the deepest existing ancestor whose native realpath is the repository's. Null when no ancestor
 * is the repository root.
 */
function literalRepoPath(target: string, root: string): string | null {
  const resolved = path.resolve(target);
  let dir = path.dirname(resolved);
  for (;;) {
    let real: string | null;
    try {
      real = realpathSync.native(dir);
    } catch {
      real = null;
    }
    if (real === root) {
      return toRepoPath(path.relative(dir, resolved));
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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
