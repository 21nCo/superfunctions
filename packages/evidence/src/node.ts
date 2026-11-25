/// <reference types="node" />
// The Node entry: verifies a record and re-hashes its artifacts on disk.
// Only this file uses Node built-ins; the `.` entry stays runtime-neutral, and
// tsconfig.neutral.json type-checks it without Node types.
import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { pointer } from "./json.js";
import type {
  EvidenceArtifactHash,
  EvidenceFailure,
  EvidenceFailureCode,
  EvidenceRecordV1,
  EvidenceValidationResult,
  ValidateEvidenceRecordOptions,
} from "./types.js";
import { validateEvidenceRecord } from "./validate.js";

export interface VerifyEvidenceOptions extends ValidateEvidenceRecordOptions {
  /** Absolute path to an existing directory that artifact paths are relative to. It may itself be a symlink; nothing below it may be. */
  artifactRoot: string;
}

/** With one of these, the record's artifact list cannot be trusted, so no artifact is read. */
const STOP_CODES: ReadonlySet<EvidenceFailureCode> = new Set(["EVIDENCE_MISSING", "EVIDENCE_OPTIONS_INVALID", "EVIDENCE_MISSING_FIELD", "EVIDENCE_MALFORMED"]);

const READ_CHUNK_BYTES = 64 * 1024;

// O_NOFOLLOW refuses a symlink at the last component and O_NONBLOCK keeps a
// FIFO from blocking the open; both are 0 where the platform lacks them.
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

interface ArtifactProblem {
  code: EvidenceFailureCode;
  detail?: Record<string, unknown>;
}

function isProblem(value: ArtifactProblem | Stats | string): value is ArtifactProblem {
  return typeof value === "object" && typeof (value as Partial<ArtifactProblem>).code === "string";
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}

/** Maps a failed filesystem call on an artifact to a failure code. */
function fromError(error: unknown, symlinkAt?: string): ArtifactProblem {
  const code = errorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") return { code: "EVIDENCE_ARTIFACT_MISSING" };
  // ELOOP is how O_NOFOLLOW reports a symlink at the last component.
  if (code === "ELOOP") return { code: "EVIDENCE_ARTIFACT_SYMLINK", detail: symlinkAt === undefined ? undefined : { symlink: symlinkAt } };
  return { code: "EVIDENCE_ARTIFACT_UNREADABLE", detail: { reason: code } };
}

// A lone UTF-16 surrogate (what String.prototype.isWellFormed rejects). Node
// encodes one as U+FFFD, so such a path would name a different file on disk.
const LONE_SURROGATE = /\p{Surrogate}/u;

/** True when `value` is well-formed Unicode and so reaches the filesystem unchanged. */
function isWellFormed(value: string): boolean {
  return !LONE_SURROGATE.test(value);
}

/**
 * Resolves `target` to its real path, decoding the bytes the OS returns
 * losslessly: undefined when they are not valid UTF-8, because Node would
 * substitute U+FFFD and the string would name a different file.
 */
async function realpathExact(target: string): Promise<string | undefined> {
  const bytes = await fs.realpath(target, { encoding: "buffer" });
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : undefined;
}

/** True when `real` is below `root`; both are real paths. */
function isUnder(real: string, root: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return real.startsWith(prefix);
}

/**
 * Walks from the root to the artifact one component at a time with lstat, so a
 * symlink anywhere below the root (including the artifact itself) is seen
 * before anything follows it.
 */
async function walk(root: string, relative: string): Promise<ArtifactProblem | Stats> {
  const segments = relative.split("/").filter((segment) => segment.length > 0);
  let current = root;
  let stats: Stats | undefined;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index] as string);
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      return fromError(error);
    }
    if (stats.isSymbolicLink()) return { code: "EVIDENCE_ARTIFACT_SYMLINK", detail: { symlink: segments.slice(0, index + 1).join("/") } };
  }
  // A well-formed artifact path always has at least one non-empty segment.
  return stats ?? { code: "EVIDENCE_ARTIFACT_MISSING" };
}

