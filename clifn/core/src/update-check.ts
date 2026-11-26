import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureAppDir, resolveAppPaths } from "./paths.js";
import { resolveTerminal, type TerminalStream } from "./terminal.js";
import { compareParsedVersions, parseVersion, type ParsedVersion } from "./version.js";

/** The part of a fetch response the update check reads. A WHATWG `Response` fits. */
export interface UpdateCheckResponse {
  readonly status: number;
  readonly body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export interface UpdateCheckRequestInit {
  method: "GET";
  headers: Record<string, string>;
  signal: AbortSignal;
}

/** A `fetch` the check calls once per request; `globalThis.fetch` fits. */
export type UpdateCheckFetch = (url: string, init: UpdateCheckRequestInit) => Promise<UpdateCheckResponse>;

/** The streams and output mode the terminal rules read; each stream defaults to the process stream. */
export interface UpdateCheckTerminal {
  stdin?: TerminalStream;
  stdout?: TerminalStream;
  stderr?: TerminalStream;
  /** JSON output: the check is skipped. */
  json?: boolean;
}

export interface UpdateCheckOptions {
  /** The npm package name, such as `my-cli` or `@scope/my-cli`. */
  name: string;
  /** The running version; outside the version grammar the check is skipped. */
  currentVersion: string;
  /** Selects the cache directory (`resolveAppPaths(appName).state`) and the `<APP>_NO_UPDATE_CHECK` variable. */
  appName: string;
  /** Minimum time between registry requests. Defaults to 24 hours. */
  intervalMs?: number;
  /** Bound on the whole check, counted from the start. Defaults to 1,500 ms. */
  timeoutMs?: number;
  /** Defaults to an `https:` `npm_config_registry` / `NPM_CONFIG_REGISTRY`, else `https://registry.npmjs.org`. */
  registryUrl?: string;
  /** Defaults to `globalThis.fetch`. */
  fetch?: UpdateCheckFetch;
  /** Milliseconds since the epoch. Defaults to `Date.now`. */
  now?: () => number;
  /** Defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  terminal?: UpdateCheckTerminal;
}

export interface UpdateCheck {
  /**
   * The notice (`Update available: 1.2.0 → 1.3.0 (npm i -g my-cli)`), or `null`. Never rejects and never waits past
   * the check's timeout: a result that is not ready by then is dropped.
   */
  notice(): Promise<string | null>;
}

/** What the cache file holds. */
type CacheEntry = { checkedAt: number; latest: string } | { checkedAt: number; error: true };

export const UPDATE_CHECK_FILE = "update-check.json";
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** Temporary files a write leaves behind are removed by a later write once they are this old. */
const STALE_TEMPORARY_MS = 60 * 60 * 1000;
/** A dist-tags document is a few hundred bytes; a larger body is treated as garbage. */
const MAX_BODY_BYTES = 64 * 1024;
const TEMPORARY_FILE = /^update-check\.json\.[0-9A-Za-z-]+\.tmp$/;

const NO_NOTICE: UpdateCheck = Object.freeze({ notice: () => Promise.resolve(null) });

/** Set means present and not empty. */
function isSet(env: Readonly<Record<string, string | undefined>>, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value !== "";
}

/** `<APP>_NO_UPDATE_CHECK`: the app name upper-cased with `-` and `.` replaced by `_`. */
export function updateCheckOptOutVariable(appName: string): string {
  return `${appName.toUpperCase().replace(/[-.]/g, "_")}_NO_UPDATE_CHECK`;
}

function validDuration(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function httpsRegistry(value: string | undefined): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  try {
    return new URL(value).protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `<registry>/-/package/<name>/dist-tags`, with a scoped name sent as `@scope%2Fname`; null for an unusable URL. */
function distTagsUrl(registry: string, name: string): string | null {
  let base: URL;
  try {
    base = new URL(registry);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    return null;
  }
  const encoded = name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
  const path = base.pathname.replace(/\/+$/, "");
  return `${base.origin}${path}/-/package/${encoded}/dist-tags`;
}

function noticeFor(entry: CacheEntry, current: ParsedVersion, currentText: string, name: string): string | null {
  if ("error" in entry) {
    return null;
  }
  const latest = parseVersion(entry.latest);
  if (!latest || latest.prerelease.length > 0 || compareParsedVersions(latest, current) <= 0) {
    return null;
  }
  return `Update available: ${currentText} → ${entry.latest} (npm i -g ${name})`;
}

/** A cache entry from file text; anything else (missing, unreadable, malformed) is never checked. */
function parseCacheEntry(text: string): CacheEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const checkedAt = record.checkedAt;
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) {
    return null;
  }
  if (record.error === true) {
    return { checkedAt, error: true };
  }
  return typeof record.latest === "string" && parseVersion(record.latest) ? { checkedAt, latest: record.latest } : null;
}

async function readCache(file: string): Promise<CacheEntry | null> {
  try {
    return parseCacheEntry(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

/** Removes temporary files of interrupted writes that are older than one hour. Best effort. */
async function removeStaleTemporaryFiles(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TEMPORARY_MS;
  await Promise.all(
    names
      .filter((name) => TEMPORARY_FILE.test(name))
      .map(async (name) => {
        const file = join(dir, name);
        try {
          const info = await lstat(file);
          if (info.isFile() && info.mtimeMs < cutoff) {
            await rm(file, { force: true });
          }
        } catch {
          // Another instance removed it first, or it cannot be read; either way it is not ours to report.
        }
      })
  );
}

/** Writes the entry to a unique temporary file in `dir` and renames it over the cache file. */
async function writeCache(dir: string, entry: CacheEntry): Promise<void> {
  await ensureAppDir(dir);
  await removeStaleTemporaryFiles(dir);
  const temporary = join(dir, `${UPDATE_CHECK_FILE}.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, join(dir, UPDATE_CHECK_FILE));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

/** Reads at most MAX_BODY_BYTES of the body; a larger body is an error. */
async function readBody(response: UpdateCheckResponse): Promise<string> {
  const body = response.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response body too large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const text = await response.text();
  if (typeof text !== "string" || text.length > MAX_BODY_BYTES) {
    throw new Error("response body too large");
  }
  return text;
}

/** `latest` from the dist-tags document, or null for anything else. */
function latestFrom(text: string): string | null {
  const document: unknown = JSON.parse(text);
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return null;
  }
  const latest = Object.prototype.hasOwnProperty.call(document, "latest")
    ? (document as Record<string, unknown>).latest
    : undefined;
  return typeof latest === "string" && parseVersion(latest) ? latest : null;
}

interface RequestPlan {
  url: string;
  fetch: UpdateCheckFetch;
  now: () => number;
  remainingMs: () => number;
}

/** One registry request, bounded by the remaining timeout even when `fetch` ignores its signal. */
async function requestLatest(plan: RequestPlan): Promise<CacheEntry> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, plan.remainingMs()));
  const aborted = abortRejection(controller.signal);
  aborted.catch(() => undefined);
  try {
    const response = await Promise.race([
      plan.fetch(plan.url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      }),
      aborted,
    ]);
    if (response.status !== 200) {
      await Promise.resolve(response.body?.cancel?.()).catch(() => undefined);
      return { checkedAt: plan.now(), error: true };
    }
    const latest = latestFrom(await Promise.race([readBody(response), aborted]));
    return latest === null ? { checkedAt: plan.now(), error: true } : { checkedAt: plan.now(), latest };
  } catch {
    return { checkedAt: plan.now(), error: true };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

interface CheckPlan extends RequestPlan {
  name: string;
  current: ParsedVersion;
  currentText: string;
  stateDir: string;
  intervalMs: number;
}

async function runCheck(plan: CheckPlan): Promise<string | null> {
  const file = join(plan.stateDir, UPDATE_CHECK_FILE);
  const cached = await readCache(file);
  const now = plan.now();
  if (cached && cached.checkedAt <= now && now - cached.checkedAt < plan.intervalMs) {
    return noticeFor(cached, plan.current, plan.currentText, plan.name);
  }
  const entry = await requestLatest(plan);
  try {
    await writeCache(plan.stateDir, entry);
  } catch {
    // An unwritable cache means the next run checks again; the result of this one still stands.
  }
  return noticeFor(entry, plan.current, plan.currentText, plan.name);
}

/** The request plan, or null when a skip rule (D10) applies or an option cannot be used. */
function planCheck(options: UpdateCheckOptions): CheckPlan | null {
  const { name, currentVersion, appName } = options;
  const env = options.env ?? process.env;
  const terminal = options.terminal ?? {};
  const current = parseVersion(currentVersion);
  if (!current || typeof name !== "string" || name === "" || typeof appName !== "string") {
    return null;
  }
  if (terminal.json === true) {
    return null;
  }
  if (isSet(env, "CI") || isSet(env, "NO_UPDATE_NOTIFIER") || isSet(env, updateCheckOptOutVariable(appName))) {
    return null;
  }
  const state = resolveTerminal({
    env,
    ...("stdin" in terminal ? { stdin: terminal.stdin } : {}),
    ...("stdout" in terminal ? { stdout: terminal.stdout } : {}),
    ...("stderr" in terminal ? { stderr: terminal.stderr } : {}),
  });
  if (!state.interactive) {
    return null;
  }
  const fetchFn = options.fetch ?? (globalThis.fetch as unknown as UpdateCheckFetch | undefined);
  if (typeof fetchFn !== "function") {
    return null;
  }
  const registry =
    options.registryUrl ??
    httpsRegistry(env.npm_config_registry) ??
    httpsRegistry(env.NPM_CONFIG_REGISTRY) ??
    DEFAULT_REGISTRY;
  const url = distTagsUrl(registry, name);
  if (url === null) {
    return null;
  }
  const stateDir = resolveAppPaths(appName, { env }).state;
  const now = options.now ?? Date.now;
  const timeoutMs = validDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const deadline = now() + timeoutMs;
  return {
    url,
    fetch: fetchFn,
    now,
    remainingMs: () => deadline - now(),
    name,
    current,
    currentText: currentVersion,
    stateDir,
    intervalMs: validDuration(options.intervalMs, DEFAULT_INTERVAL_MS),
  };
}

/**
 * Starts a cached, non-blocking check of the npm registry's `latest` dist-tag for `name` (D10). It never throws.
 *
 * Skipped (no request, no cache access, `notice()` resolves `null`) in JSON mode (`terminal.json`), when the terminal
 * is not interactive per `resolveTerminal`, when `CI`, `NO_UPDATE_NOTIFIER` or `<APP>_NO_UPDATE_CHECK` is set to a
 * non-empty value, and when `currentVersion` is outside the version grammar. A cached result younger than
 * `intervalMs` is used without a request. Otherwise it sends `GET <registry>/-/package/<name>/dist-tags` with
 * `Accept: application/json` and stores `{ checkedAt, latest }`, or `{ checkedAt, error: true }` for a network error,
 * a status other than 200, a body that is not JSON or has no valid `latest`, or a timeout, in
 * `<state>/update-check.json`, written atomically. A notice is given only when `latest` is a release greater than
 * `currentVersion`.
 */
export function startUpdateCheck(options: UpdateCheckOptions): UpdateCheck {
  let plan: CheckPlan | null;
  try {
    plan = planCheck(options);
  } catch {
    plan = null;
  }
  if (plan === null) {
    return NO_NOTICE;
  }

  const checkPlan = plan;
  let settled = false;
  let value: string | null = null;
  const result = runCheck(checkPlan)
    .catch(() => null)
    .then((notice) => {
      settled = true;
      value = notice;
      return notice;
    });

  return {
    notice() {
      if (settled) {
        return Promise.resolve(value);
      }
      let remaining: number;
      try {
        remaining = checkPlan.remainingMs();
      } catch {
        return Promise.resolve(null);
      }
      if (!(remaining > 0)) {
        return Promise.resolve(null);
      }
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), remaining);
        void result.then((notice) => {
          clearTimeout(timer);
          resolve(notice);
        });
      });
    },
  };
}
