import { join } from "node:path";
import { appDirResolver } from "./app-dirs.js";
import { resolveTerminal, type TerminalStream } from "./terminal.js";
import {
  readCache,
  recordDeliveryQuietly,
  UPDATE_CHECK_FILE,
  writeCacheQuietly,
  type CacheEntry,
  type LatestEntry,
} from "./update-check-cache.js";
import { compareParsedVersions, parseVersion, type ParsedVersion } from "./version.js";

export { UPDATE_CHECK_FILE } from "./update-check-cache.js";

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
  /** Minimum time between registry requests, and between two notices. Defaults to 24 hours. */
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
   * the check's timeout: a result that is not ready by then is dropped, and every later call resolves `null` too.
   * Resolving with the notice counts as delivering it: only the first call that resolves with it gets it (later calls on
   * the same handle resolve `null`), and the time is recorded in the cache in the background (added to whatever entry
   * is there, so a newer entry another run wrote is kept, and an earlier delivery never replaces a later one). The
   * notice is dropped when the cache records a delivery within `intervalMs`: the cache is read when the check settles
   * (that read must finish before the timeout for the result to count) and, while time remains, read again at hand-out,
   * asynchronously and bounded by the remaining time (a read that does not finish in time drops the notice). When no
   * time remains, as after an action longer than the timeout, the notice is handed out on the read made when the check
   * settled, without any file access. So no run gives it once another run's delivery is recorded before its last read;
   * within one process only one handle per app gives it. Two processes that both read the cache before either delivery
   * is written (the window between a run's last read and its hand-out) may both give it: the last-rename-wins boundary
   * of concurrent instances.
   */
  notice(): Promise<string | null>;
}

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** A dist-tags document is a few hundred bytes; a larger body is treated as garbage. */
const MAX_BODY_BYTES = 64 * 1024;

const NO_NOTICE: UpdateCheck = Object.freeze({ notice: () => Promise.resolve(null) });

/** When a handle in this process last handed out a notice, per state directory, before the cache records it. */
const handedOutAt = new Map<string, number>();
/** The hand-out in progress per state directory in this process; settles `true` when it delivered the notice. */
const handingOut = new Map<string, Promise<boolean>>();

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

/** True when `time` is not in the future and less than `intervalMs` ago; a time in the future counts as stale. */
function isRecent(time: number, now: number, intervalMs: number): boolean {
  return time <= now && now - time < intervalMs;
}

