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
 * - A committed receipt wins over any response settled without it: settle,
 *   release, claim and recover record the receipt's response, and a receipt
 *   for a different body is a conflict, never a replay. Settle and release
 *   reconcile through one step that records the receipt and reports it
 *   relative to the token, even when another caller recorded it first.
 * - Only the stored replay copy is bounded: settle and release return the
 *   full winning response, and receipt-backed replays read the receipt.
 * - A request's recovery mode must match the live record's; a mismatch is a
 *   conflict, so a request never takes over or downgrades a receipt claim.
 *   With a receipts source, an absent or expired record is checked against
 *   the receipt for every mode: a `"none"` request over a retained receipt is
 *   a conflict that neither acquires nor exposes the receipt's response.
 * - Settle and release read the receipt before validating or writing the
 *   holder's own result, and recheck it after a successful write, so a commit
 *   that landed meanwhile is reported instead of the holder's fallback.
 * - Store keys use a portable SHA-256 and never need ambient Web Crypto.
 */

import { canonicalJson } from "./canonical-json.js";
import { sha256Hex } from "./sha256.js";

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
  /**
   * The validated request body. It must be JSON data; `undefined` means no
   * body, which never matches a `null` body.
   */
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
  /**
   * Parts dropped because the response exceeded `maxResponseBytes`. When the
   * body is dropped, its representation and framing headers (content-length,
   * etag, digests and similar) are dropped with it.
   */
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
  /** True when the response was recorded from a durable receipt. */
  fromReceipt?: boolean;
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

/**
 * `settled`: the claim is complete; send `response`, never the bounded
 * stored copy. It is the holder's own full response, unchanged (credential
 * headers included); when the holder's own receipt records a different
 * status or body, it is that receipt's response. `committed`: another holder's receipt
 * for the same body exists and was recorded instead; send its response.
 * `conflict`: a receipt for a different body holds the key. `stale`: no
 * receipt exists and a newer claim owns the key.
 */
export type IdempotencySettleResult =
  | { outcome: "settled"; response: IdempotentResponse }
  | { outcome: "committed"; response: IdempotentResponse }
  | { outcome: "conflict" }
  | { outcome: "stale" };

export type IdempotencyReleaseResult =
  | { outcome: "released" }
  | { outcome: "committed"; response: IdempotentResponse }
  | { outcome: "conflict" }
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
  /**
   * Collision-resistant digest of the canonical request body. Defaults to a
   * portable SHA-256 hex digest. Store keys always use SHA-256, so scope
   * identifiers never reach the store or diagnostics through this option.
   */
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
  /** Called synchronously; a throw or a rejected promise never changes an outcome. */
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
// Hop-by-hop framing describes one connection; the replaying runtime frames its own response.
const HOP_BY_HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
// Headers that describe the body's bytes. They are dropped with the body, so a replay never advertises bytes it does not send.
const BODY_REPRESENTATION_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "content-range",
  "content-md5",
  "content-digest",
  "repr-digest",
  "digest",
  "etag",
  "last-modified",
]);
const SCOPE_DOMAIN = "apifn.idempotency.scope.v1";
const BODY_DOMAIN = "apifn.idempotency.body.v1";

interface WebCryptoLike {
  randomUUID?: () => string;
}

function webCrypto(): WebCryptoLike | undefined {
  return (globalThis as { crypto?: WebCryptoLike }).crypto;
}

/** SHA-256 hex digest of a string's UTF-8 bytes. Portable: needs no Web Crypto. */
export async function sha256Fingerprint(canonical: string): Promise<string> {
  if (typeof canonical !== "string") throw new TypeError("sha256Fingerprint needs a string");
  return sha256Hex(canonical);
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

function isValidStatus(status: unknown): status is number {
  return Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599;
}

function isSingleLine(value: unknown): value is string {
  return typeof value === "string" && !/[\r\n\0]/.test(value);
}

function headerBytes(headers: Readonly<Record<string, string>>): number {
  let total = 0;
  for (const [name, value] of Object.entries(headers)) total += byteLength(name) + byteLength(value) + 4;
  return total;
}

/**
 * Validates a response and bounds what is stored for replay. Credential and
 * hop-by-hop headers are never stored. When the response exceeds `maxBytes`
 * the body is dropped with its representation headers, then the headers.
 */
export function normalizeIdempotentResponse(
  response: IdempotentResponse,
  maxBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
): StoredIdempotentResponse {
  if (!isPlainObject(response)) throw new TypeError("idempotent response must be an object");
  const { status, headers, body } = response;
  if (!isValidStatus(status)) throw new TypeError("idempotent response status must be an integer from 100 to 599");
  if (body !== undefined && typeof body !== "string") throw new TypeError("idempotent response body must be a string");
  if (headers !== undefined && !isPlainObject(headers)) throw new TypeError("idempotent response headers must be an object");
  const kept: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers ?? {})) {
    const name = rawName.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name)) throw new TypeError("idempotent response has an invalid header name");
    if (!isSingleLine(value)) throw new TypeError("idempotent response header values must be single-line strings");
    if (CREDENTIAL_HEADERS.has(name) || HOP_BY_HOP_HEADERS.has(name) || Object.hasOwn(kept, name)) continue;
    kept[name] = value;
  }
  if (body === undefined) {
    return headerBytes(kept) <= maxBytes ? { status, headers: kept } : { status, headers: {}, omitted: ["headers"] };
  }
  if (headerBytes(kept) + byteLength(body) <= maxBytes) return { status, headers: kept, body };
  const withoutBody: Record<string, string> = {};
  for (const [name, value] of Object.entries(kept)) {
    if (!BODY_REPRESENTATION_HEADERS.has(name)) withoutBody[name] = value;
  }
  if (headerBytes(withoutBody) <= maxBytes) return { status, headers: withoutBody, omitted: ["body"] };
  return { status, headers: {}, omitted: ["body", "headers"] };
}

