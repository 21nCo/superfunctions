import { compareCodePoints, sha256 } from "./canonical.js";
import { ReviewFnError } from "./errors.js";
import type { ArtifactStore, ChangeDetail, ChangeHunk, ChangeHunkFile, ChangeHunks, ReviewReport } from "./types.js";

/** Content-addressed artifact kind for stored `ChangeHunks` documents. */
export const CHANGE_HUNKS_ARTIFACT_KIND = "change-hunks";

/**
 * Git arguments, after the subcommand, that produce the only diff format `parseChangeHunks` accepts.
 * The prefix, relative, inter-hunk and submodule options pin repository-configurable output to the
 * documented `git diff --no-color --no-ext-diff --find-renames -U0 <from> <to>` shape.
 */
export function changeHunksDiffArguments(from: string, to: string): string[] {
  return ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "-U0", "--inter-hunk-context=0", "--src-prefix=a/", "--dst-prefix=b/", "--no-relative", "--submodule=short", "--end-of-options", from, to];
}

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export function isCommitId(value: unknown): value is string {
  return typeof value === "string" && COMMIT.test(value);
}

function unsupported(message: string, line?: number): never {
  throw new ReviewFnError("REVIEWFN_DIFF_UNSUPPORTED", line === undefined ? message : `${message} (diff line ${line}).`);
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Decode one Git C-style quoted path starting at `start`; returns the value and the index after the closing quote. */
function readQuoted(text: string, start: number, line: number): { value: string; end: number } {
  const bytes: number[] = [];
  for (let index = start + 1; index < text.length; index++) {
    const point = text.codePointAt(index) as number;
    const char = String.fromCodePoint(point);
    if (point > 0xffff) index++;
    if (char === '"') {
      try { return { value: utf8.decode(new Uint8Array(bytes)), end: index + 1 }; }
      catch { return unsupported("Quoted diff path is not valid UTF-8", line); }
    }
    if (char !== "\\") { bytes.push(...Buffer.from(char, "utf8")); continue; }
    const next = text[++index];
    if (next !== undefined && next in ESCAPES) { bytes.push(ESCAPES[next]); continue; }
    const octal = /^[0-3][0-7]{2}/.exec(text.slice(index, index + 3));
    if (!octal) unsupported("Quoted diff path has an unsupported escape", line);
    bytes.push(Number.parseInt(octal[0], 8));
    index += 2;
  }
  return unsupported("Quoted diff path is unterminated", line);
}

/** A header path token: quoted, or the unquoted remainder of the line (Git appends a TAB to unquoted names with spaces). */
function headerPath(raw: string, line: number): string {
  if (raw.startsWith('"')) {
    const { value, end } = readQuoted(raw, 0, line);
    if (raw.slice(end).replace(/\t$/, "") !== "") unsupported("Unexpected text after a quoted diff path", line);
    return value;
  }
  return raw.replace(/\t$/, "");
}

function stripPrefix(value: string, prefix: "a/" | "b/", line: number): string {
  if (!value.startsWith(prefix) || value.length === prefix.length) unsupported(`Diff path ${JSON.stringify(value)} lacks the ${prefix} prefix`, line);
  return value.slice(prefix.length);
}

/** Parse `diff --git a/<old> b/<new>`. Unquoted names containing " b/" are ambiguous unless both sides are equal. */
function gitHeaderPaths(rest: string, line: number): { oldPath?: string; newPath?: string } {
  if (rest.startsWith('"')) {
    const first = readQuoted(rest, 0, line);
    if (rest[first.end] !== " ") unsupported("Malformed diff --git header", line);
    return { oldPath: stripPrefix(first.value, "a/", line), newPath: stripPrefix(headerPath(rest.slice(first.end + 1), line), "b/", line) };
  }
  if (rest.endsWith('"')) {
    const split = rest.lastIndexOf(' "b/');
    if (split > 0) return { oldPath: stripPrefix(rest.slice(0, split), "a/", line), newPath: stripPrefix(headerPath(rest.slice(split + 1), line), "b/", line) };
  }
  // Identical names: `a/P b/P`, the same rule `git apply` uses for names with spaces.
  if (rest.length > 5 && (rest.length - 5) % 2 === 0) {
    const half = 2 + (rest.length - 5) / 2;
    const left = rest.slice(0, half);
    const right = rest.slice(half + 1);
    if (rest[half] === " " && left.startsWith("a/") && right.startsWith("b/") && left.slice(2) === right.slice(2)) return { oldPath: left.slice(2), newPath: right.slice(2) };
  }
  return {};
}

// The function-name trailer may contain CR or Unicode line separators; lines are split on LF only.
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: [^\n]*)?$/;
const EXTENDED = /^(?:old mode|new mode|deleted file mode|new file mode|similarity index|dissimilarity index|index) /;

