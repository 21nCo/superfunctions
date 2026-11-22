/** Path helpers shared by the git baseline lookup and the publisher of `apifn check`. */

import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export class CheckUsageError extends Error {}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isMissingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** NFC plus case folding: the key under which a case-insensitive filesystem treats names as one. */
export function foldPath(value: string): string {
  return value.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/** The nearest ancestor of `target` (itself excluded) that exists, symlinks followed. */
export function nearestExistingDir(target: string): string {
  let dir = path.dirname(target);
  while (!existsSync(dir) && path.dirname(dir) !== dir) {
    dir = path.dirname(dir);
  }
  return dir;
}

function symlinkTarget(candidate: string): string | null {
  try {
    return lstatSync(candidate).isSymbolicLink() ? readlinkSync(candidate) : null;
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The path a write to `target` lands on: every existing symlink on the way, the leaf included,
 * is followed as the kernel would; components that do not exist yet are kept as given.
 */
export function writeDestination(target: string): string {
  const absolute = path.resolve(target);
  let resolved = path.parse(absolute).root;
  const pending = absolute.slice(resolved.length).split(path.sep);
  let links = 0;
  while (pending.length > 0) {
    const part = pending.shift() as string;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // The kernel steps out of a directory only: `file/..` and `missing/..` fail (ENOTDIR,
      // ENOENT), so a link target spelled that way leads nowhere.
      if (!isDirectory(resolved)) {
        throw new CheckUsageError(`${target} leads through ${resolved}, which is not a directory, before '..'.`);
      }
      resolved = path.dirname(resolved);
      continue;
    }
    const candidate = path.join(resolved, part);
    const link = symlinkTarget(candidate);
    if (link === null) {
      resolved = candidate;
      continue;
    }
    links += 1;
    if (links > 40) {
      throw new CheckUsageError(`Too many symbolic links in ${target}.`);
    }
    if (path.isAbsolute(link)) {
      resolved = path.parse(link).root;
      pending.unshift(...link.slice(resolved.length).split(path.sep));
    } else {
      pending.unshift(...link.split(path.sep));
    }
  }
  return resolved;
}

/**
 * `target` spelled from the native realpath of its nearest existing directory: the on-disk
 * spelling of every existing directory, the missing components as given.
 */
export function canonicalPath(target: string): string {
  const dir = nearestExistingDir(target);
  return path.join(realpathSync.native(dir), path.relative(dir, target));
}
