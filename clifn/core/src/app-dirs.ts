import { homedir as osHomedir } from "node:os";
import { posix, win32 } from "node:path";

/** Inputs to `resolveAppPaths`; each defaults to the current process (`process.platform`, `process.env`, `os.homedir()`). */
export interface AppPathsOptions {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  homedir?: string;
}

export type AppDirKind = "config" | "state" | "cache";

/** Closed app name grammar: one lowercase path segment that cannot start with `.`, `_` or `-`. */
const APP_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export class InvalidAppNameError extends Error {
  readonly code = "CLIFN_INVALID_APP_NAME";
  readonly appName: unknown;

  constructor(appName: unknown, reason = `expected ${APP_NAME_PATTERN.source}`) {
    const shown = typeof appName === "string" ? JSON.stringify(appName) : `of type ${typeof appName}`;
    super(`Invalid app name ${shown}: ${reason}`);
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

/** Win32 device names (any case), reserved as a path segment alone or before an extension (`nul`, `NUL.txt`). */
const WIN32_DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * Whether Win32 opens something other than the segment as written: it drops trailing dots and spaces (`tool.` opens
 * `tool`), and a device name, also before an extension or trailing spaces, opens the device. `.` and `..` are not
 * judged here.
 */
export function isWin32AliasedSegment(segment: string): boolean {
  if (segment === "." || segment === "..") {
    return false;
  }
  return /[. ]$/.test(segment) || WIN32_DEVICE_NAME.test((segment.split(".")[0] ?? "").trimEnd());
}

/**
 * The closed grammar on every platform. On Windows two more rules keep one name one directory: Win32 drops trailing
 * dots from a path segment, so `tool.` would open `tool`, and device names open a device instead of a directory.
 * The grammar already excludes upper case, spaces, colons and separators, the other ways Win32 can alias a segment.
 */
function assertAppName(appName: unknown, platform: NodeJS.Platform): asserts appName is string {
  if (typeof appName !== "string" || !APP_NAME_PATTERN.test(appName)) {
    throw new InvalidAppNameError(appName);
  }
  if (platform === "win32" && isWin32AliasedSegment(appName)) {
    throw new InvalidAppNameError(
      appName,
      "on Windows it cannot end with a dot or be a device name (con, prn, aux, nul, com0-9, lpt0-9), with or without an extension",
    );
  }
}

/** UNC server names that are not a server: `\\.\` and `\\?\` are device and extended-length prefixes. */
const NON_SERVER_SEGMENTS = new Set(["", ".", "..", "?"]);
const NON_SHARE_SEGMENTS = new Set(["", ".", ".."]);

/**
 * A usable Windows root, for environment values and the home directory alike: drive-absolute (`C:\` or `C:/`), or
 * UNC `\\server\share[\...]` with a real server and share segment. Rooted-but-driveless (`\dir`), drive-relative
 * (`C:dir`), incomplete UNC (`\\server`) and device or extended-length paths (`\\.\pipe`, `\\?\C:\`, `\\?\UNC\...`)
 * are not.
 */
export function isAbsoluteWin32(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return true;
  }
  if (!/^[\\/]{2}/.test(value)) {
    return false;
  }
  const [server = "", share = ""] = value.slice(2).split(/[\\/]/);
  return !NON_SERVER_SEGMENTS.has(server) && !NON_SHARE_SEGMENTS.has(share);
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
 * Validates `appName` and returns a resolver for its directories. The home directory is read and validated only
 * when a requested directory needs a default, so absolute environment values resolve even when the home directory
 * is unavailable or not absolute.
 */
export function appDirResolver(appName: string, options: AppPathsOptions = {}): (kind: AppDirKind) => string {
  const platform = options.platform ?? process.platform;
  assertAppName(appName, platform);
  const env = options.env ?? process.env;
  const isAbsolute = platform === "win32" ? isAbsoluteWin32 : posix.isAbsolute;
  let home: string | undefined;
  const homeDir = (): string => {
    if (home === undefined) {
      const candidate = options.homedir ?? osHomedir();
      if (!isAbsolute(candidate)) {
        throw new InvalidHomeDirectoryError(candidate);
      }
      home = candidate;
    }
    return home;
  };

  if (platform === "win32") {
    return (kind) => {
      if (kind === "config") {
        const roaming = absoluteEnv(env, "APPDATA", isAbsolute) ?? win32.join(homeDir(), "AppData", "Roaming");
        return win32.join(roaming, appName);
      }
      const local = absoluteEnv(env, "LOCALAPPDATA", isAbsolute) ?? win32.join(homeDir(), "AppData", "Local");
      return win32.join(local, appName, kind === "state" ? "State" : "Cache");
    };
  }

  const xdg = {
    config: ["XDG_CONFIG_HOME", ".config"],
    state: ["XDG_STATE_HOME", ".local/state"],
    cache: ["XDG_CACHE_HOME", ".cache"],
  } as const;
  return (kind) => {
    const [variable, fallback] = xdg[kind];
    const base = absoluteEnv(env, variable, isAbsolute) ?? posix.join(homeDir(), fallback);
    return posix.join(base, appName);
  };
}