interface PendingFile { oldPath?: string; newPath?: string; renameFrom?: string; renameTo?: string; minus?: string; plus?: string; added: boolean; deleted: boolean; binary: boolean; hunks: ChangeHunk[] }

function finish(pending: PendingFile, line: number): ChangeHunkFile {
  const oldPath = pending.renameFrom ?? pending.minus ?? pending.oldPath;
  const newPath = pending.renameTo ?? pending.plus ?? pending.newPath;
  if (!oldPath || !newPath) unsupported("Diff file header has ambiguous paths", line);
  const renamed = pending.renameFrom !== undefined;
  if (!renamed && oldPath !== newPath) unsupported("Diff file paths differ without rename headers", line);
  if (pending.added && pending.deleted) unsupported("Diff file is both added and deleted", line);
  const status: ChangeHunkFile["status"] = pending.binary ? "binary" : renamed ? "renamed" : pending.added ? "added" : pending.deleted ? "deleted" : "modified";
  const file: ChangeHunkFile = { path: pending.deleted ? oldPath : newPath, status, hunks: pending.binary ? [] : pending.hunks };
  if (renamed) file.previousPath = oldPath;
  return file;
}

/** Merge a type change (Git emits a deletion and a creation for one path) into one modified entry. */
function mergeFiles(files: ChangeHunkFile[]): ChangeHunkFile[] {
  const byPath = new Map<string, ChangeHunkFile>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (!existing) { byPath.set(file.path, file); continue; }
    const typeChange = (existing.status === "deleted" || existing.status === "binary") && (file.status === "added" || file.status === "binary") && !existing.previousPath && !file.previousPath;
    if (!typeChange) unsupported(`Diff lists path ${JSON.stringify(file.path)} more than once`);
    const binary = existing.status === "binary" || file.status === "binary";
    byPath.set(file.path, { path: file.path, status: binary ? "binary" : "modified", hunks: binary ? [] : [...existing.hunks, ...file.hunks] });
  }
  return [...byPath.values()].sort((left, right) => compareCodePoints(left.path, right.path));
}

/**
 * Parse the exact output of `git diff` with `changeHunksDiffArguments`. Combined diffs, word diffs,
 * external diff drivers, copy detection and any other format are rejected with REVIEWFN_DIFF_UNSUPPORTED.
 */
export function parseChangeHunks(diff: string, baseCommit: string, headCommit: string): ChangeHunks {
  if (!isCommitId(baseCommit) || !isCommitId(headCommit)) throw new ReviewFnError("REVIEWFN_DIFF_UNSUPPORTED", "Change hunks require full commit IDs.");
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  else if (lines.length) unsupported("Diff output does not end with a newline");
  const files: ChangeHunkFile[] = [];
  let pending: PendingFile | undefined;
  let state: "header" | "patch" = "header";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const number = index + 1;
    if (line.startsWith("diff --git ")) {
      if (pending) files.push(finish(pending, number));
      pending = { ...gitHeaderPaths(line.slice("diff --git ".length), number), added: false, deleted: false, binary: false, hunks: [] };
      state = "header";
      continue;
    }
    if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ") || line.startsWith("@@@")) unsupported("Combined diffs are not supported", number);
    if (!pending) unsupported("Diff output does not start with a diff --git header", number);
    if (state === "header") {
      if (EXTENDED.test(line)) {
        if (line.startsWith("new file mode ")) pending.added = true;
        if (line.startsWith("deleted file mode ")) pending.deleted = true;
        continue;
      }
      if (line.startsWith("rename from ")) { pending.renameFrom = headerPath(line.slice("rename from ".length), number); continue; }
      if (line.startsWith("rename to ")) { pending.renameTo = headerPath(line.slice("rename to ".length), number); continue; }
      if (line.startsWith("copy from ") || line.startsWith("copy to ")) unsupported("Copy detection is not supported", number);
      if (line.startsWith("Binary files ") && line.endsWith(" differ")) { pending.binary = true; state = "patch"; continue; }
      if (line.startsWith("--- ")) {
        const value = headerPath(line.slice(4), number);
        if (value !== "/dev/null") pending.minus = stripPrefix(value, "a/", number);
        const next = lines[index + 1];
        if (next === undefined || !next.startsWith("+++ ")) unsupported("Diff file header lacks a +++ line", number + 1);
        const plus = headerPath(next.slice(4), number + 1);
        if (plus !== "/dev/null") pending.plus = stripPrefix(plus, "b/", number + 1);
        if ((value === "/dev/null") !== pending.added || (plus === "/dev/null") !== pending.deleted) unsupported("Diff file header disagrees with its file mode", number);
        index++;
        state = "patch";
        continue;
      }
    }
    const header = HUNK.exec(line);
    if (header && state === "patch" && !pending.binary) {
      const hunk: ChangeHunk = { oldStart: Number(header[1]), oldLines: header[2] === undefined ? 1 : Number(header[2]), newStart: Number(header[3]), newLines: header[4] === undefined ? 1 : Number(header[4]) };
      if (![hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines].every(Number.isSafeInteger) || hunk.oldLines + hunk.newLines === 0) unsupported("Malformed hunk header", number);
      let removed = 0;
      let added = 0;
      while (removed < hunk.oldLines || added < hunk.newLines) {
        const body = lines[++index];
        if (body === undefined) unsupported("Hunk ends before its declared line counts", index + 1);
        if (body.startsWith("-") && removed < hunk.oldLines) removed++;
        else if (body.startsWith("+") && added < hunk.newLines) added++;
        else if (body.startsWith("\\ ") && index > 0 && /^[-+]/.test(lines[index - 1])) continue;
        else unsupported("Hunk body is not a zero-context unified diff", index + 1);
      }
      if (lines[index + 1]?.startsWith("\\ ")) index++;
      pending.hunks.push(hunk);
      continue;
    }
    unsupported("Unsupported diff line", number);
  }
  if (pending) files.push(finish(pending, lines.length));
  return { version: 1, baseCommit, headCommit, files: mergeFiles(files) };
}

