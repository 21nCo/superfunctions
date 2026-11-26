/**
 * Request idempotency for ApiFn runtime adapters.
 *
 * A host claims an idempotency key before running a handler, settles the claim
 * with the handler's response, and replays that response when the client
 * retries. The host supplies the storage: an atomic compare-and-set store for
 * claims and, for handlers that commit a durable receipt in the same
 * transaction as their effect, a receipt source used as commit evidence.
 *
 * Invariants:
 * - Claims are scoped to principal, tenant, operation, target and key; a
 *   different scope never reads another scope's record or receipt.
 * - Every write replaces a record only when its version is unchanged, and
 *   every write gets a fresh version, so a stale holder cannot settle, clear
 *   or overwrite a newer claim.
 * - A pending claim is taken over only after its lease expires and only when
 *   the receipt source shows no commit. Without a receipt contract an expired
 *   claim is reported as indeterminate until its retention ends.
 */

import { canonicalJson } from "./canonical-json.js";

export type IdempotencyRecovery = "receipt" | "none";

/** Who and what a key applies to. Pass identifiers, never credentials. */
export interface IdempotencyScope {
  /** Authenticated principal id. Required: anonymous callers must not share keys. */
  principal: string;
  tenant?: string;
  /** Operation identity, such as an OpenAPI operationId or `POST /orders`. */
  operation: string;
  /** Resource the operation acts on, such as a path parameter. */
  target?: string;
}

export interface IdempotencyRequest {
  scope: IdempotencyScope;
  /** The client's idempotency key: 1-255 visible ASCII characters. */
  key: string;
  /** The validated request body. It must be JSON data; `undefined` means no body. */
  body?: unknown;
  /**
   * `"receipt"` declares that the handler commits a durable receipt in the
   * same transaction as its effect. It requires the `receipts` option.
   */
  recovery?: IdempotencyRecovery;
}

export interface IdempotentResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export type IdempotencyOmittedPart = "body" | "headers";

export interface StoredIdempotentResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body?: string;
  /** Parts dropped because the response exceeded `maxResponseBytes`. */
  omitted?: readonly IdempotencyOmittedPart[];
}

interface IdempotencyRecordBase {
  /** Compare-and-set token. Every write stores a fresh version. */
  version: string;
  /** Owner generation: increases each time the key is claimed again. */
  generation: number;
  fingerprint: string;
  recovery: IdempotencyRecovery;
  /** Epoch milliseconds after which the record no longer counts. */
  expiresAt: number;
}

export interface PendingIdempotencyRecord extends IdempotencyRecordBase {
  state: "pending";
  leaseExpiresAt: number;
}

export interface CompletedIdempotencyRecord extends IdempotencyRecordBase {
  state: "completed";
  response: StoredIdempotentResponse;
}

export type IdempotencyRecord = PendingIdempotencyRecord | CompletedIdempotencyRecord;

/**
 * Host-supplied atomic conditional store. `compareAndSet` must apply `next`
 * (or delete the record when `next` is null) only when the stored record's
 * `version` equals `expectedVersion`, or when no record exists and
 * `expectedVersion` is null, and report whether it wrote. Records may be
 * evicted after `expiresAt`.
 */
export interface IdempotencyStore {
  get(storeKey: string): Promise<IdempotencyRecord | null | undefined>;
  compareAndSet(storeKey: string, expectedVersion: string | null, next: IdempotencyRecord | null): Promise<boolean>;
}

/** Identity the handler records in its receipt, inside its own transaction. */
export interface IdempotencyCommit {
  readonly storeKey: string;
  readonly fingerprint: string;
  readonly generation: number;
}

/**
 * Durable commit evidence. The receipt store must accept at most one receipt
 * per `storeKey`, so a second commit for the same key fails its transaction.
 */
export interface IdempotencyReceipt extends IdempotencyCommit {
  response: IdempotentResponse;
}

export interface IdempotencyReceiptSource {
  find(storeKey: string): Promise<IdempotencyReceipt | null | undefined>;
}

export interface IdempotencyClock {
  now(): number;
}

export interface IdempotencyToken extends IdempotencyCommit {
  readonly version: string;
  readonly recovery: IdempotencyRecovery;
  readonly operation: string;
}

