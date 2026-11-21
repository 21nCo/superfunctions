import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, lstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import ini from "ini";
import { APP_FORM_KEYS, appConfigFile, InvalidStoreOptionsError, selectStoreForm, type StoreAppPathsOptions } from "./store-options.js";

export { InvalidStoreOptionsError };

export interface CredentialProfile {
  backend: string;
  key: string;
}

export interface CredentialStore {
  readonly path: string;
  getProfile(name: string): CredentialProfile;
  setProfile(name: string, profile: CredentialProfile): void;
  hasProfile(name: string): boolean;
  listProfiles(): string[];
  removeProfile(name: string): void;
}

export class MissingProfileError extends Error {
  readonly profile: string;
  readonly filePath: string;
  readonly code = "CLIFN_MISSING_PROFILE";

  constructor(profile: string, filePath: string) {
    super(`Profile "${profile}" was not found in credentials file: ${filePath}`);
    this.name = "MissingProfileError";
    this.profile = profile;
    this.filePath = filePath;
  }
}

const DEFAULT_CREDENTIALS_PATH = join(homedir(), ".conduct", "credentials");

function readProfiles(path: string): Record<string, CredentialProfile> {
  if (!existsSync(path)) {
    return Object.create(null);
  }

  if (lstatSync(path).isSymbolicLink()) throw new Error("CLIFN_CREDENTIAL_SYMLINK");
  const raw = readFileSync(path, "utf8");
  const parsed = ini.parse(raw) as Record<string, unknown>;
  const out: Record<string, CredentialProfile> = Object.create(null);

  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.backend === "string" && typeof candidate.key === "string") {
      out[name] = {
        backend: candidate.backend,
        key: candidate.key,
      };
    }
  }

  return out;
}

function writeProfiles(path: string, profiles: Record<string, CredentialProfile>): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const serialized = ini.stringify(profiles);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, serialized, 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** Exclusive read-modify-write lock. A crashed writer leaves a detectable lock, never lost updates. */
function mutateProfiles(path: string, change: (profiles: Record<string, CredentialProfile>) => void): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try { fd = openSync(`${path}.lock`, 'wx', 0o600); }
  catch (cause) { throw new Error('CLIFN_CREDENTIAL_STORE_BUSY', { cause }); }
  try { const profiles = readProfiles(path); change(profiles); writeProfiles(path, profiles); }
  finally { closeSync(fd); unlinkSync(`${path}.lock`); }
}

/**
 * `{ appName }` stores credentials at `<config>/credentials` from `resolveAppPaths(appName)` on the current platform,
 * passing `env` and `homedir` through. `{ path }` is the same as passing the path string. Only own properties are
 * read (enumerable or not), once. `appName` or `path` must be a string; `env` or `homedir` set to `undefined` takes its
 * default. A key of another form or an unknown key throws `InvalidStoreOptionsError`.
 */
export type CredentialStoreOptions =
  | ({ appName: string; path?: never } & StoreAppPathsOptions)
  | { path: string; appName?: never };

function resolveCredentialsPath(pathOrOptions: string | CredentialStoreOptions | undefined): string {
  if (pathOrOptions === undefined) {
    return DEFAULT_CREDENTIALS_PATH;
  }
  if (typeof pathOrOptions !== "object" || pathOrOptions === null) {
    // A string, and any other non-object a JavaScript caller passes, is used as the path exactly as before 0.3.0.
    return pathOrOptions as string;
  }
  const { form, options } = selectStoreForm(pathOrOptions, [
    { form: "app", selector: "appName", allowed: APP_FORM_KEYS },
    { form: "path", selector: "path", allowed: ["path"] },
  ]);
  return form === "path" ? (options.path as string) : appConfigFile(options, "credentials");
}

/**
 * A path string, `{ path }`, or `{ appName }` (see `CredentialStoreOptions`). Without an argument the store keeps
 * the Conduct default `~/.conduct/credentials` (D2).
 */
export function createCredentialStore(pathOrOptions?: string | CredentialStoreOptions): CredentialStore {
  const path = resolveCredentialsPath(pathOrOptions);
  return {
    path,
    getProfile(name: string): CredentialProfile {
      const profiles = readProfiles(path);
      const profile = profiles[name];
      if (!profile) {
        throw new MissingProfileError(name, path);
      }
      return profile;
    },
    setProfile(name: string, profile: CredentialProfile): void {
      if (!name || ["__proto__", "constructor", "prototype"].includes(name)) throw new Error("CLIFN_INVALID_PROFILE_NAME");
      mutateProfiles(path, profiles => { Object.defineProperty(profiles, name, { value: profile, enumerable: true, configurable: true, writable: true }); });
    },
    hasProfile(name: string): boolean {
      const profiles = readProfiles(path);
      return Boolean(profiles[name]);
    },
    listProfiles(): string[] {
      const profiles = readProfiles(path);
      return Object.keys(profiles);
    },
    removeProfile(name: string): void {
      mutateProfiles(path, profiles => { delete profiles[name]; });
    },
  };
}
