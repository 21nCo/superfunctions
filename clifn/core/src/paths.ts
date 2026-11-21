import { mkdir, stat } from "node:fs/promises";
import { homedir as osHomedir } from "node:os";
import { posix, win32 } from "node:path";

/** Per-app directories (D7). Each path ends with the app name segment, or `<app>\State` / `<app>\Cache` on Windows. */
export interface AppPaths {
  readonly config: string;
  readonly state: string;
  readonly cache: string;
}

/** Inputs to `resolveAppPaths`; each defaults to the current process (`process.platform`, `process.env`, `os.homedir()`). */
export interface AppPathsOptions {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  homedir?: string;
}

/** Closed app name grammar: one lowercase path segment that cannot start with `.`, `_` or `-`. */
const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class InvalidAppNameError extends Error {
  readonly code = "CLIFN_INVALID_APP_NAME";
  readonly appName: unknown;

  constructor(appName: unknown) {
    const shown = typeof appName === "string" ? JSON.stringify(appName) : `of type ${typeof appName}`;
    super(`Invalid app name ${shown}: expected ${APP_NAME_PATTERN.source}`);
    this.name = "InvalidAppNameError";
    this.appName = appName;
  }
}

export class InvalidHomeDirectoryError extends Error {
  readonly code = "CLIFN_INVALID_HOME_DIRECTORY";
  readonly homedir: string;

  constructor(homedir: string) {
    super(`Cannot resolve app directories: home directory ${JSON.stringify(homedir)} is not an absolute path`);
    this.name = "InvalidHomeDirectoryError";
    this.homedir = homedir;
  }
}

function assertAppName(appName: unknown): asserts appName is string {
  if (typeof appName !== "string" || !APP_NAME_PATTERN.test(appName)) {
    throw new InvalidAppNameError(appName);
  }
}

/** A drive-qualified (`C:\`) or UNC (`\\server\share`) path; rooted-but-driveless paths such as `\dir` are relative to the current drive. */
function isAbsoluteWin32(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value);
}

/** XDG rule: an environment value counts only when it is a non-empty absolute path. */
function absoluteEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  isAbsolute: (value: string) => boolean,
): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.length > 0 && isAbsolute(value) ? value : undefined;
}

/**
 * Resolves the config, state and cache directories for `appName` (D7) without touching the filesystem.
 *
 * Linux, macOS and every other POSIX platform use `XDG_CONFIG_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME`,
 * else `~/.config`, `~/.local/state` and `~/.cache`, each followed by `/<app>`. Windows uses `%APPDATA%\<app>`
 * and `%LOCALAPPDATA%\<app>\State` / `\Cache`, else `<home>\AppData\Roaming` / `<home>\AppData\Local`.
 * Relative or empty environment values fall back to the defaults.
 */
export function resolveAppPaths(appName: string, options: AppPathsOptions = {}): AppPaths {
  assertAppName(appName);
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? osHomedir();

  if (platform === "win32") {
    if (!isAbsoluteWin32(home)) {
      throw new InvalidHomeDirectoryError(home);
    }
    const roaming = absoluteEnv(env, "APPDATA", isAbsoluteWin32) ?? win32.join(home, "AppData", "Roaming");
    const local = absoluteEnv(env, "LOCALAPPDATA", isAbsoluteWin32) ?? win32.join(home, "AppData", "Local");
    return {
      config: win32.join(roaming, appName),
      state: win32.join(local, appName, "State"),
      cache: win32.join(local, appName, "Cache"),
    };
  }

  if (!posix.isAbsolute(home)) {
    throw new InvalidHomeDirectoryError(home);
  }
  const configHome = absoluteEnv(env, "XDG_CONFIG_HOME", posix.isAbsolute) ?? posix.join(home, ".config");
  const stateHome = absoluteEnv(env, "XDG_STATE_HOME", posix.isAbsolute) ?? posix.join(home, ".local", "state");
  const cacheHome = absoluteEnv(env, "XDG_CACHE_HOME", posix.isAbsolute) ?? posix.join(home, ".cache");
  return {
    config: posix.join(configHome, appName),
    state: posix.join(stateHome, appName),
    cache: posix.join(cacheHome, appName),
  };
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