/** Diagnostics carry no principal, tenant, target, key, body or headers. */
export interface IdempotencyDiagnostic {
  action: "claim" | "settle" | "release" | "recover";
  outcome: string;
  operation: string;
  storeKey?: string;
  generation?: number;
}

export type IdempotencyInvalidKeyReason = "empty" | "too_long" | "characters";

export type IdempotencyReplay = {
  outcome: "replay";
  response: StoredIdempotentResponse;
  source: "store" | "receipt";
};

export type IdempotencyClaimResult =
  | { outcome: "acquired"; token: IdempotencyToken }
  | IdempotencyReplay
  | { outcome: "conflict" }
  | { outcome: "in_progress"; retryAfterMs: number }
  | { outcome: "indeterminate"; retryAfterMs: number }
  | { outcome: "invalid_key"; reason: IdempotencyInvalidKeyReason };

export type IdempotencySettleResult =
  | { outcome: "settled"; response: StoredIdempotentResponse }
  | { outcome: "stale" };

export type IdempotencyReleaseResult =
  | { outcome: "released" }
  | { outcome: "committed"; response: StoredIdempotentResponse }
  | { outcome: "stale" };

export type IdempotencyRecoverResult =
  | IdempotencyReplay
  | { outcome: "conflict" }
  | { outcome: "in_progress"; retryAfterMs: number }
  | { outcome: "not_committed" }
  | { outcome: "indeterminate"; retryAfterMs: number }
  | { outcome: "absent" }
  | { outcome: "invalid_key"; reason: IdempotencyInvalidKeyReason };

export interface RequestIdempotencyOptions {
  store: IdempotencyStore;
  /** Commit evidence for handlers that write a durable receipt. */
  receipts?: IdempotencyReceiptSource;
  /** Digest of a canonical string. Defaults to SHA-256 hex through Web Crypto. */
  fingerprint?: (canonical: string) => string | Promise<string>;
  clock?: IdempotencyClock;
  /** How long a claim holder owns the key. Default 30 seconds. */
  leaseMs?: number;
  /** How long a record counts after it is written. Default 24 hours. */
  retentionMs?: number;
  /** Upper bound for a stored response. Default 64 KiB. */
  maxResponseBytes?: number;
  /** Unique version tokens. Defaults to `crypto.randomUUID()`. */
  nonce?: () => string;
  onDiagnostic?: (event: IdempotencyDiagnostic) => void;
}

export interface RequestIdempotency {
  claim(request: IdempotencyRequest): Promise<IdempotencyClaimResult>;
  settle(token: IdempotencyToken, response: IdempotentResponse): Promise<IdempotencySettleResult>;
  release(token: IdempotencyToken): Promise<IdempotencyReleaseResult>;
  recover(request: IdempotencyRequest): Promise<IdempotencyRecoverResult>;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES_LIMIT = 16 * 1024 * 1024;
const MAX_KEY_LENGTH = 255;
const MAX_ATTEMPTS = 8;
const KEY_PATTERN = /^[\x21-\x7e]+$/;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
// Response headers that carry or set credentials are never stored or replayed.
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
]);
const SCOPE_DOMAIN = "apifn.idempotency.scope.v1";
const BODY_DOMAIN = "apifn.idempotency.body.v1";

interface WebCryptoLike {
  randomUUID?: () => string;
  subtle?: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
}

function webCrypto(): WebCryptoLike | undefined {
  return (globalThis as { crypto?: WebCryptoLike }).crypto;
}

