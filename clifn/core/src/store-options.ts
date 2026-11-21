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

/** A value for an error message: strings quoted, anything else (BigInt, cyclic objects) by type only, so formatting never throws. */
function shown(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : `of type ${typeof value}`;
}

/** Path segments of `value`; Windows accepts both separators. */
function segmentsOf(value: string, path: typeof posix): string[] {
  return value.split(path.sep === "\\" ? /[\\/]/ : "/");
}

/**
 * The target of an object-form store must name a file: a non-empty path without NUL characters whose last segment is
 * not empty (a trailing separator), `.`, `..` or a bare Windows drive. The legacy string form is not checked.
 */
export function storeFilePath(value: string): string {
  const native = pathModuleFor(undefined);
  const last = segmentsOf(value, native).pop() ?? "";
  const bareDrive = native.sep === "\\" && /^[A-Za-z]:$/.test(last);
  if (value.includes("\0") || last === "" || last === "." || last === ".." || bareDrive) {
    throw new InvalidStoreOptionsError(`store path ${shown(value)} must name a file and contain no NUL character`);
  }
  return value;
}

/**
 * A store file name relative to its base directory. It may contain subdirectories but must stay inside the base:
 * no absolute or drive-qualified path (before or after normalization, which may keep a leading `.` segment), no `..`
 * escape, not the base itself, and on Windows no `:` (a drive or an alternate data stream) in any segment.
 */
export function joinStoreFile(base: string, fileName: unknown, path: typeof posix): string {
  if (typeof fileName !== "string" || fileName.length === 0) {
    throw new InvalidStoreOptionsError("fileName must be a non-empty string");
  }
  const normalized = path.normalize(fileName);
  const escapes = normalized === ".." || normalized.startsWith(`..${path.sep}`);
  const firstSegment = segmentsOf(normalized, path).find((segment) => segment !== ".") ?? "";
  const drive = /^[A-Za-z]:/;
  const qualified = drive.test(fileName) || drive.test(firstSegment) || (path.sep === "\\" && normalized.includes(":"));
  if (path.isAbsolute(fileName) || qualified || escapes || normalized === "." || normalized.endsWith(path.sep)) {
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

/**
 * Keys that tune the app form only. Like the other optional modifiers (`fileName` in the app form, `cwd` in the
 * project-local form), a key set to `undefined` counts as absent and takes its default, as TypeScript allows.
 */
const APP_TUNING_KEYS = ["env", "homedir", "platform"] as const;

/** Store options as read once: the own string-keyed properties (enumerable or not) in a null-prototype record. */
export type StoreOptionsSnapshot = Readonly<Record<string, unknown>>;

/**
 * Every own property descriptor is captured before any accessor runs; each getter is then called once on its captured
 * descriptor. A getter that deletes or redefines another key therefore cannot change the snapshot or expose an
 * inherited value.
 */
function ownSnapshot(value: object): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(descriptors)) {
    const descriptor = descriptors[key] as PropertyDescriptor;
    snapshot[key] = "value" in descriptor ? descriptor.value : descriptor.get?.call(value);
  }
  return snapshot;
}

/**
 * Picks the form of a store options object. The object is read once into a snapshot of its own string-keyed
 * properties, enumerable or not; inherited keys never select, conflict with or tune a store, and every later read
 * uses the snapshot. Exactly one selector must be an own key, and every own key must belong to that form. The
 * selector must be a string: set to `undefined` or to a non-string it is rejected rather than treated as absent, so
 * a malformed object never falls back to another form or to the Conduct default. Any other key of the form set to
 * `undefined` is dropped from the snapshot, so it takes its default.
 */
export function selectStoreForm<TForm extends string>(
  value: object,
  forms: readonly StoreForm<TForm>[],
  fallback?: StoreForm<TForm>,
): { form: TForm; options: StoreOptionsSnapshot } {
  const options = ownSnapshot(value);
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
  for (const key of keys) {
    if (key !== chosen.selector && options[key] === undefined) {
      delete options[key];
    }
  }
  return { form: chosen.form, options };
}

export const APP_FORM_KEYS = ["appName", ...APP_TUNING_KEYS] as const;

/**
 * `<config>/<fileName>` for `appName` on the current platform. Only the config directory is resolved, so a home
 * directory that only the state or cache default would need is never read. A JavaScript caller that passes a
 * `platform` other than `process.platform`, or a mistyped `env` or `homedir`, is rejected before any filesystem call.
 */
export function appConfigFile(options: StoreOptionsSnapshot, fileName: unknown): string {
  const { platform, env, homedir } = options;
  if (platform !== undefined && platform !== process.platform) {
    throw new InvalidStoreOptionsError(
      `platform ${shown(platform)} differs from the current platform ${JSON.stringify(process.platform)}; ` +
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
  return storeFilePath(joinStoreFile(config, fileName, pathModuleFor(undefined)));
}

/**
 * `fileName` under `cwd` (default `process.cwd()` at call time, also when `cwd` is `undefined`); a present `cwd` must
 * be a non-empty string.
 */
export function projectLocalFile(options: StoreOptionsSnapshot): string {
  const { cwd } = options;
  if (cwd !== undefined && (typeof cwd !== "string" || cwd.length === 0)) {
    throw new InvalidStoreOptionsError("cwd must be a non-empty string");
  }
  const base = resolve(cwd === undefined ? process.cwd() : cwd);
  return storeFilePath(joinStoreFile(base, options.fileName, pathModuleFor(undefined)));
}
