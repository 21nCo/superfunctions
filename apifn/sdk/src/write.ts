// Writes a generation result into a package directory. Only files the
// generator owns are created, replaced or deleted; seeds are created once; the
// custom-code area and every other file are left alone.

import { lstat, mkdir, readFile, rename, rm, stat as follow, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256Hex } from "@apifn/contracts";
import { comparePaths, isSafeRelativePath } from "./paths.js";
import { SDK_ARTIFACT_MANIFEST_FILE, SDK_ARTIFACT_MANIFEST_VERSION, type SdkArtifactManifest, type SdkDiagnostic, type SdkGenerationResult } from "./types.js";

export interface WriteSdkOptions {
  /** Plan only: report what would change without touching the directory. */
  dryRun?: boolean;
}

export interface WriteSdkResult {
  ok: boolean;
  /** Owned files created or replaced (or that would be, in a dry run). */
  written: string[];
  unchanged: string[];
  /** Files owned by the previous generation that this one no longer produces. */
  deleted: string[];
  /** Custom-code seeds created because they were missing. */
  seeded: string[];
  diagnostics: SdkDiagnostic[];
}

async function stat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface PreviousGeneration {
  manifest: SdkArtifactManifest;
  /** Owned paths and the digests their contents had when generated. */
  owned: Map<string, Set<string>>;
}

/**
 * Written before any owned file changes and replaced by the final manifest: it keeps the previous
 * generation's provenance and digests, adds the paths this run may create, and lists in `pendingFiles`
 * what this run writes, so after an interruption either version of a file counts as generated.
 */
type InterimManifest = SdkArtifactManifest & { pendingFiles: Array<{ path: string; sha256: string }> };

/** The generation a previous run recorded, null when there is none, or why its manifest is unusable. */
async function previousGeneration(outDir: string): Promise<PreviousGeneration | null | string> {
  const file = path.join(outDir, SDK_ARTIFACT_MANIFEST_FILE);
  const info = await stat(file);
  if (!info) return null;
  if (!info.isFile()) return `${SDK_ARTIFACT_MANIFEST_FILE} is not a regular file.`;
  let manifest: Partial<SdkArtifactManifest>;
  try {
    manifest = JSON.parse(await readFile(file, "utf8")) as Partial<SdkArtifactManifest>;
  } catch {
    return `${SDK_ARTIFACT_MANIFEST_FILE} is not valid JSON.`;
  }
  const files = manifest?.files;
  const pending = (manifest as Partial<InterimManifest> | null)?.pendingFiles ?? [];
  if (manifest?.manifestVersion !== SDK_ARTIFACT_MANIFEST_VERSION || !Array.isArray(files) || !Array.isArray(pending)) {
    return `${SDK_ARTIFACT_MANIFEST_FILE} is not an ${SDK_ARTIFACT_MANIFEST_VERSION} manifest.`;
  }
  const owned = new Map<string, Set<string>>();
  for (const entry of [...files, ...pending]) {
    if (typeof entry?.path !== "string" || typeof entry.sha256 !== "string" || !isSafeRelativePath(entry.path)) return `${SDK_ARTIFACT_MANIFEST_FILE} lists an invalid file entry.`;
    const digests = owned.get(entry.path) ?? new Set<string>();
    digests.add(entry.sha256);
    owned.set(entry.path, digests);
  }
  return { manifest: manifest as SdkArtifactManifest, owned };
}

/** Rejects a path whose existing ancestors inside the output directory include a symlink or non-directory. */
async function checkAncestors(outDir: string, relative: string): Promise<string | null> {
  const segments = relative.split("/");
  let current = outDir;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const info = await stat(current);
    if (!info) return null;
    if (info.isSymbolicLink() || !info.isDirectory()) return `"${path.relative(outDir, current)}" is not a plain directory.`;
  }
  return null;
}