/** SHA-256 hex digest of a string through Web Crypto. */
export async function sha256Fingerprint(canonical: string): Promise<string> {
  const subtle = webCrypto()?.subtle;
  if (!subtle) throw new TypeError("sha256Fingerprint needs Web Crypto (crypto.subtle)");
  const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function defaultNonce(): () => string {
  const crypto = webCrypto();
  const randomUUID = crypto?.randomUUID;
  if (typeof randomUUID !== "function") {
    throw new TypeError("createRequestIdempotency needs options.nonce on runtimes without crypto.randomUUID");
  }
  return () => randomUUID.call(crypto);
}

function positiveInteger(name: string, value: number | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > max) {
    throw new TypeError(`createRequestIdempotency: ${name} must be a positive integer no larger than ${max}`);
  }
  return resolved;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyProblem(key: unknown): IdempotencyInvalidKeyReason | undefined {
  if (typeof key !== "string" || key.length === 0) return "empty";
  if (key.length > MAX_KEY_LENGTH) return "too_long";
  return KEY_PATTERN.test(key) ? undefined : "characters";
}

function validateScope(scope: unknown): IdempotencyScope {
  if (!isPlainObject(scope)) throw new TypeError("idempotency scope must be an object");
  if (!nonEmptyString(scope.principal)) throw new TypeError("idempotency scope.principal must be a non-empty string");
  if (!nonEmptyString(scope.operation)) throw new TypeError("idempotency scope.operation must be a non-empty string");
  for (const field of ["tenant", "target"] as const) {
    if (scope[field] !== undefined && typeof scope[field] !== "string") {
      throw new TypeError(`idempotency scope.${field} must be a string when present`);
    }
  }
  return scope as unknown as IdempotencyScope;
}

const utf8 = new TextEncoder();

function byteLength(value: string): number {
  return utf8.encode(value).byteLength;
}

/** Validates a response and bounds what is stored for replay. */
export function normalizeIdempotentResponse(
  response: IdempotentResponse,
  maxBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
): StoredIdempotentResponse {
  if (!isPlainObject(response)) throw new TypeError("idempotent response must be an object");
  const { status, headers, body } = response;
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TypeError("idempotent response status must be an integer from 100 to 599");
  }
  if (body !== undefined && typeof body !== "string") throw new TypeError("idempotent response body must be a string");
  if (headers !== undefined && !isPlainObject(headers)) throw new TypeError("idempotent response headers must be an object");
  const kept: Record<string, string> = {};
  let headerBytes = 0;
  for (const [rawName, value] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name)) throw new TypeError("idempotent response has an invalid header name");
    if (typeof value !== "string" || /[\r\n\0]/.test(value)) {
      throw new TypeError("idempotent response header values must be single-line strings");
    }
    if (CREDENTIAL_HEADERS.has(name) || Object.hasOwn(kept, name)) continue;
    kept[name] = value;
    headerBytes += byteLength(name) + byteLength(value) + 4;
  }
  const bodyBytes = body === undefined ? 0 : byteLength(body);
  if (headerBytes + bodyBytes <= maxBytes) {
    return body === undefined ? { status, headers: kept } : { status, headers: kept, body };
  }
  if (headerBytes <= maxBytes) return { status, headers: kept, omitted: ["body"] };
  return { status, headers: {}, omitted: ["body", "headers"] };
}

function isStoredResponse(value: unknown): value is StoredIdempotentResponse {
  if (!isPlainObject(value) || !Number.isInteger(value.status) || !isPlainObject(value.headers)) return false;
  if (!Object.values(value.headers).every((header) => typeof header === "string")) return false;
  if (value.body !== undefined && typeof value.body !== "string") return false;
  return (
    value.omitted === undefined ||
    (Array.isArray(value.omitted) && value.omitted.every((part) => part === "body" || part === "headers"))
  );
}

function isRecord(value: unknown): value is IdempotencyRecord {
  if (!isPlainObject(value)) return false;
  const base =
    nonEmptyString(value.version) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) > 0 &&
    nonEmptyString(value.fingerprint) &&
    (value.recovery === "receipt" || value.recovery === "none") &&
    finiteNumber(value.expiresAt);
  if (!base) return false;
  if (value.state === "pending") return finiteNumber(value.leaseExpiresAt);
  return value.state === "completed" && isStoredResponse(value.response);
}

function isToken(value: unknown): value is IdempotencyToken {
  return (
    isPlainObject(value) &&
    nonEmptyString(value.storeKey) &&
    nonEmptyString(value.version) &&
    nonEmptyString(value.fingerprint) &&
    nonEmptyString(value.operation) &&
    Number.isSafeInteger(value.generation) &&
    (value.recovery === "receipt" || value.recovery === "none")
  );
}

type Live =
  | { kind: "absent"; expectedVersion: string | null; previousGeneration: number }
  | { kind: "present"; record: IdempotencyRecord };

