import { posix, win32 } from "node:path";
import { resolveAppPaths, type AppPathsOptions } from "./paths.js";

/** Thrown when a store options object is malformed: both or neither of its exclusive keys, or an unsafe file name. */
export class InvalidStoreOptionsError extends Error {
  readonly code = "CLIFN_INVALID_STORE_OPTIONS";

  constructor(detail: string) {
    super(`Invalid store options: ${detail}`);
    this.name = "InvalidStoreOptionsError";
  }
}

export function pathModuleFor(platform: NodeJS.Platform | undefined): typeof posix {
  return (platform ?? process.platform) === "win32" ? win32 : posix;
}

/**
 * A store file name relative to its base directory. It may contain subdirectories but must stay inside the base:
 * no absolute or drive-qualified path, no `..` escape, and not the base itself.
 */
export function joinStoreFile(base: string, fileName: unknown, path: typeof posix): string {
  if (typeof fileName !== "string" || fileName.length === 0) {
    throw new InvalidStoreOptionsError("fileName must be a non-empty string");
  }
  const normalized = path.normalize(fileName);
  const escapes = normalized === ".." || normalized.startsWith(`..${path.sep}`);
  if (path.isAbsolute(fileName) || /^[A-Za-z]:/.test(fileName) || escapes || normalized === "." || normalized.endsWith(path.sep)) {
    throw new InvalidStoreOptionsError(`fileName ${JSON.stringify(fileName)} must be a relative file path inside its directory`);
  }
  return path.join(base, normalized);
}

/**
 * Store files are read and written with native filesystem calls, so they resolve for the current platform only:
 * `env` and `homedir` may be injected, `platform` may not (use `resolveAppPaths` for another platform's paths).
 */
export type StoreAppPathsOptions = Pick<AppPathsOptions, "env" | "homedir">;

/**
 * `<config>/<fileName>` for `appName` on the current platform. A JavaScript caller that passes a `platform` other
 * than `process.platform` is rejected before any filesystem call, because that path is not valid for native I/O.
 */
export function appConfigFile(appName: string, fileName: unknown, options: Record<string, unknown>): string {
  const { platform, env, homedir } = options as AppPathsOptions;
  if (platform !== undefined && platform !== process.platform) {
    throw new InvalidStoreOptionsError(
      `platform ${JSON.stringify(platform)} differs from the current platform ${JSON.stringify(process.platform)}; ` +
        "stores only use paths for the current platform",
    );
  }
  const { config } = resolveAppPaths(appName, { env, homedir });
  return joinStoreFile(config, fileName, pathModuleFor(undefined));
}

/** Exactly one of the listed keys must be present (not `undefined`). Returns the key that is. */
export function exclusiveKey<TKey extends string>(options: Record<string, unknown>, keys: readonly TKey[]): TKey {
  const present = keys.filter((key) => options[key] !== undefined);
  if (present.length !== 1) {
    throw new InvalidStoreOptionsError(`pass exactly one of ${keys.join(", ")}`);
  }
  return present[0] as TKey;
}
