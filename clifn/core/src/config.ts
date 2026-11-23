import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  APP_FORM_KEYS,
  appConfigFile,
  InvalidStoreOptionsError,
  projectLocalFile,
  selectStoreForm,
  storeFilePath,
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

const defaultConfigPath = (): string => join(process.cwd(), "conduct.config.json");

/**
 * The Conduct default, captured at import as before (D2). When the working directory cannot be read at import, loading
 * the module still succeeds (so the other forms work) and the first call without an argument computes it instead.
 */
const DEFAULT_CONFIG_PATH = ((): string | undefined => {
  try {
    return defaultConfigPath();
  } catch {
    return undefined;
  }
})();

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
 * `fileName` is relative and stays inside its directory (subdirectories allowed, no `..` escape). Only own properties
 * are read (enumerable or not), once. The selector of the form (`appName`, `path`, or `fileName` for a project-local
 * file) must be a string; an optional key set to `undefined` (`fileName` with `appName`, `cwd`, `env`, `homedir`)
 * takes its default. A key of another form or an unknown key throws `InvalidStoreOptionsError`.
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
    return { path: DEFAULT_CONFIG_PATH ?? defaultConfigPath() };
  }
  if (typeof pathOrOptions !== "object" || pathOrOptions === null) {
    // A string, and any other non-object a JavaScript caller passes, is used as the path exactly as before 0.3.0.
    return { path: pathOrOptions as string };
  }
  const { form, options } = selectStoreForm(
    pathOrOptions,
    [
      { form: "app", selector: "appName", allowed: [...APP_FORM_KEYS, "fileName"] },
      { form: "path", selector: "path", allowed: ["path"] },
    ],
    { form: "local", selector: "fileName", allowed: ["cwd", "fileName"] },
  );
  if (form === "path") {
    return { path: storeFilePath(options.path as string) };
  }
  if (form === "local") {
    return { path: projectLocalFile(options) };
  }
  const fileName = options.fileName === undefined ? "config.json" : options.fileName;
  return { path: appConfigFile(options, fileName), dirMode: 0o700 };
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