export function createRequestIdempotency(options: RequestIdempotencyOptions): RequestIdempotency {
  if (!isPlainObject(options)) throw new TypeError("createRequestIdempotency needs an options object");
  const { store, receipts, onDiagnostic } = options;
  if (!store || typeof store.get !== "function" || typeof store.compareAndSet !== "function") {
    throw new TypeError("createRequestIdempotency: store must provide get and compareAndSet");
  }
  if (receipts !== undefined && typeof receipts?.find !== "function") {
    throw new TypeError("createRequestIdempotency: receipts must provide find");
  }
  const leaseMs = positiveInteger("leaseMs", options.leaseMs, DEFAULT_LEASE_MS);
  const retentionMs = positiveInteger("retentionMs", options.retentionMs, DEFAULT_RETENTION_MS);
  if (retentionMs < leaseMs) throw new TypeError("createRequestIdempotency: retentionMs must be at least leaseMs");
  const maxResponseBytes = positiveInteger(
    "maxResponseBytes",
    options.maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES_LIMIT,
  );
  const digest = options.fingerprint ?? sha256Fingerprint;
  const nonce = options.nonce ?? defaultNonce();
  const clock = options.clock ?? { now: () => Date.now() };

  const now = (): number => {
    const value = clock.now();
    if (!finiteNumber(value)) throw new TypeError("idempotency clock.now() must return a finite number");
    return value;
  };

  const nextVersion = (): string => {
    const value = nonce();
    if (!nonEmptyString(value)) throw new TypeError("idempotency nonce() must return a non-empty string");
    return value;
  };

  const fingerprintOf = async (value: unknown): Promise<string> => {
    const result = await digest(canonicalJson(value));
    if (!nonEmptyString(result)) throw new TypeError("idempotency fingerprint must return a non-empty string");
    return result;
  };

  const emit = (event: IdempotencyDiagnostic): void => {
    try {
      onDiagnostic?.(event);
    } catch {
      // Diagnostics never change an idempotency outcome.
    }
  };

  const recoveryOf = (request: IdempotencyRequest): IdempotencyRecovery => {
    const recovery = request.recovery ?? "none";
    if (recovery !== "receipt" && recovery !== "none") throw new TypeError('idempotency recovery must be "receipt" or "none"');
    if (recovery === "receipt" && !receipts) {
      throw new TypeError('idempotency recovery "receipt" needs a receipts source with durable commit evidence');
    }
    return recovery;
  };

  const readLive = async (storeKey: string, at: number): Promise<Live> => {
    const stored = await store.get(storeKey);
    if (stored === undefined || stored === null) return { kind: "absent", expectedVersion: null, previousGeneration: 0 };
    if (!isRecord(stored)) throw new Error("idempotency store returned a malformed record");
    if (stored.expiresAt <= at) {
      return { kind: "absent", expectedVersion: stored.version, previousGeneration: stored.generation };
    }
    return { kind: "present", record: stored };
  };

  const findReceipt = async (storeKey: string): Promise<IdempotencyReceipt | undefined> => {
    if (!receipts) return undefined;
    const receipt = await receipts.find(storeKey);
    if (receipt === undefined || receipt === null) return undefined;
    if (!isPlainObject(receipt) || !nonEmptyString(receipt.fingerprint) || !Number.isSafeInteger(receipt.generation)) {
      throw new Error("idempotency receipt source returned a malformed receipt");
    }
    if (receipt.storeKey !== storeKey) {
      throw new Error("idempotency receipt source returned a receipt for a different key");
    }
    return receipt;
  };

  /** Records a receipt's response as the completed result, if `expectedVersion` still holds. */
  const completeFromReceipt = async (
    storeKey: string,
    expectedVersion: string | null,
    generation: number,
    receipt: IdempotencyReceipt,
  ): Promise<StoredIdempotentResponse | undefined> => {
    const response = normalizeIdempotentResponse(receipt.response, maxResponseBytes);
    const written = await store.compareAndSet(storeKey, expectedVersion, {
      state: "completed",
      version: nextVersion(),
      generation: Math.max(generation, receipt.generation, 1),
      fingerprint: receipt.fingerprint,
      recovery: "receipt",
      response,
      expiresAt: now() + retentionMs,
    });
    return written ? response : undefined;
  };

  const scopeKey = (scope: IdempotencyScope, key: string): Promise<string> =>
    fingerprintOf([SCOPE_DOMAIN, scope.tenant ?? null, scope.principal, scope.operation, scope.target ?? null, key]);

  type Prepared = { storeKey: string; fingerprint: string; recovery: IdempotencyRecovery; operation: string };
  type InvalidKey = { invalid: { outcome: "invalid_key"; reason: IdempotencyInvalidKeyReason }; operation: string };

  const prepare = async (request: IdempotencyRequest): Promise<Prepared | InvalidKey> => {
    if (!isPlainObject(request)) throw new TypeError("idempotency request must be an object");
    const scope = validateScope(request.scope);
    const recovery = recoveryOf(request);
    const reason = keyProblem(request.key);
    if (reason) return { invalid: { outcome: "invalid_key", reason }, operation: scope.operation };
    const [storeKey, fingerprint] = await Promise.all([
      scopeKey(scope, request.key),
      fingerprintOf([BODY_DOMAIN, request.body === undefined ? null : request.body]),
    ]);
    return { storeKey, fingerprint, recovery, operation: scope.operation };
  };

  const retryAfter = (until: number, at: number): number => Math.max(1, Math.ceil(until - at));

  /**
   * One read-decide-write step. Returns a final result, or undefined when a
   * concurrent writer changed the record and the step must run again.
   */
  const claimStep = async (prepared: Prepared): Promise<IdempotencyClaimResult | undefined> => {
    const { storeKey, fingerprint, recovery } = prepared;
    const at = now();
    const live = await readLive(storeKey, at);
    if (live.kind === "absent") {
      if (recovery === "receipt") {
        const receipt = await findReceipt(storeKey);
        if (receipt) {
          if (receipt.fingerprint !== fingerprint) return { outcome: "conflict" };
          const response = await completeFromReceipt(storeKey, live.expectedVersion, live.previousGeneration, receipt);
          return response ? { outcome: "replay", response, source: "receipt" } : undefined;
        }
      }
      return acquire(storeKey, live.expectedVersion, live.previousGeneration + 1, prepared, at);
    }
    const { record } = live;
    if (record.fingerprint !== fingerprint) return { outcome: "conflict" };
    if (record.state === "completed") return { outcome: "replay", response: record.response, source: "store" };
    if (record.recovery === "receipt" && receipts) {
      const receipt = await findReceipt(storeKey);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) return { outcome: "conflict" };
        const response = await completeFromReceipt(storeKey, record.version, record.generation, receipt);
        return response ? { outcome: "replay", response, source: "receipt" } : undefined;
      }
      if (at < record.leaseExpiresAt) return { outcome: "in_progress", retryAfterMs: retryAfter(record.leaseExpiresAt, at) };
      // The lease expired and the receipt source shows no commit: take the key over.
      return acquire(storeKey, record.version, record.generation + 1, prepared, at);
    }
    if (at < record.leaseExpiresAt) return { outcome: "in_progress", retryAfterMs: retryAfter(record.leaseExpiresAt, at) };
    // Without commit evidence the holder may have committed: never re-run before retention ends.
    return { outcome: "indeterminate", retryAfterMs: retryAfter(record.expiresAt, at) };
  };

  const acquire = async (
    storeKey: string,
    expectedVersion: string | null,
    generation: number,
    prepared: Prepared,
    at: number,
  ): Promise<IdempotencyClaimResult | undefined> => {
    const version = nextVersion();
    const written = await store.compareAndSet(storeKey, expectedVersion, {
      state: "pending",
      version,
      generation,
      fingerprint: prepared.fingerprint,
      recovery: prepared.recovery,
      leaseExpiresAt: at + leaseMs,
      expiresAt: at + retentionMs,
    });
    if (!written) return undefined;
    const token: IdempotencyToken = Object.freeze({
      storeKey,
      version,
      generation,
      fingerprint: prepared.fingerprint,
      recovery: prepared.recovery,
      operation: prepared.operation,
    });
    return { outcome: "acquired", token };
  };

  const claim = async (request: IdempotencyRequest): Promise<IdempotencyClaimResult> => {
    const prepared = await prepare(request);
    if ("invalid" in prepared) {
      emit({ action: "claim", outcome: prepared.invalid.outcome, operation: prepared.operation });
      return prepared.invalid;
    }
    let result: IdempotencyClaimResult | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && result === undefined; attempt += 1) {
      result = await claimStep(prepared);
    }
    // Persistent contention: another caller keeps winning the write.
    const final = result ?? { outcome: "in_progress", retryAfterMs: 1 };
    emit({
      action: "claim",
      outcome: final.outcome,
      operation: prepared.operation,
      storeKey: prepared.storeKey,
      ...(final.outcome === "acquired" ? { generation: final.token.generation } : {}),
    });
    return final;
  };

  const settle = async (token: IdempotencyToken, response: IdempotentResponse): Promise<IdempotencySettleResult> => {
    if (!isToken(token)) throw new TypeError("idempotency settle needs a token from claim");
    const stored = normalizeIdempotentResponse(response, maxResponseBytes);
    const written = await store.compareAndSet(token.storeKey, token.version, {
      state: "completed",
      version: nextVersion(),
      generation: token.generation,
      fingerprint: token.fingerprint,
      recovery: token.recovery,
      response: stored,
      expiresAt: now() + retentionMs,
    });
    const result: IdempotencySettleResult = written ? { outcome: "settled", response: stored } : { outcome: "stale" };
    emit({
      action: "settle",
      outcome: result.outcome,
      operation: token.operation,
      storeKey: token.storeKey,
      generation: token.generation,
    });
    return result;
  };

  const release = async (token: IdempotencyToken): Promise<IdempotencyReleaseResult> => {
    if (!isToken(token)) throw new TypeError("idempotency release needs a token from claim");
    let result: IdempotencyReleaseResult;
    const receipt = token.recovery === "receipt" ? await findReceipt(token.storeKey) : undefined;
    if (receipt) {
      // A commit exists for this key: record it instead of freeing the key for a second run.
      const response = await completeFromReceipt(token.storeKey, token.version, token.generation, receipt);
      result = response ? { outcome: "committed", response } : { outcome: "stale" };
    } else {
      const written = await store.compareAndSet(token.storeKey, token.version, null);
      result = written ? { outcome: "released" } : { outcome: "stale" };
    }
    emit({
      action: "release",
      outcome: result.outcome,
      operation: token.operation,
      storeKey: token.storeKey,
      generation: token.generation,
    });
    return result;
  };

  const recoverStep = async (prepared: Prepared): Promise<IdempotencyRecoverResult | undefined> => {
    const { storeKey, fingerprint, recovery } = prepared;
    const at = now();
    const live = await readLive(storeKey, at);
    const record = live.kind === "present" ? live.record : undefined;
    if (record && record.fingerprint !== fingerprint) return { outcome: "conflict" };
    if (record?.state === "completed") return { outcome: "replay", response: record.response, source: "store" };
    const receiptMode = record ? record.recovery === "receipt" && receipts !== undefined : recovery === "receipt";
    if (receiptMode) {
      const receipt = await findReceipt(storeKey);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) return { outcome: "conflict" };
        const [expected, generation] =
          live.kind === "present"
            ? [live.record.version, live.record.generation]
            : [live.expectedVersion, live.previousGeneration];
        const response = await completeFromReceipt(storeKey, expected, generation, receipt);
        return response ? { outcome: "replay", response, source: "receipt" } : undefined;
      }
    }
    if (!record) return { outcome: "absent" };
    if (at < record.leaseExpiresAt) return { outcome: "in_progress", retryAfterMs: retryAfter(record.leaseExpiresAt, at) };
    return receiptMode
      ? { outcome: "not_committed" }
      : { outcome: "indeterminate", retryAfterMs: retryAfter(record.expiresAt, at) };
  };

  const recover = async (request: IdempotencyRequest): Promise<IdempotencyRecoverResult> => {
    const prepared = await prepare(request);
    if ("invalid" in prepared) {
      emit({ action: "recover", outcome: prepared.invalid.outcome, operation: prepared.operation });
      return prepared.invalid;
    }
    let result: IdempotencyRecoverResult | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && result === undefined; attempt += 1) {
      result = await recoverStep(prepared);
    }
    const final = result ?? { outcome: "in_progress", retryAfterMs: 1 };
    emit({ action: "recover", outcome: final.outcome, operation: prepared.operation, storeKey: prepared.storeKey });
    return final;
  };

  return { claim, settle, release, recover };
}
