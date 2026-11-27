import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";

const DEFAULT_CANDIDATES = [
  "config.ts",
  "config.js",
  "config.mjs",
  "config.cjs",
  "config.json",
] as const;

const SUPPORTED_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".json"]);

/** Extensions the loader runs as code (TS through Jiti, the rest through `import()`). */
const EXECUTABLE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);

/**
 * How `loadConfig` treats config files that run code.
 *
 * - `"executable"` (the default, unchanged): discovery and explicit paths load TS, JS, MJS, CJS and JSON.
 * - `"data-only"`: discovery considers only `.json` candidates, and an explicit TS, JS, MJS or CJS path is rejected
 *   with `CLIFN_CONFIG_UNTRUSTED` before it is imported unless `trustExecutableConfig` is `true`.
 */
export type ConfigLoaderPolicy = "executable" | "data-only";

export type ConfigLoaderErrorCode =
  | "CLIFN_CONFIG_INVALID"
  | "CLIFN_CONFIG_NOT_FOUND"
  | "CLIFN_CONFIG_UNSUPPORTED"
  | "CLIFN_CONFIG_UNTRUSTED";

export class ConfigLoaderError extends Error {
  readonly code: ConfigLoaderErrorCode;

  constructor(code: ConfigLoaderErrorCode, message: string) {
    super(message);
    this.name = "ConfigLoaderError";
    this.code = code;
  }
}

export interface ConfigLoaderOptions<T> {
  cwd?: string;
  configPath?: string;
  candidates?: readonly string[];
  exportNames?: readonly string[];
  validate?: (value: unknown, path: string) => T;
  /** Defaults to `"executable"`. Any other value throws `CLIFN_CONFIG_INVALID` before a file is read. */
  policy?: ConfigLoaderPolicy;
  /**
   * The host's explicit, non-interactive trust signal for running an explicit `configPath` that is TS, JS, MJS or
   * CJS under the `"data-only"` policy, such as a `--trust-config` flag the user passed. Only the boolean `true`
   * trusts; the loader never prompts. Discovery stays JSON-only either way, and the `"executable"` policy ignores it.
   */
  trustExecutableConfig?: boolean;
}

export interface LoadedConfig<T> {
  config: T;
  path: string;
}

