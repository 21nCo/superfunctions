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

/** Owned paths and digests from the manifest a previous generation wrote, or null when there is none. */
async function previousFiles(outDir: string): Promise<Map<string, string> | null | string> {
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
  if (manifest?.manifestVersion !== SDK_ARTIFACT_MANIFEST_VERSION || !Array.isArray(files)) return `${SDK_ARTIFACT_MANIFEST_FILE} is not an ${SDK_ARTIFACT_MANIFEST_VERSION} manifest.`;
  const owned = new Map<string, string>();
  for (const entry of files) {
    if (typeof entry?.path !== "string" || typeof entry.sha256 !== "string" || !isSafeRelativePath(entry.path)) return `${SDK_ARTIFACT_MANIFEST_FILE} lists an invalid file entry.`;
    owned.set(entry.path, entry.sha256);
  }
  return owned;
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
  const previous = await previousFiles(root);
  if (typeof previous === "string") {
    conflict(`${previous} Remove it, or choose an empty output directory.`, SDK_ARTIFACT_MANIFEST_FILE);
    return outcome;
  }
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
    if (recorded !== undefined && recorded !== sha256Hex(current)) {
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
    if (previous?.get(stale) !== sha256Hex(await readFile(target, "utf8"))) {
      outcome.diagnostics.push({ code: "SDK_OWNED_FILE_MODIFIED", severity: "warning", message: `"${stale}" was edited after generation and is no longer generated; it is deleted.`, pointer: stale });
    }
    outcome.deleted.push(stale);
  }
  if (outcome.diagnostics.some((diagnostic) => diagnostic.severity === "error")) return outcome;
  outcome.ok = true;
  if (options.dryRun) return outcome;

  // A crash part-way must not orphan new files: first record every path this run may create as owned.
  const pending = writes.filter((file) => !previous?.has(file.path) && !result.manifest!.customCode.seeds.includes(file.path) && file.path !== SDK_ARTIFACT_MANIFEST_FILE);
  const manifestFile = writes.find((file) => file.path === SDK_ARTIFACT_MANIFEST_FILE);
  await mkdir(root, { recursive: true });
  if (pending.length > 0) {
    const interim = { ...result.manifest, files: [...result.manifest.files, ...[...(previous ?? [])].filter(([file]) => !produced.has(file)).map(([file, sha256]) => ({ path: file, sha256 }))] };
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