export async function writeSdk(outDir: string, result: SdkGenerationResult, options: WriteSdkOptions = {}): Promise<WriteSdkResult> {
  const outcome: WriteSdkResult = { ok: false, written: [], unchanged: [], deleted: [], seeded: [], diagnostics: [] };
  const conflict = (message: string, pointer?: string) => outcome.diagnostics.push({ code: "SDK_OUTPUT_CONFLICT", severity: "error", message, pointer });
  if (!result.ok || !result.manifest) {
    conflict("Generation failed; nothing was written.");
    return outcome;
  }
  const root = path.resolve(outDir);
  const rootInfo = await follow(root).catch(() => null);
  if (rootInfo && !rootInfo.isDirectory()) {
    conflict(`${root} exists and is not a directory.`);
    return outcome;
  }
  const generation = await previousGeneration(root);
  if (typeof generation === "string") {
    conflict(`${generation} Remove it, or choose an empty output directory.`, SDK_ARTIFACT_MANIFEST_FILE);
    return outcome;
  }
  const previous = generation?.owned;
  const customRoot = result.manifest.customCode.root;

  // Plan every change before writing anything, so a conflict leaves the directory untouched.
  const writes: Array<{ path: string; contents: string }> = [];
  for (const file of result.files) {
    if (!isSafeRelativePath(file.path)) {
      conflict(`"${file.path}" is not a safe package-relative path.`, file.path);
      continue;
    }
    const ancestor = await checkAncestors(root, file.path);
    if (ancestor) {
      conflict(`Cannot write "${file.path}": ${ancestor}`, file.path);
      continue;
    }
    const target = path.join(root, file.path);
    const info = await stat(target);
    if (file.ownership === "seed") {
      if (info) continue;
      outcome.seeded.push(file.path);
      writes.push(file);
      continue;
    }
    if (!info) {
      outcome.written.push(file.path);
      writes.push(file);
      continue;
    }
    if (!info.isFile()) {
      conflict(`"${file.path}" exists and is not a regular file.`, file.path);
      continue;
    }
    const current = await readFile(target, "utf8");
    const owned = file.path === SDK_ARTIFACT_MANIFEST_FILE || previous?.has(file.path) === true;
    if (current === file.contents) {
      outcome.unchanged.push(file.path);
      continue;
    }
    if (!owned) {
      conflict(`"${file.path}" exists and was not written by a previous generation; move it, or into ${customRoot} for custom code.`, file.path);
      continue;
    }
    const recorded = previous?.get(file.path);
    if (recorded !== undefined && !recorded.has(sha256Hex(current))) {
      outcome.diagnostics.push({
        code: "SDK_OWNED_FILE_MODIFIED",
        severity: "warning",
        message: `"${file.path}" was edited after generation; regeneration replaces it. Keep custom code in ${customRoot}.`,
        pointer: file.path,
      });
    }
    outcome.written.push(file.path);
    writes.push(file);
  }
  const produced = new Set(result.files.map((file) => file.path));
  for (const stale of [...(previous?.keys() ?? [])].sort(comparePaths)) {
    if (produced.has(stale) || stale.startsWith(customRoot)) continue;
    if (await checkAncestors(root, stale)) continue;
    const target = path.join(root, stale);
    const info = await stat(target);
    if (!info?.isFile()) continue;
    if (!previous?.get(stale)?.has(sha256Hex(await readFile(target, "utf8")))) {
      outcome.diagnostics.push({ code: "SDK_OWNED_FILE_MODIFIED", severity: "warning", message: `"${stale}" was edited after generation and is no longer generated; it is deleted.`, pointer: stale });
    }
    outcome.deleted.push(stale);
  }
  if (outcome.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return outcome;
  outcome.ok = true;
  if (options.dryRun) return outcome;

  // A crash part-way must neither orphan new files nor make rewritten ones look hand-edited: first record
  // every path this run may create or replace, keeping the previous provenance and digests.
  const seeds = new Set(result.manifest.customCode.seeds);
  const owned = writes.filter((file) => !seeds.has(file.path) && file.path !== SDK_ARTIFACT_MANIFEST_FILE);
  const manifestFile = writes.find((file) => file.path === SDK_ARTIFACT_MANIFEST_FILE);
  await mkdir(root, { recursive: true });
  if (owned.length > 0 || outcome.deleted.length > 0) {
    const base = generation?.manifest ?? result.manifest;
    const recorded = [...(previous ?? [])].flatMap(([file, digests]) => [...digests].map((sha256) => ({ path: file, sha256 })));
    const created = owned.filter((file) => !previous?.has(file.path)).map((file) => ({ path: file.path, sha256: sha256Hex(file.contents) }));
    const interim: InterimManifest = {
      ...base,
      files: (generation ? [...recorded, ...created] : created).sort((a, b) => comparePaths(a.path, b.path)),
      pendingFiles: owned.map((file) => ({ path: file.path, sha256: sha256Hex(file.contents) })),
    };
    await atomicWrite(path.join(root, SDK_ARTIFACT_MANIFEST_FILE), `${JSON.stringify(interim, null, 2)}\n`);
  }
  for (const file of writes) {
    if (file === manifestFile) continue;
    await mkdir(path.dirname(path.join(root, file.path)), { recursive: true });
    await atomicWrite(path.join(root, file.path), file.contents);
  }
  for (const stale of outcome.deleted) await rm(path.join(root, stale), { force: true });
  if (manifestFile) await atomicWrite(path.join(root, manifestFile.path), manifestFile.contents);
  return outcome;
}

async function atomicWrite(file: string, contents: string): Promise<void> {
  const temporary = `${file}.apifn-tmp-${process.pid}`;
  await writeFile(temporary, contents);
  await rename(temporary, file);
}