/** Paths whose content cannot carry line-level evidence. */
export function binaryChangePaths(hunks: ChangeHunks): string[] {
  return hunks.files.filter(file => file.status === "binary").map(file => file.path);
}

/** The changed paths of a `ChangeHunks` document: head-side paths, or the removed path for deletions. */
export function changeHunkPaths(hunks: ChangeHunks): string[] {
  return hunks.files.map(file => file.path);
}

/** Deterministic artifact bytes for a `ChangeHunks` document. */
export function serializeChangeHunks(hunks: ChangeHunks): string {
  return JSON.stringify({ version: hunks.version, baseCommit: hunks.baseCommit, headCommit: hunks.headCommit, files: hunks.files.map(file => ({ path: file.path, ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }), status: file.status, hunks: file.hunks.map(hunk => ({ oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines })) })) });
}

const STATUSES = new Set<ChangeHunkFile["status"]>(["added", "modified", "deleted", "renamed", "binary"]);
const count = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Structural validation of an untrusted `ChangeHunks` value. */
export function changeHunksErrors(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["Change hunks must be an object."];
  const hunks = value as Partial<ChangeHunks>;
  const errors: string[] = [];
  if (hunks.version !== 1) errors.push("Change hunks version must be 1.");
  if (!isCommitId(hunks.baseCommit) || !isCommitId(hunks.headCommit)) errors.push("Change hunks require full base and head commit IDs.");
  if (!Array.isArray(hunks.files)) return [...errors, "Change hunks files must be an array."];
  let previous: string | undefined;
  for (const file of hunks.files as unknown[]) {
    const item = file as Partial<ChangeHunkFile> | null;
    if (!item || typeof item !== "object" || typeof item.path !== "string" || !item.path) { errors.push("Change hunks file requires a path."); continue; }
    if (previous !== undefined && compareCodePoints(previous, item.path) >= 0) errors.push(`Change hunks files are not sorted and unique at ${item.path}.`);
    previous = item.path;
    if (!STATUSES.has(item.status as ChangeHunkFile["status"])) errors.push(`Change hunks file ${item.path} has an invalid status.`);
    if (item.previousPath !== undefined && (typeof item.previousPath !== "string" || !item.previousPath || !["renamed", "binary"].includes(item.status as string))) errors.push(`Change hunks file ${item.path} has an invalid previous path.`);
    if (item.status === "renamed" && item.previousPath === undefined) errors.push(`Renamed file ${item.path} requires its previous path.`);
    if (!Array.isArray(item.hunks) || !item.hunks.every(hunk => hunk && typeof hunk === "object" && count(hunk.oldStart) && count(hunk.oldLines) && count(hunk.newStart) && count(hunk.newLines))) errors.push(`Change hunks file ${item.path} has invalid hunks.`);
    else if (item.status === "binary" && item.hunks.length) errors.push(`Binary file ${item.path} cannot have line-level hunks.`);
  }
  return errors;
}

/**
 * Range rule for incremental review: `since` must be a full commit ID that is an ancestor of (or equal to)
 * the head and a descendant of (or equal to) the merge base. Returns the reason the range is invalid.
 */
