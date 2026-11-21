import { mkdir, stat } from "node:fs/promises";
import { appDirResolver, type AppPathsOptions } from "./app-dirs.js";

export { InvalidAppNameError, InvalidHomeDirectoryError, type AppPathsOptions } from "./app-dirs.js";

/** Per-app directories (D7). Each path ends with the app name segment, or `<app>\State` / `<app>\Cache` on Windows. */
export interface AppPaths {
  readonly config: string;
  readonly state: string;
  readonly cache: string;
}

/**
 * Resolves the config, state and cache directories for `appName` (D7) without touching the filesystem.
 *
 * Linux, macOS and every other POSIX platform use `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME`,
 * else `~/.config`, `~/.local/state` and `~/.cache`, each followed by `/<app>`. Windows uses `%APPDATA%\<app>`
 * and `%LOCALAPPDATA%\<app>\State` / `\Cache`, else `<home>\AppData\Roaming` / `<home>\AppData\Local`.
 * Relative or empty environment values fall back to the defaults. A Windows value must be drive-absolute or a
 * UNC `\\server\share` path; device and extended-length prefixes (`\\.\`, `\\?\`) fall back too.
 */
export function resolveAppPaths(appName: string, options: AppPathsOptions = {}): AppPaths {
  const dir = appDirResolver(appName, options);
  return { config: dir("config"), state: dir("state"), cache: dir("cache") };
}

/**
 * Creates `dir` (and missing parents) with mode `0o700` on POSIX when it does not exist, and returns `dir`.
 * An existing directory is left as it is. Concurrent calls on the same path both resolve; a non-directory at
 * `dir` rejects with `ENOTDIR`.
 */
export async function ensureAppDir(dir: string): Promise<string> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
  const info = await stat(dir);
  if (!info.isDirectory()) {
    throw Object.assign(new Error(`ENOTDIR: not a directory, ensureAppDir '${dir}'`), {
      code: "ENOTDIR",
      path: dir,
    });
  }
  return dir;
}
