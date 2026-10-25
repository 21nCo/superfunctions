import {
  constants,
  closeSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
export interface ArchiveLimits {
  maxBytes?: number;
  maxManifestBytes?: number;
  maxEntries?: number;
  maxDepth?: number;
}
interface Limits {
  maxBytes: number;
  maxManifestBytes: number;
  maxEntries: number;
  maxDepth: number;
}
interface Entry {
  relativePath: string;
  offset: number;
  size: number;
}
export class ArchiveError extends Error {}
const fail = (message = "Invalid or unsafe workspace archive"): never => {
  throw new ArchiveError(message);
};
export function archiveError(error: unknown): string {
  return error instanceof ArchiveError
    ? error.message
    : "Workspace archive operation failed";
}
export function validateArchiveLimits(value: ArchiveLimits = {}): Limits {
  const result = {
    maxBytes: value.maxBytes ?? 64 * 1024 * 1024,
    maxManifestBytes: value.maxManifestBytes ?? 1024 * 1024,
    maxEntries: value.maxEntries ?? 10000,
    maxDepth: value.maxDepth ?? 64,
  };
  for (const v of Object.values(result))
    if (!Number.isSafeInteger(v) || v < 1) fail("Invalid archive limits");
  if (
    result.maxBytes > 1024 * 1024 * 1024 ||
    result.maxManifestBytes > 16 * 1024 * 1024 ||
    result.maxEntries > 100000 ||
    result.maxDepth > 256
  )
    fail("Archive limits exceed supported bounds");
  return result;
}
function parts(path: string, limit: Limits, allowRoot = false): string[] {
  if (
    typeof path !== "string" ||
    Buffer.byteLength(path) > 4096 ||
    /[\\\0:]/.test(path)
  )
    fail();
  if (allowRoot && (path === "." || path === "")) return [];
  const result = path.split("/");
  if (
    result.length > limit.maxDepth ||
    result.some((p) => !p || p === "." || p === "..")
  )
    fail();
  return result;
}
function rootPath(workspace: string) {
  if (process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number")
    fail(
      "Workspace archive confinement requires POSIX no-follow file operations",
    );
  const root = realpathSync(workspace);
  if (!lstatSync(root).isDirectory()) fail();
  return root;
}
function inspect(root: string, segments: string[], allowMissing = false) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    fail();
  let path = root;
  for (let index = 0; index < segments.length; index++) {
    path = join(path, segments[index]);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
      throw error;
    }
    if (
      stat.isSymbolicLink() ||
      (!stat.isFile() && !stat.isDirectory()) ||
      (stat.isFile() && stat.nlink !== 1)
    )
      fail();
    if (index < segments.length - 1 && !stat.isDirectory()) fail();
  }
  return lstatSync(path);
}
function readRegular(
  root: string,
  segments: string[],
  remaining: number,
): Buffer {
  inspect(root, segments);
  const fd = openSync(
    join(root, ...segments),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > remaining)
      fail("Archive byte limit exceeded or unsafe file");
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, remaining - total + 1));
      const size = readSync(fd, chunk, 0, chunk.length, null);
      if (!size) break;
      total += size;
      if (total > remaining) fail("Archive byte limit exceeded");
      chunks.push(chunk.subarray(0, size));
    }
    return Buffer.concat(chunks, total);
  } finally {
    closeSync(fd);
  }
}
/** Existing Ci wire format; source traversal and every regular-file read remain workspace scoped. */
export function packWorkspace(
  workspace: string,
  paths: string[],
  artifact: boolean,
  policy?: ArchiveLimits,
): { data: Buffer; count: number } {
  const cap = validateArchiveLimits(policy),
    root = rootPath(workspace);
  if (!Array.isArray(paths) || paths.length > cap.maxEntries) fail();
  const files = new Map<string, Buffer>();
  const portableNames = new Map<string, string>();
  let total = 0,
    visited = 0;
  const visit = (segments: string[], base: string[]) => {
    if (++visited > cap.maxEntries) fail("Archive entry limit exceeded");
    if (segments.length > cap.maxDepth) fail("Archive depth limit exceeded");
    const stat = inspect(root, segments, true);
    if (!stat) {
      if (artifact) fail("Artifact path not found");
      return;
    }
    if (stat.isFile()) {
      const name = (artifact ? segments.slice(base.length) : segments).join(
        "/",
      );
      parts(name, cap);
      if (files.has(name)) return;
      const identity = name.normalize("NFC").toLowerCase();
      if (portableNames.has(identity)) fail();
      portableNames.set(identity, name);
      const data = readRegular(root, segments, cap.maxBytes - total - 4);
      files.set(name, data);
      total += data.length;
      return;
    }
    const dir = opendirSync(join(root, ...segments));
    try {
      for (;;) {
        const entry = dir.readSync();
        if (!entry) break;
        parts(entry.name, cap);
        visit([...segments, entry.name], base);
      }
    } finally {
      dir.closeSync();
    }
  };
  for (const path of paths) {
    const segments = parts(path, cap, true),
      stat = inspect(root, segments, true);
    visit(segments, artifact && stat?.isDirectory() ? segments : []);
  }
  const entries: Entry[] = [];
  const buffers: Buffer[] = [];
  let offset = 0;
  for (const [relativePath, data] of [...files].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    entries.push({ relativePath, offset, size: data.length });
    buffers.push(data);
    offset += data.length;
  }
  const manifest = Buffer.from(JSON.stringify(entries));
  if (
    manifest.length > cap.maxManifestBytes ||
    4 + manifest.length + total > cap.maxBytes
  )
    fail("Archive byte or manifest limit exceeded");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(manifest.length);
  return {
    data: Buffer.concat([header, manifest, ...buffers]),
    count: entries.length,
  };
}
/** Validate the entire archive and all existing destination paths before the first write. */
export function unpackWorkspace(
  workspace: string,
  data: Buffer,
  policy?: ArchiveLimits,
): number {
  const cap = validateArchiveLimits(policy),
    root = rootPath(workspace);
  if (!Buffer.isBuffer(data) || data.length < 4 || data.length > cap.maxBytes)
    fail("Archive byte limit exceeded or invalid header");
  const length = data.readUInt32BE(0),
    start = 4 + length;
  if (length > cap.maxManifestBytes || start > data.length) fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(4, start)),
    );
  } catch {
    fail();
  }
  if (!Array.isArray(parsed) || parsed.length > cap.maxEntries)
    fail("Archive entry limit exceeded or invalid manifest");
  const entries: Entry[] = [];
  const names = new Set<string>();
  let offset = 0;
  for (const value of parsed as unknown[]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const entry = value as Entry;
    const segments = parts(entry.relativePath, cap);
    if (
      !Number.isSafeInteger(entry.offset) ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.offset !== offset ||
      entry.size > data.length - start - offset
    )
      fail();
    // Reject case/NFC file aliases on supported POSIX filesystems; not a Windows path contract.
    const identity = entry.relativePath.normalize("NFC").toLowerCase();
    if (names.has(identity)) fail();
    names.add(identity);
    const existing = inspect(root, segments, true);
    if (existing && !existing.isFile()) fail();
    entries.push({
      relativePath: entry.relativePath,
      offset: entry.offset,
      size: entry.size,
    });
    offset += entry.size;
  }
  if (offset !== data.length - start) fail();
  const destinations = new Set(entries.map((entry) => entry.relativePath));
  for (const name of names) {
    const components = name.split("/");
    for (let i = 1; i < components.length; i++) {
      const parent = components.slice(0, i).join("/");
      if (names.has(parent)) fail();
    }
  }
  for (const entry of entries) {
    const components = entry.relativePath.split("/");
    for (let i = 1; i < components.length; i++) {
      destinations.add(components.slice(0, i).join("/"));
      if (destinations.size > cap.maxEntries)
        fail("Archive entry limit exceeded");
    }
  }
  for (const entry of entries) {
    const segments = parts(entry.relativePath, cap);
    for (let i = 1; i < segments.length; i++) {
      const parent = segments.slice(0, i);
      if (!inspect(root, parent, true)) {
        try {
          mkdirSync(join(root, ...parent));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      if (!inspect(root, parent)?.isDirectory()) fail();
    }
    inspect(root, segments, true);
    const destination = join(root, ...segments);
    let fd: number;
    try {
      fd = openSync(
        destination,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      fd = openSync(destination, constants.O_WRONLY | constants.O_NOFOLLOW);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) fail();
      ftruncateSync(fd, 0);
      let written = 0;
      while (written < entry.size) {
        const count = writeSync(
          fd,
          data,
          start + entry.offset + written,
          entry.size - written,
          null,
        );
        if (count <= 0) fail("Workspace write made no progress");
        written += count;
      }
    } finally {
      closeSync(fd);
    }
  }
  return entries.length;
}