export async function sinceRangeError(since: string, mergeBaseCommit: string, headCommit: string, isAncestor: (ancestor: string, descendant: string) => Promise<boolean>): Promise<string | undefined> {
  if (!isCommitId(since)) return `since ${JSON.stringify(since)} is not a full 40- or 64-hex commit ID.`;
  if (!(await isAncestor(since, headCommit))) return `since ${since} is not an ancestor of head ${headCommit}.`;
  if (!(await isAncestor(mergeBaseCommit, since))) return `since ${since} is not a descendant of merge base ${mergeBaseCommit}.`;
  return undefined;
}

/** Load and verify a stored hunks artifact; mismatches are reported with REVIEWFN_CHANGE_DETAIL_MISMATCH. */
async function loadHunks(label: string, id: string | undefined, digest: string | undefined, artifacts: ArtifactStore, errors: string[]): Promise<ChangeHunks | undefined> {
  const mismatch = (message: string) => { errors.push(`REVIEWFN_CHANGE_DETAIL_MISMATCH: ${label} ${message}`); return undefined; };
  if (typeof id !== "string" || typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return mismatch("requires an artifact ID and SHA-256 digest.");
  if (id !== `${CHANGE_HUNKS_ARTIFACT_KIND}-${digest}`) return mismatch(`artifact ${id} is not the content-addressed ${CHANGE_HUNKS_ARTIFACT_KIND} artifact for its digest.`);
  const bytes = await artifacts.get(id);
  if (!bytes) return mismatch(`artifact ${id} is not retained.`);
  if (sha256(bytes) !== digest) return mismatch(`artifact ${id} does not match digest ${digest}.`);
  let value: unknown;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { return mismatch(`artifact ${id} is not JSON.`); }
  const structural = changeHunksErrors(value);
  if (structural.length) return mismatch(`artifact ${id} is malformed: ${structural.join(" ")}`);
  return value as ChangeHunks;
}

export interface ChangeDetailVerification {
  errors: string[];
  /** Verified full-change hunks, when the artifact matched. */
  hunks?: ChangeHunks;
  /** Verified delta hunks, when `since` was recorded and the artifact matched. */
  delta?: ChangeHunks;
}

/** Verify `ReviewReport.changeDetail` against its stored artifacts and the reviewed change. */
export async function verifyChangeDetail(report: ReviewReport, artifacts?: ArtifactStore): Promise<ChangeDetailVerification> {
  const detail: ChangeDetail | undefined = report.changeDetail;
  const errors: string[] = [];
  if (detail === undefined) return { errors };
  const mismatch = (message: string) => errors.push(`REVIEWFN_CHANGE_DETAIL_MISMATCH: ${message}`);
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) { mismatch("changeDetail must be an object."); return { errors }; }
  if (!artifacts) { mismatch("changeDetail cannot be verified without the artifact store."); return { errors }; }
  const hunks = await loadHunks("change hunks", detail.hunksArtifact, detail.hunksDigest, artifacts, errors);
  if (hunks) {
    if (hunks.baseCommit !== report.change.mergeBaseCommit || hunks.headCommit !== report.change.headCommit) mismatch(`change hunks cover ${hunks.baseCommit}..${hunks.headCommit}, not the reviewed ${report.change.mergeBaseCommit}..${report.change.headCommit}.`);
    const changed = new Set(report.change.changedPaths);
    const listed = new Set(hunks.files.flatMap(file => file.previousPath === undefined ? [file.path] : [file.path, file.previousPath]));
    for (const file of hunks.files) if (!changed.has(file.path)) mismatch(`change hunks path ${file.path} is not a changed path.`);
    for (const path of changed) if (!listed.has(path)) mismatch(`changed path ${path} is missing from the change hunks.`);
  }
  if (detail.since === undefined) {
    if ([detail.deltaHunksArtifact, detail.deltaHunksDigest, detail.deltaPaths].some(field => field !== undefined)) mismatch("delta hunks require since.");
    return { errors, hunks };
  }
  if (!isCommitId(detail.since)) { mismatch("since is not a full commit ID."); return { errors, hunks }; }
  const delta = await loadHunks("delta hunks", detail.deltaHunksArtifact, detail.deltaHunksDigest, artifacts, errors);
  const deltaPaths = detail.deltaPaths;
  if (!Array.isArray(deltaPaths) || !deltaPaths.every(path => typeof path === "string")) { mismatch("deltaPaths must be a string array."); return { errors, hunks }; }
  if (delta) {
    if (delta.baseCommit !== detail.since || delta.headCommit !== report.change.headCommit) mismatch(`delta hunks cover ${delta.baseCommit}..${delta.headCommit}, not ${detail.since}..${report.change.headCommit}.`);
    const expected = changeHunkPaths(delta);
    if (expected.length !== deltaPaths.length || expected.some((path, index) => path !== deltaPaths[index])) mismatch("deltaPaths do not match the delta hunks.");
  }
  return { errors, hunks, delta };
}