/** Streams SHA-256 over the raw bytes of an open regular file. */
async function hashFile(file: string, relative: string): Promise<ArtifactProblem | string> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, OPEN_FLAGS);
  } catch (error) {
    return fromError(error, relative);
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return { code: "EVIDENCE_ARTIFACT_NOT_REGULAR_FILE" };
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } catch (error) {
    return { code: "EVIDENCE_ARTIFACT_UNREADABLE", detail: { reason: errorCode(error) } };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Returns the artifact's SHA-256, or why it cannot be trusted. */
async function checkArtifact(root: string, artifact: EvidenceArtifactHash): Promise<ArtifactProblem | string> {
  // No file can be named by a path the filesystem cannot encode, so nothing is looked up.
  if (!isWellFormed(artifact.path)) return { code: "EVIDENCE_ARTIFACT_MISSING", detail: { reason: "path is not well-formed Unicode" } };
  const found = await walk(root, artifact.path);
  if (isProblem(found)) return found;
  if (!found.isFile()) return { code: "EVIDENCE_ARTIFACT_NOT_REGULAR_FILE" };
  const joined = path.join(root, ...artifact.path.split("/").filter((segment) => segment.length > 0));
  let real: string | undefined;
  try {
    real = await realpathExact(joined);
  } catch (error) {
    return fromError(error);
  }
  // A real path that is not valid UTF-8 cannot be shown to be under the root.
  if (real === undefined) return { code: "EVIDENCE_ARTIFACT_OUTSIDE_ROOT", detail: { reason: "real path is not valid UTF-8" } };
  if (!isUnder(real, root)) return { code: "EVIDENCE_ARTIFACT_OUTSIDE_ROOT" };
  // Open the path as written, so a trailing slash after a file name is refused by the kernel.
  return hashFile(`${root}${root.endsWith(path.sep) ? "" : path.sep}${artifact.path}`, artifact.path);
}

/** Resolves `artifactRoot` once; undefined when it is not an absolute path to an existing directory. */
async function resolveRoot(artifactRoot: unknown): Promise<string | undefined> {
  if (typeof artifactRoot !== "string" || artifactRoot.includes("\u0000") || !isWellFormed(artifactRoot) || !path.isAbsolute(artifactRoot)) return undefined;
  try {
    // Stat the path as supplied, so the OS walks it as written ("file.txt/.." is
    // not a directory even though realpath would collapse it); stat still
    // follows a symlinked root.
    if (!(await fs.stat(artifactRoot)).isDirectory()) return undefined;
    // A real path that is not valid UTF-8 has no exact string spelling, so every
    // later lookup would reach a different directory: refuse it.
    const real = await realpathExact(artifactRoot);
    if (real === undefined) return undefined;
    return (await fs.stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

function result(failures: EvidenceFailure[]): EvidenceValidationResult {
  return { ok: failures.length === 0, failures };
}

function optionsInvalid(invalid: readonly unknown[]): EvidenceValidationResult {
  return result([{ code: "EVIDENCE_OPTIONS_INVALID", detail: { invalid: [...invalid] } }]);
}

/**
 * Validates an evidence record with `validateEvidenceRecord`, then re-hashes
 * every `source.artifactHashes` entry under `artifactRoot`. An artifact that
 * is missing, unreadable, not a regular file, reached through a symlink below
 * the root, outside the root or changed is a failure. Invalid options, a
 * missing record or a structurally invalid record read no artifact; otherwise
 * every artifact is checked and its failures are reported with the record's.
 */
export async function verifyEvidence(record: unknown, options: VerifyEvidenceOptions): Promise<EvidenceValidationResult> {
  const validation = validateEvidenceRecord(record, options);
  const structurallyValid = !validation.failures.some((failure) => STOP_CODES.has(failure.code));
  // Copy the validated artifact list before the first await, so a caller that
  // changes the record while verification runs cannot change what is checked.
  const artifacts: EvidenceArtifactHash[] = structurallyValid
    ? (record as EvidenceRecordV1).source.artifactHashes.map(({ path: relative, sha256 }) => ({ path: relative, sha256 }))
    : [];
  const invalidOptions = validation.failures.find((failure) => failure.code === "EVIDENCE_OPTIONS_INVALID");
  const optionsObject = typeof options === "object" && options !== null && !Array.isArray(options);
  // An options value that is not an object has no artifactRoot to resolve.
  const root = optionsObject ? await resolveRoot(options.artifactRoot) : undefined;
  if (invalidOptions) {
    const invalid = Array.isArray(invalidOptions.detail?.invalid) ? invalidOptions.detail.invalid : [];
    return optionsInvalid(optionsObject && root === undefined ? [...invalid, "artifactRoot"] : invalid);
  }
  if (root === undefined) return optionsInvalid(["artifactRoot"]);
  if (!structurallyValid) return validation;

  const failures = [...validation.failures];
  // One artifact at a time keeps the number of open files at one.
  for (const [index, artifact] of artifacts.entries()) {
    const base = pointer("/source/artifactHashes", index);
    const outcome = await checkArtifact(root, artifact);
    if (!isProblem(outcome)) {
      if (outcome !== artifact.sha256) {
        failures.push({ code: "EVIDENCE_ARTIFACT_HASH_MISMATCH", path: pointer(base, "sha256"), detail: { artifact: artifact.path, expected: artifact.sha256, actual: outcome } });
      }
      continue;
    }
    failures.push({ code: outcome.code, path: pointer(base, "path"), detail: { artifact: artifact.path, ...outcome.detail } });
  }
  return result(failures);
}