function isRemotePath(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function ensureLocalPath(value: string): void {
  if (isRemotePath(value)) {
    throw new ConfigLoaderError("CLIFN_CONFIG_NOT_FOUND", "Remote config URLs are not supported.");
  }
}

function resolvePolicy(value: unknown): ConfigLoaderPolicy {
  if (value === undefined || value === "executable") {
    return "executable";
  }
  if (value === "data-only") {
    return "data-only";
  }
  throw new ConfigLoaderError(
    "CLIFN_CONFIG_INVALID",
    'Unknown config loader policy. Use "executable" or "data-only".'
  );
}

function configExtension(value: string): string {
  return path.extname(value).toLowerCase();
}

function untrustedExplicitConfig(configPath: string): ConfigLoaderError {
  return new ConfigLoaderError(
    "CLIFN_CONFIG_UNTRUSTED",
    `Refusing to run executable config ${configPath}: the data-only config policy loads JSON only. ` +
      "Use a .json config, or rerun with the CLI's explicit trust option to run this file."
  );
}

function untrustedDiscoveredConfig(candidate: string): ConfigLoaderError {
  return new ConfigLoaderError(
    "CLIFN_CONFIG_UNTRUSTED",
    `Found executable config ${candidate} but the data-only config policy loads JSON only. ` +
      "Convert it to a .json config, or pass it as the explicit config path with the CLI's explicit trust option."
  );
}

function resolveCandidates(
  configPath: string | undefined,
  customCandidates: readonly string[] | undefined
): readonly string[] {
  if (configPath) {
    return [configPath];
  }

  const candidates = customCandidates && customCandidates.length > 0 ? [...customCandidates] : [...DEFAULT_CANDIDATES];
  if (candidates.length > 32) {
    throw new ConfigLoaderError("CLIFN_CONFIG_INVALID", "Config candidate list exceeds the limit of 32 entries.");
  }
  return candidates;
}

async function resolveConfigValue(value: unknown): Promise<unknown> {
  const resolved = typeof value === "function" ? value() : value;
  return await Promise.resolve(resolved);
}

function resolveExportValue(moduleValue: unknown, exportNames: readonly string[]): unknown {
  if (moduleValue && typeof moduleValue === "object") {
    const record = moduleValue as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    const looksLikeModuleWrapper = record.__esModule === true || prototype === null || prototype !== Object.prototype;

    if (!looksLikeModuleWrapper) {
      return moduleValue;
    }

    if (record.default !== undefined) {
      return record.default;
    }

    for (const exportName of exportNames) {
      if (record[exportName] !== undefined) {
        return record[exportName];
      }
    }
  }

  return moduleValue;
}

async function loadJsonConfig(resolvedPath: string): Promise<unknown> {
  try {
    const raw = await readFile(resolvedPath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON config";
    throw new ConfigLoaderError("CLIFN_CONFIG_INVALID", message);
  }
}

async function loadModuleConfig(resolvedPath: string): Promise<unknown> {
  const extension = path.extname(resolvedPath).toLowerCase();

  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new ConfigLoaderError(
      "CLIFN_CONFIG_UNSUPPORTED",
      `Unsupported config extension: ${extension || "<none>"}`
    );
  }

  if (extension === ".json") {
    return loadJsonConfig(resolvedPath);
  }

  if (extension === ".ts") {
    const jiti = createJiti(path.dirname(resolvedPath), {
      moduleCache: false,
      interopDefault: false,
      extensions: [".ts", ".js", ".mjs", ".cjs", ".json"],
    });
    return await jiti.import(resolvedPath);
  }

  return import(pathToFileURL(resolvedPath).href);
}

export function defineConfig<T>(config: T): T {
  return config;
}

export async function loadConfig<T>(options: ConfigLoaderOptions<T> = {}): Promise<LoadedConfig<T>> {
  const dataOnly = resolvePolicy(options.policy) === "data-only";
  // Read once, so the path that decides trust is the path that is loaded.
  const configPath = options.configPath;
  const trusted = options.trustExecutableConfig === true;
  const cwd = options.cwd ?? process.cwd();
  const candidates = resolveCandidates(configPath, options.candidates);
  const exportNames = options.exportNames ?? [];
  let skippedExecutable: string | undefined;

  for (const candidate of candidates) {
    ensureLocalPath(candidate);

    const resolvedPath = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
    // Classified by the same extension `loadModuleConfig` dispatches on, before the file is checked or imported.
    const extension = configExtension(resolvedPath);
    const executable = dataOnly && EXECUTABLE_EXTENSIONS.has(extension);
    if (executable && configPath && !trusted) {
      throw untrustedExplicitConfig(configPath);
    }

    // Data-only discovery considers only JSON; an executable candidate is only checked for, to name it in the error.
    if (dataOnly && !configPath && extension !== ".json") {
      if (executable && existsSync(resolvedPath)) {
        skippedExecutable ??= candidate;
      }
      continue;
    }

    if (!existsSync(resolvedPath)) {
      continue;
    }

    try {
      const loadedModule = await loadModuleConfig(resolvedPath);
      const configValue = await resolveConfigValue(resolveExportValue(loadedModule, exportNames));
      const validated = options.validate ? options.validate(configValue, resolvedPath) : (configValue as T);
      return {
        config: validated,
        path: resolvedPath,
      };
    } catch (error) {
      if (error instanceof ConfigLoaderError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : `Config loading failed for ${resolvedPath}`;
      throw new ConfigLoaderError("CLIFN_CONFIG_INVALID", message);
    }
  }

  if (configPath) {
    throw new ConfigLoaderError("CLIFN_CONFIG_NOT_FOUND", `Config file not found: ${configPath}`);
  }

  if (skippedExecutable !== undefined) {
    throw untrustedDiscoveredConfig(skippedExecutable);
  }

  const checked = dataOnly
    ? candidates.filter((candidate) => configExtension(path.resolve(cwd, candidate)) === ".json")
    : candidates;
  throw new ConfigLoaderError(
    "CLIFN_CONFIG_NOT_FOUND",
    checked.length > 0
      ? `Config file not found. Checked: ${checked.join(", ")}`
      : "Config file not found. The data-only config policy checks only .json candidates, and none were given."
  );
}
