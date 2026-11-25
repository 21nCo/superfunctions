import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvidenceArtifactHash, EvidenceRecordV1, EvidenceValidationResult } from "../src/index.js";
import type { VerifyEvidenceOptions } from "../src/node.js";
import { cases, records } from "./fixtures.js";

// Temporary artifact trees for verifyEvidence, removed by removeTrees. A test
// that takes a permission away restores it itself.

const trees: string[] = [];

/** A new empty directory under the OS temp directory (itself a symlinked path on macOS). */
export function makeTree(): string {
  const tree = mkdtempSync(path.join(tmpdir(), "evidence-artifacts-"));
  trees.push(tree);
  return tree;
}

export function removeTrees(): void {
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
}

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Writes a file below `root`, creating its directories, and returns its artifact hash entry. */
export function writeArtifact(root: string, relative: string, bytes: string | Uint8Array, format?: string): EvidenceArtifactHash {
  const file = path.join(root, ...relative.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return format === undefined ? { path: relative, sha256: sha256(bytes) } : { path: relative, sha256: sha256(bytes), format };
}

/** The minimal fixture record listing the given artifacts. */
export function recordWith(artifactHashes: EvidenceArtifactHash[], changes: Partial<EvidenceRecordV1> = {}): EvidenceRecordV1 {
  const record = structuredClone(records.minimal) as EvidenceRecordV1;
  record.source.artifactHashes = artifactHashes;
  return { ...record, ...changes };
}

export function optionsFor(artifactRoot: string): VerifyEvidenceOptions {
  return { ...cases.options, artifactRoot };
}

/** Code, path and artifact of each failure, in order. */
export function summary(result: EvidenceValidationResult): Array<{ code: string; path?: string; artifact?: unknown }> {
  return result.failures.map(({ code, path: pointer, detail }) => {
    const entry: { code: string; path?: string; artifact?: unknown } = { code };
    if (pointer !== undefined) entry.path = pointer;
    if (detail?.artifact !== undefined) entry.artifact = detail.artifact;
    return entry;
  });
}

/** True where file permissions stop the current process (not root, not Windows). */
export const permissionsApply = process.platform !== "win32" && process.getuid?.() !== 0;