/** True when the entry records a notice delivered within the interval. */
function recentlyNotified(entry: CacheEntry, now: number, intervalMs: number): boolean {
  return entry.notifiedAt !== undefined && isRecent(entry.notifiedAt, now, intervalMs);
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

/**
 * Starts cancelling a body the check does not read, without waiting: a stream whose cancel never settles (or throws)
 * must not hold the result.
 */
function discard(cancel: () => unknown): void {
  try {
    const pending = cancel();
    if (pending && typeof (pending as Promise<unknown>).then === "function") {
      (pending as Promise<unknown>).then(undefined, () => undefined);
    }
  } catch {
    // Nothing to release; the request is aborted in any case.
  }
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
        discard(() => reader.cancel());
        throw new Error("response body too large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const text = await response.text();
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
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
      discard(() => response.body?.cancel?.());
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

interface CheckResult {
  notice: string | null;
  /** The entry the notice came from, to record its delivery; null when there is no notice. */
  entry: LatestEntry | null;
  /** The cache as read when the check settled, after a refresh; its delivery is weighed at hand-out time. */
  shared?: CacheEntry | null;
}

function resultFor(plan: CheckPlan, entry: CacheEntry, now: number, shared?: CacheEntry | null): CheckResult {
  const notice = recentlyNotified(entry, now, plan.intervalMs)
    ? null
    : noticeFor(entry, plan.current, plan.currentText, plan.name);
  return { notice, entry: notice !== null && "latest" in entry ? entry : null, shared };
}

/** Settles as soon as the entry is known; the cache write it starts continues in the background. */
async function runCheck(plan: CheckPlan): Promise<CheckResult> {
  const file = join(plan.stateDir, UPDATE_CHECK_FILE);
  const cached = await readCache(file);
  const now = plan.now();
  if (cached && isRecent(cached.checkedAt, now, plan.intervalMs)) {
    return resultFor(plan, cached, now);
  }
  const fetched = await requestLatest(plan);
  // The last delivery carries over to the new entry, an error entry too, so a refresh does not give a second notice
  // within the interval; the write also keeps a later delivery another run recorded during the request.
  const entry: CacheEntry = cached?.notifiedAt === undefined ? fetched : { ...fetched, notifiedAt: cached.notifiedAt };
  void writeCacheQuietly(plan.stateDir, entry, plan.now);
  // The claim read: a delivery another run recorded during the request. The result counts only when this read, too,
  // finishes before the timeout.
  const shared = await readCache(file);
  return resultFor(plan, entry, plan.now(), shared);
}

const LATE = Symbol("late");
/** The longest delay `setTimeout` takes as given; a longer one would fire at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The promise's value, or LATE when it does not settle within `ms`. The promise must never reject. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof LATE> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(LATE), Math.min(ms, MAX_TIMER_MS));
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function monotonicNow(): number {
  return performance.now();
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
  // Only the state directory: the config and cache directories may need a home directory this check never uses.
  const stateDir = appDirResolver(appName, { env })("state");
  const now = options.now ?? Date.now;
  // The timeout runs on the injected clock when one is given, else on the monotonic clock, so a wall-clock jump
  // cannot stretch it; `now` still stamps the cache.
  const elapsedClock = options.now ?? monotonicNow;
  const timeoutMs = validDuration(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const deadline = elapsedClock() + timeoutMs;
  return {
    url,
    fetch: fetchFn,
    now,
    remainingMs: () => deadline - elapsedClock(),
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
 * `intervalMs` is used without a request, and a notice is given at most once per `intervalMs` (two processes racing
 * to hand it out may both give it; see `notice()`). Otherwise it sends `GET <registry>/-/package/<name>/dist-tags` with
 * `Accept: application/json` and stores `{ checkedAt, latest }`, or `{ checkedAt, error: true }` for a network error,
 * a status other than 200, a body that is not JSON or has no valid `latest`, or a timeout, in
 * `<state>/update-check.json`, written atomically. A notice is given only when `latest` is a release greater than
 * `currentVersion`. The result is known as soon as the registry answers; cache writes finish in the background.
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
  // "pending" until the check settles or its deadline passes, whichever comes first; the outcome never changes after.
  let outcome: "pending" | "ready" | "expired" = "pending";
  let ready: CheckResult | null = null;
  // The notice is handed out by at most one notice() call; every later call resolves null.
  let handedOut = false;
  const remaining = (): number => {
    try {
      return checkPlan.remainingMs();
    } catch {
      return 0;
    }
  };
  const result = runCheck(checkPlan)
    .catch((): CheckResult | null => null)
    .then((checked) => {
      if (outcome === "pending") {
        if (remaining() >= 0) {
          outcome = "ready";
          ready = checked;
        } else {
          outcome = "expired";
        }
      }
    });

  const clock = (): number | undefined => {
    try {
      const time = checkPlan.now();
      return Number.isFinite(time) ? time : undefined;
    } catch {
      return undefined;
    }
  };

  // Hands the notice out unless a delivery within the interval is known, and records it. While time remains the cache
  // is read again, bounded by the remaining time, and a read that finishes after the deadline is discarded; once none
  // remains the read made when the check settled stands, with no file access. The decision uses the time after that
  // read, so a delivery recorded meanwhile is not taken for one in the future.
  const handOut = async (
    checked: CheckResult,
    entry: LatestEntry,
    sampled: number,
    budget: () => number
  ): Promise<boolean> => {
    const dir = checkPlan.stateDir;
    const left = budget();
    let shared = checked.shared ?? null;
    if (left > 0) {
      const read = await within(readCache(join(dir, UPDATE_CHECK_FILE)), left);
      if (read === LATE || !(budget() >= 0)) {
        return false;
      }
      shared = read;
    }
    const notifiedAt = clock() ?? sampled;
    const previous = handedOutAt.get(dir);
    if (
      (previous !== undefined && isRecent(previous, notifiedAt, checkPlan.intervalMs)) ||
      (shared !== null && recentlyNotified(shared, notifiedAt, checkPlan.intervalMs))
    ) {
      return false;
    }
    handedOutAt.set(dir, notifiedAt);
    void recordDeliveryQuietly(dir, entry, notifiedAt, checkPlan.now);
    return true;
  };

  // The notice of an on-time result, the first time it is asked for. Hand-outs in this process run one at a time per
  // app: a handle waits, within its own time, for another handle's hand-out, then decides on its own (a delivery the
  // other made within this handle's interval suppresses it).
  const deliver = async (budget: () => number): Promise<string | null> => {
    const checked: CheckResult | null = outcome === "ready" ? ready : null;
    if (handedOut || checked === null || checked.notice === null || checked.entry === null) {
      return null;
    }
    handedOut = true;
    const sampled = clock();
    if (sampled === undefined) {
      return checked.notice;
    }
    const dir = checkPlan.stateDir;
    for (let other = handingOut.get(dir); other !== undefined; other = handingOut.get(dir)) {
      const left = budget();
      if (!(left > 0) || (await within(other, left)) === LATE) {
        return null;
      }
    }
    let settle: (delivered: boolean) => void = () => undefined;
    const mine = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    handingOut.set(dir, mine);
    let delivered = false;
    try {
      delivered = await handOut(checked, checked.entry, sampled, budget);
    } catch {
      delivered = false;
    } finally {
      if (handingOut.get(dir) === mine) {
        handingOut.delete(dir);
      }
      settle(delivered);
    }
    return delivered ? checked.notice : null;
  };

  // The time left to one notice() call: the check's remaining time, and never more than was left when the call began
  // in real time, so waits after one another (the result, another handle, the hand-out read) share one budget even when
  // an injected clock does not advance.
  const budgetFrom = (left: number): (() => number) => {
    const until = monotonicNow() + left;
    return () => Math.min(remaining(), until - monotonicNow());
  };

  return {
    notice() {
      if (outcome !== "pending") {
        return deliver(budgetFrom(remaining()));
      }
      const left = remaining();
      if (!(left > 0)) {
        outcome = "expired";
        return Promise.resolve(null);
      }
      const budget = budgetFrom(left);
      return new Promise<string | null>((resolve) => {
        let answered = false;
        const answer = (): void => {
          if (!answered) {
            answered = true;
            resolve(deliver(budget));
          }
        };
        const timer = setTimeout(() => {
          if (outcome === "pending") {
            outcome = "expired";
          }
          answer();
        }, left);
        void result.then(() => {
          clearTimeout(timer);
          answer();
        });
      });
    },
  };
}
