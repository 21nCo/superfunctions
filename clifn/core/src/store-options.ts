import { posix, resolve, win32 } from "node:path";
import { appDirResolver, type AppPathsOptions } from "./app-dirs.js";

/** Thrown when a store options object is malformed: a missing, conflicting, unknown or mistyped key, or an unsafe file name. */
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

/** One accepted shape of a store options object: the key that selects it and every key it allows. */
interface StoreForm<TForm extends string> {
  form: TForm;
  selector: string;
  allowed: readonly string[];
}

/** Keys that tune the app form only. A present key set to `undefined` counts as absent, as TypeScript allows. */
const APP_TUNING_KEYS = ["env", "homedir", "platform"] as const;

/**
 * Picks the form of a store options object from its own enumerable keys (inherited keys never select or tune a
 * store). Exactly one selector must be an own key, and every own key must belong to that form; a selector set to
 * `undefined` or to a non-string is rejected rather than treated as absent, so a malformed object never falls back
 * to another form or to the Conduct default.
 */
export function selectStoreForm<TForm extends string>(
  value: object,
  forms: readonly StoreForm<TForm>[],
  fallback?: StoreForm<TForm>,
): { form: TForm; options: Record<string, unknown> } {
  const options = value as Record<string, unknown>;
  const keys = Object.keys(options);
  const selected = forms.filter((candidate) => keys.includes(candidate.selector));
  if (selected.length > 1) {
    throw new InvalidStoreOptionsError(`pass only one of ${selected.map((candidate) => candidate.selector).join(", ")}`);
  }
  const chosen = selected[0] ?? (fallback !== undefined && keys.includes(fallback.selector) ? fallback : undefined);
  if (chosen === undefined) {
    const selectors = [...forms, ...(fallback === undefined ? [] : [fallback])].map((candidate) => candidate.selector);
    throw new InvalidStoreOptionsError(`pass one of ${selectors.join(", ")}`);
  }
  const extra = keys.filter((key) => !chosen.allowed.includes(key));
  if (extra.length > 0) {
    throw new InvalidStoreOptionsError(`${extra.join(", ")} cannot be combined with ${chosen.selector}`);
  }
  if (typeof options[chosen.selector] !== "string") {
    throw new InvalidStoreOptionsError(`${chosen.selector} must be a string`);
  }
  return { form: chosen.form, options };
}

export const APP_FORM_KEYS = ["appName", ...APP_TUNING_KEYS] as const;

/**
 * `<config>/<fileName>` for `appName` on the current platform. Only the config directory is resolved, so a home
 * directory that only the state or cache default would need is never read. A JavaScript caller that passes a
 * `platform` other than `process.platform`, or a mistyped `env` or `homedir`, is rejected before any filesystem call.
 */
export function appConfigFile(options: Record<string, unknown>, fileName: unknown): string {
  const { platform, env, homedir } = options;
  if (platform !== undefined && platform !== process.platform) {
    throw new InvalidStoreOptionsError(
      `platform ${JSON.stringify(platform)} differs from the current platform ${JSON.stringify(process.platform)}; ` +
        "stores only use paths for the current platform",
    );
  }
  if (env !== undefined && (typeof env !== "object" || env === null)) {
    throw new InvalidStoreOptionsError("env must be an object");
  }
  if (homedir !== undefined && typeof homedir !== "string") {
    throw new InvalidStoreOptionsError("homedir must be a string");
  }
  const config = appDirResolver(options.appName as string, { env: env as AppPathsOptions["env"], homedir })("config");
  return joinStoreFile(config, fileName, pathModuleFor(undefined));
}

/** `fileName` under `cwd` (default `process.cwd()` at call time); `cwd` must be a non-empty string when present. */
export function projectLocalFile(options: Record<string, unknown>): string {
  if (Object.keys(options).includes("cwd") && (typeof options.cwd !== "string" || options.cwd.length === 0)) {
    throw new InvalidStoreOptionsError("cwd must be a non-empty string");
  }
  const base = resolve(typeof options.cwd === "string" ? options.cwd : process.cwd());
  return joinStoreFile(base, options.fileName, pathModuleFor(undefined));
}
