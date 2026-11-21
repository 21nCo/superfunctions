import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  appConfigFile,
  InvalidStoreOptionsError,
  joinStoreFile,
  pathModuleFor,
  type StoreAppPathsOptions,
} from "./store-options.js";

export { InvalidStoreOptionsError };

export interface ProjectConfigStore<TConfig extends Record<string, unknown> = Record<string, unknown>> {
  readonly path: string;
  read(): TConfig;
  write(next: TConfig): void;
  get<TKey extends keyof TConfig>(key: TKey): TConfig[TKey] | undefined;
  set<TKey extends string, TValue>(key: TKey, value: TValue): void;
}

export class InvalidConfigError extends Error {
  readonly filePath: string;
  readonly code = "CLIFN_INVALID_CONFIG";

  constructor(filePath: string, detail: string) {
    super(`Invalid config at ${filePath}: ${detail}`);
    this.name = "InvalidConfigError";
    this.filePath = filePath;
  }
}

const DEFAULT_CONFIG_PATH = join(process.cwd(), "conduct.config.json");

function parseConfig<TConfig extends Record<string, unknown>>(path: string): TConfig {
  if (!existsSync(path)) {
    return {} as TConfig;
  }

  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) {
    return {} as TConfig;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new InvalidConfigError(path, "config root must be a JSON object");
    }
    return parsed as TConfig;
  } catch (error) {
    if (error instanceof InvalidConfigError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "unknown parse error";
    throw new InvalidConfigError(path, message);
  }
}

/**
 * - `{ appName, fileName? }`: `<config>/<fileName>` from `resolveAppPaths(appName)` on the current platform (default
 *   `config.json`), passing `env` and `homedir` through; directories it creates get mode `0o700` on POSIX.
 * - `{ cwd?, fileName }`: a project-local file, `fileName` resolved against `cwd` (default `process.cwd()` at call time).
 * - `{ path }`: the same as passing the path string.
 *
 * `fileName` is relative and stays inside its directory (subdirectories allowed, no `..` escape).
 */
export type ProjectConfigOptions =
  | ({ appName: string; fileName?: string; path?: never; cwd?: never } & StoreAppPathsOptions)
  | { cwd?: string; fileName: string; appName?: never; path?: never }
  | { path: string; appName?: never; cwd?: never; fileName?: never };

interface ConfigTarget {
  path: string;
  dirMode?: number;
}

function resolveConfigTarget(pathOrOptions: string | ProjectConfigOptions | undefined): ConfigTarget {
  if (pathOrOptions === undefined) {
    return { path: DEFAULT_CONFIG_PATH };
  }
  if (typeof pathOrOptions !== "object" || pathOrOptions === null) {
    // A string, and any other non-object a JavaScript caller passes, is used as the path exactly as before 0.3.0.
    return { path: pathOrOptions as string };
  }
  const options = pathOrOptions as Record<string, unknown>;
  const has = (key: string) => options[key] !== undefined;
  if (has("appName") && has("path")) {
    throw new InvalidStoreOptionsError("pass exactly one of appName or path");
  }
  if (has("cwd") && (has("appName") || has("path"))) {
    throw new InvalidStoreOptionsError("cwd only combines with fileName");
  }
  if (has("appName")) {
    const fileName = has("fileName") ? options.fileName : "config.json";
    return { path: appConfigFile(options.appName as string, fileName, options), dirMode: 0o700 };
  }
  if (has("path")) {
    if (has("fileName")) {
      throw new InvalidStoreOptionsError("fileName cannot be combined with path");
    }
    if (typeof options.path !== "string") {
      throw new InvalidStoreOptionsError("path must be a string");
    }
    return { path: options.path };
  }
  if (!has("fileName")) {
    throw new InvalidStoreOptionsError("pass appName, path, or fileName (with an optional cwd)");
  }
  if (has("cwd") && (typeof options.cwd !== "string" || options.cwd.length === 0)) {
    throw new InvalidStoreOptionsError("cwd must be a non-empty string");
  }
  const base = resolve(typeof options.cwd === "string" ? options.cwd : process.cwd());
  return { path: joinStoreFile(base, options.fileName, pathModuleFor(undefined)) };
}

/**
 * A path string or `ProjectConfigOptions`. Without an argument the store keeps the Conduct default
 * `conduct.config.json` in the working directory at import time (D2).
 */
export function createProjectConfig<TConfig extends Record<string, unknown> = Record<string, unknown>>(
  pathOrOptions?: string | ProjectConfigOptions,
): ProjectConfigStore<TConfig> {
  const { path, dirMode } = resolveConfigTarget(pathOrOptions);
  const mkdirOptions = dirMode === undefined ? { recursive: true } : { recursive: true, mode: dirMode };
  return {
    path,
    read(): TConfig {
      return parseConfig<TConfig>(path);
    },
    write(next: TConfig): void {
      mkdirSync(dirname(path), mkdirOptions);
      writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    },
    get<TKey extends keyof TConfig>(key: TKey): TConfig[TKey] | undefined {
      const parsed = parseConfig<TConfig>(path);
      return parsed[key];
    },
    set<TKey extends string, TValue>(key: TKey, value: TValue): void {
      const parsed = parseConfig<Record<string, unknown>>(path);
      parsed[key] = value;
      mkdirSync(dirname(path), mkdirOptions);
      writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    },
  };
}