/**
 * Re-applies the write-path header rules to a stored response before it is
 * replayed, so a record written by another writer never replays credential,
 * framing or (without its body) representation headers.
 */
function replayable(response: StoredIdempotentResponse): StoredIdempotentResponse {
  const bodyOmitted = response.omitted?.includes("body") === true;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (CREDENTIAL_HEADERS.has(name) || HOP_BY_HOP_HEADERS.has(name)) continue;
    if (bodyOmitted && BODY_REPRESENTATION_HEADERS.has(name)) continue;
    headers[name] = value;
  }
  return { ...response, headers };
}

function isStoredResponse(value: unknown): value is StoredIdempotentResponse {
  if (!isPlainObject(value) || !isValidStatus(value.status) || !isPlainObject(value.headers)) return false;
  for (const [name, header] of Object.entries(value.headers)) {
    if (!HEADER_NAME_PATTERN.test(name) || !isSingleLine(header)) return false;
  }
  if (value.body !== undefined && typeof value.body !== "string") return false;
  if (value.omitted === undefined) return true;
  if (!Array.isArray(value.omitted) || !value.omitted.every((part) => part === "body" || part === "headers")) return false;
  // A stored body contradicts a record that says the body was dropped.
  return !(value.body !== undefined && value.omitted.includes("body"));
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
  if (value.fromReceipt !== undefined && typeof value.fromReceipt !== "boolean") return false;
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
    (value.generation as number) > 0 &&
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
      const returned: unknown = onDiagnostic?.(event);
      // An async listener's rejection is observed here, so it never surfaces as an unhandled rejection.
      if (typeof (returned as PromiseLike<unknown> | undefined)?.then === "function") {
        Promise.resolve(returned).catch(() => undefined);
      }
    } catch {
      // Diagnostics never change an idempotency outcome.
    }
  };

  const requireReceiptSource = (action: "settle" | "release", token: IdempotencyToken): void => {
    if (token.recovery === "receipt" && !receipts) {
      throw new TypeError(`idempotency ${action} of a "receipt" token needs a receipts source with durable commit evidence`);
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
    if (
      !isPlainObject(receipt) ||
      !nonEmptyString(receipt.fingerprint) ||
      !Number.isSafeInteger(receipt.generation) ||
      receipt.generation <= 0
    ) {
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
      fromReceipt: true,
    });
    return written ? response : undefined;
  };

  // Store keys always use the portable SHA-256, whatever body digest the host supplies.
  const scopeKey = (scope: IdempotencyScope, key: string): string =>
    sha256Hex(canonicalJson([SCOPE_DOMAIN, scope.tenant ?? null, scope.principal, scope.operation, scope.target ?? null, key]));

  type Prepared = { storeKey: string; fingerprint: string; recovery: IdempotencyRecovery; operation: string };
  type InvalidKey = { invalid: { outcome: "invalid_key"; reason: IdempotencyInvalidKeyReason }; operation: string };

  const prepare = async (request: IdempotencyRequest): Promise<Prepared | InvalidKey> => {
    if (!isPlainObject(request)) throw new TypeError("idempotency request must be an object");
    const scope = validateScope(request.scope);
    const recovery = recoveryOf(request);
    const reason = keyProblem(request.key);
    if (reason) return { invalid: { outcome: "invalid_key", reason }, operation: scope.operation };
    // An absent body has its own domain, so it never matches a JSON null body.
    const bodyIdentity = request.body === undefined ? [BODY_DOMAIN, "absent"] : [BODY_DOMAIN, "json", request.body];
    const storeKey = scopeKey(scope, request.key);
    const fingerprint = await fingerprintOf(bodyIdentity);
    return { storeKey, fingerprint, recovery, operation: scope.operation };
  };

  const retryAfter = (until: number, at: number): number => Math.max(1, Math.ceil(until - at));

  /** The receipt's response for the caller: header rules applied, never size-bounded. */
  const fullReceiptResponse = (receipt: IdempotencyReceipt): StoredIdempotentResponse =>
    normalizeIdempotentResponse(receipt.response, Number.POSITIVE_INFINITY);

  /**
   * Replays a completed record. A copy recorded from a receipt whose parts
   * were dropped for size is served in full from the receipt itself.
   */
  const replayOf = async (storeKey: string, record: CompletedIdempotencyRecord): Promise<IdempotencyReplay> => {
    if (record.recovery === "receipt" && record.fromReceipt === true && record.response.omitted !== undefined && receipts) {
      const receipt = await findReceipt(storeKey);
      if (receipt && receipt.fingerprint === record.fingerprint) {
        return { outcome: "replay", response: fullReceiptResponse(receipt), source: "receipt" };
      }
    }
    return { outcome: "replay", response: replayable(record.response), source: "store" };
  };

  type ReceiptOutcome = IdempotencyReplay | { outcome: "conflict" };

  /**
   * Records a receipt over the live record and reports it: a replay for the
   * same body, a conflict for another body. Undefined when the write lost.
   */
  const applyReceipt = async (
    storeKey: string,
    expectedVersion: string | null,
    generation: number,
    receipt: IdempotencyReceipt,
    fingerprint: string,
  ): Promise<ReceiptOutcome | undefined> => {
    if (!(await completeFromReceipt(storeKey, expectedVersion, generation, receipt))) return undefined;
    return receipt.fingerprint === fingerprint
      ? { outcome: "replay", response: fullReceiptResponse(receipt), source: "receipt" }
      : { outcome: "conflict" };
  };

  /**
   * Reads the live record and its commit evidence. A recovery-mode mismatch
   * with a live record is a conflict. With no live record, a retained
   * receipt is checked for every mode: a `"none"` request over it is a
   * conflict, so a handler outside the receipt contract never re-runs a
   * committed key and never sees the receipt's response. For a receipt-mode
   * request a receipt wins over any record not already recorded from it.
   */
  const inspect = async (
    prepared: Prepared,
    at: number,
  ): Promise<{ done: ReceiptOutcome | undefined } | { live: Live }> => {
    const { storeKey, fingerprint, recovery } = prepared;
    const live = await readLive(storeKey, at);
    const record = live.kind === "present" ? live.record : undefined;
    if (record && record.recovery !== recovery) return { done: { outcome: "conflict" } };
    if (recovery === "none") {
      if (!record && (await findReceipt(storeKey))) return { done: { outcome: "conflict" } };
      return { live };
    }
    const recordedFromReceipt = record?.state === "completed" && record.fromReceipt === true;
    if (!recordedFromReceipt) {
      const receipt = await findReceipt(storeKey);
      if (receipt) {
        const [expected, generation] =
          live.kind === "present"
            ? [live.record.version, live.record.generation]
            : [live.expectedVersion, live.previousGeneration];
        return { done: await applyReceipt(storeKey, expected, generation, receipt, fingerprint) };
      }
    }
    return { live };
  };

  /**
   * One read-decide-write step. Returns a final result, or undefined when a
   * concurrent writer changed the record and the step must run again.
   */
  const claimStep = async (prepared: Prepared): Promise<IdempotencyClaimResult | undefined> => {
    const at = now();
    const inspected = await inspect(prepared, at);
    if ("done" in inspected) return inspected.done;
    const { live } = inspected;
    if (live.kind === "absent") {
      return acquire(prepared.storeKey, live.expectedVersion, live.previousGeneration + 1, prepared, at);
    }
    const { record } = live;
    if (record.fingerprint !== prepared.fingerprint) return { outcome: "conflict" };
    if (record.state === "completed") return replayOf(prepared.storeKey, record);
    if (at < record.leaseExpiresAt) return { outcome: "in_progress", retryAfterMs: retryAfter(record.leaseExpiresAt, at) };
    // The lease expired and the receipt source shows no commit: take the key over.
    if (record.recovery === "receipt") return acquire(prepared.storeKey, record.version, record.generation + 1, prepared, at);
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

  type Reconciled =
    | { outcome: "receipt"; receipt: IdempotencyReceipt; own: boolean }
    | { outcome: "conflict" }
    | { outcome: "stale" };

  /**
   * The one reconcile step for settle and release. For a receipt-mode token
   * whose key has a receipt, records the receipt over the live record unless
   * it is already recorded (by this or any other caller), then reports it
   * relative to the token: the token's own commit (`own`), another holder's
   * commit of the same body, or `conflict` for a different body. The receipt
   * wins over any record, as it does in claim and recover. Undefined when the
   * token has no receipt contract or no receipt exists.
   */
  const reconcileReceipt = async (token: IdempotencyToken): Promise<Reconciled | undefined> => {
    if (token.recovery !== "receipt") return undefined;
    const receipt = await findReceipt(token.storeKey);
    if (!receipt) return undefined;
    let recorded = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !recorded; attempt += 1) {
      const live = await readLive(token.storeKey, now());
      if (live.kind === "present") {
        const { record } = live;
        recorded =
          (record.state === "completed" && record.fromReceipt === true && record.fingerprint === receipt.fingerprint) ||
          (await completeFromReceipt(token.storeKey, record.version, record.generation, receipt)) !== undefined;
      } else {
        recorded =
          (await completeFromReceipt(token.storeKey, live.expectedVersion, live.previousGeneration, receipt)) !== undefined;
      }
    }
    // Persistent contention: other writers keep winning; the next claim or recover records the receipt.
    if (!recorded) return { outcome: "stale" };
    if (receipt.fingerprint !== token.fingerprint) return { outcome: "conflict" };
    return { outcome: "receipt", receipt, own: receipt.generation === token.generation };
  };

  /** Whether a holder's response passes validation, without bounding it. */
  const isValidResponse = (response: IdempotentResponse): boolean => {
    try {
      normalizeIdempotentResponse(response, Number.POSITIVE_INFINITY);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Settle's view of a reconciled receipt. For the token's own commit, a
   * valid holder response with the receipt's status and body is returned
   * unchanged (credential headers such as Set-Cookie included); a response
   * that differs from what was committed (an error after the commit) yields
   * the holder's own receipt response, so the first delivery matches every
   * replay. Another holder's commit returns the receipt's response with the
   * replay header rules applied.
   */
  const settleResult = (reconciled: Reconciled, response: IdempotentResponse): IdempotencySettleResult => {
    if (reconciled.outcome !== "receipt") return reconciled;
    const { receipt, own } = reconciled;
    if (!own) return { outcome: "committed", response: fullReceiptResponse(receipt) };
    const matchesCommit =
      isValidResponse(response) && response.status === receipt.response.status && response.body === receipt.response.body;
    return { outcome: "settled", response: matchesCommit ? response : receipt.response };
  };

  /** Release's view: the key is committed, so the receipt's response is reported. */
  const releaseResult = (reconciled: Reconciled): IdempotencyReleaseResult => {
    if (reconciled.outcome !== "receipt") return reconciled;
    const { receipt, own } = reconciled;
    return { outcome: "committed", response: own ? receipt.response : fullReceiptResponse(receipt) };
  };

  /** Completes the token's own claim with its response when no receipt exists. */
  const settleOwn = async (token: IdempotencyToken, response: IdempotentResponse): Promise<IdempotencySettleResult> => {
    // Validates the response and bounds only the stored replay copy.
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
    // A receipt committed meanwhile (by a holder whose lease expired) wins over the fallback just written.
    const recheck = await reconcileReceipt(token);
    if (recheck) return settleResult(recheck, response);
    // The caller sends its own full response.
    return written ? { outcome: "settled", response } : { outcome: "stale" };
  };

  const settle = async (token: IdempotencyToken, response: IdempotentResponse): Promise<IdempotencySettleResult> => {
    if (!isToken(token)) throw new TypeError("idempotency settle needs a token from claim");
    requireReceiptSource("settle", token);
    // Commit evidence first: the holder's response is validated only when it is the result.
    const reconciled = await reconcileReceipt(token);
    const result = reconciled ? settleResult(reconciled, response) : await settleOwn(token, response);
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
    requireReceiptSource("release", token);
    // A commit exists for this key: record it instead of freeing the key for a second run.
    const reconciled = await reconcileReceipt(token);
    let result: IdempotencyReleaseResult;
    if (reconciled) {
      result = releaseResult(reconciled);
    } else {
      const released = await store.compareAndSet(token.storeKey, token.version, null);
      // Recheck: a commit that landed during the delete is recorded and reported, never freed.
      const late = await reconcileReceipt(token);
      if (late) result = releaseResult(late);
      else result = released ? { outcome: "released" } : { outcome: "stale" };
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
    const at = now();
    const inspected = await inspect(prepared, at);
    if ("done" in inspected) return inspected.done;
    const { live } = inspected;
    if (live.kind === "absent") return { outcome: "absent" };
    const { record } = live;
    if (record.fingerprint !== prepared.fingerprint) return { outcome: "conflict" };
    if (record.state === "completed") return replayOf(prepared.storeKey, record);
    if (at < record.leaseExpiresAt) return { outcome: "in_progress", retryAfterMs: retryAfter(record.leaseExpiresAt, at) };
    return record.recovery === "receipt"
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
