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
 * - A receipt belongs to the claim whose `claimId` it carries. Ownership
 *   never rests on the generation, which restarts at 1 when a store evicts
 *   a record. Release leaves a tombstone that keeps the generation until
 *   retention ends.
 * - The recovery mode is fixed per operation. Changing it needs a new
 *   operation name or a full retention drain of the old one. A `"none"`
 *   request over a released or expired receipt-mode record that the store
 *   still holds is a conflict, with or without a receipts source.
 * - A claim is handed out only while its lease is still running after the
 *   acquire write and the `acquired` diagnostic; a claim that outlasted the
 *   lease is released and retried. `leaseMs` must exceed the store's latency
 *   plus the handler's longest transaction.
 * - A durable receipt decides settle, release, claim and recover whether or
 *   not the cache write that records it wins; a lost write never overwrites
 *   the newer record.
 * - Every instance that shares a store uses the same recovery mode per
 *   operation and the same receipts source.
 * - Settle and release reconcile a receipt by reading the record first, then
 *   the receipt, and writing only over the version they saw; a completed
 *   record names the receipt claim it was recorded from, so a receipt read
 *   before a key's retention ended never replaces a newer claim.
 * - A receipt copy written where no record existed is provisional until a
 *   recheck of the live receipt confirms the same commit. Only a confirmed
 *   copy stands in for a pruned receipt or a receipt-source outage; a receipt
 *   the source returns that fails validation always fails closed.
 * - Responses, stored records, receipts and tokens are read exactly once,
 *   through own data property descriptors, into fresh validated copies; an
 *   accessor is rejected without being invoked. Every check and every
 *   returned or stored response derives from that copy.
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
  /**
   * Set on a copy recorded where no record existed, until a recheck of the
   * live receipt confirms the same commit. A provisional copy is never commit
   * evidence on its own: without a live validated receipt the key is free at
   * its version. A copy without the flag is confirmed.
   */
  provisional?: true;
  /**
   * The `claimId` of the receipt the response was recorded from. Present
   * exactly when `fromReceipt` is true, so a record is matched to one commit,
   * never only to a body.
   */
  receiptClaimId?: string;
}

/** A released claim. It frees the key but keeps the generation until `expiresAt`. */
export interface ReleasedIdempotencyRecord extends IdempotencyRecordBase {
  state: "released";
}

export type IdempotencyRecord = PendingIdempotencyRecord | CompletedIdempotencyRecord | ReleasedIdempotencyRecord;

type ActiveIdempotencyRecord = PendingIdempotencyRecord | CompletedIdempotencyRecord;

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
  /**
   * Unique id of the claim that ran the handler. It decides whether a
   * receipt is a holder's own commit, also after the store lost the record.
   */
  readonly claimId: string;
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

/** `claimId` equals the version the claim wrote. */
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
 * stored copy. Without a receipt it is a fresh copy of the holder's own
 * full response as validated when settle was called (the same status, body,
 * header names and values, including credentials). When the holder's own receipt exists, it is the receipt's
 * response with the replay header rules applied (never size-bounded) plus
 * only the holder's own credential headers (Set-Cookie and similar), so the
 * first delivery equals every replay except for credentials a replay never
 * carries. `committed`: another holder's receipt for the same body exists;
 * send its response. `conflict`: a receipt for a different body holds the
 * key. `stale`: no receipt exists and a newer claim owns the key.
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
  /**
   * Extra response header names that carry credentials. Like the built-in
   * list (authorization, set-cookie and similar), they are never stored and
   * never replayed.
   */
  credentialHeaders?: readonly string[];
  /** Unique version tokens. Defaults to `crypto.randomUUID()`. */
  nonce?: () => string;
  /**
   * Called synchronously; a throw or a rejected promise never changes an
   * outcome. The `acquired` claim diagnostic runs inside the claim's lease
   * window, before the final lease check.
   */
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
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/i;
/** A stored (lower-case) header name. */
const STORED_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
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

/** A final response status: informational 1xx responses are never the result of a request. */
function isValidStatus(status: unknown): status is number {
  return Number.isInteger(status) && (status as number) >= 200 && (status as number) <= 599;
}

// Statuses that never carry content (RFC 9110 15.3.5, 15.3.6, 15.4.5).
const BODYLESS_STATUSES = new Set([204, 205, 304]);

const NO_EXTRA_CREDENTIALS: ReadonlySet<string> = new Set();

function credentialHeaderSet(names: unknown): ReadonlySet<string> {
  if (names === undefined) return NO_EXTRA_CREDENTIALS;
  if (!Array.isArray(names)) throw new TypeError("credentialHeaders must be an array of header names");
  const set = new Set<string>();
  for (let index = 0; index < names.length; index += 1) {
    const name: unknown = names[index];
    if (typeof name !== "string" || !HEADER_NAME_PATTERN.test(name)) {
      throw new TypeError("credentialHeaders must contain valid header names");
    }
    set.add(name.toLowerCase());
  }
  return set;
}

function isCredentialHeader(name: string, extra: ReadonlySet<string>): boolean {
  return CREDENTIAL_HEADERS.has(name) || extra.has(name);
}

/**
 * A field value runtimes can send: HTAB, visible ASCII, space and obs-text
 * (0x80-0xFF) only (RFC 9110 5.5). Other control characters and code points
 * above U+00FF are rejected.
 */
function isSingleLine(value: unknown): value is string {
  return typeof value === "string" && /^[\t\x20-\x7e\x80-\xff]*$/.test(value);
}

/** A header map: a plain record. A `Headers` instance or other class would read as empty. */
function isHeaderMap(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Sets a header as an own property, so a `__proto__` field is kept instead of changing the prototype. */
function putHeader(target: Record<string, string>, name: string, value: string): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/** Marks a field held by an accessor: it fails every type check, and the accessor is never invoked. */
const ACCESSOR: unique symbol = Symbol("accessor");

/** Reads an own property once through its descriptor; an accessor yields `ACCESSOR` without being invoked. */
function field(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return undefined;
  return "value" in descriptor ? descriptor.value : ACCESSOR;
}

/**
 * A response read exactly once. Status, body and each header come from own
 * data properties (an accessor is rejected without being invoked) into a
 * fresh object and are validated there; every later step (Connection
 * nominations, the stored copy, holder credentials, the first delivery)
 * reads only this copy, so a caller or a store can never change a value
 * after it was checked.
 */
interface ResponseSnapshot {
  readonly status: number;
  /** Header names as given: valid tokens, never repeated in another case. Absent when the response had none. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

function snapshotHeaders(headers: Record<string, unknown>): Record<string, string> {
  const copy: Record<string, string> = {};
  const seen = new Set<string>();
  for (const key of Reflect.ownKeys(headers)) {
    if (typeof key === "symbol") throw new TypeError("idempotent response has an invalid header name");
    // The raw name is checked: lower-casing maps some non-ASCII letters (U+212A KELVIN SIGN) onto ASCII.
    if (!HEADER_NAME_PATTERN.test(key)) throw new TypeError("idempotent response has an invalid header name");
    const descriptor = Object.getOwnPropertyDescriptor(headers, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("idempotent response headers must be data properties, not accessors");
    }
    // A serializer would skip a non-enumerable field, so it is rejected rather than delivered and never replayed.
    if (!descriptor.enumerable) throw new TypeError("idempotent response headers must be enumerable");
    const value: unknown = descriptor.value;
    if (!isSingleLine(value)) throw new TypeError("idempotent response header values must be single-line strings");
    const name = key.toLowerCase();
    // Two spellings of one field would leave the delivered and the replayed response different.
    if (seen.has(name)) throw new TypeError("idempotent response repeats a header name in a different case");
    seen.add(name);
    putHeader(copy, key, value);
  }
  return copy;
}

function snapshotResponse(response: unknown): ResponseSnapshot {
  if (!isPlainObject(response)) throw new TypeError("idempotent response must be an object");
  const status = field(response, "status");
  const headers = field(response, "headers");
  const body = field(response, "body");
  if (status === ACCESSOR || headers === ACCESSOR || body === ACCESSOR) {
    throw new TypeError("idempotent response fields must be data properties, not accessors");
  }
  if (!isValidStatus(status)) throw new TypeError("idempotent response status must be a final status from 200 to 599");
  if (body !== undefined && typeof body !== "string") throw new TypeError("idempotent response body must be a string");
  if (body !== undefined && BODYLESS_STATUSES.has(status)) {
    throw new TypeError(`idempotent response status ${status} must not have a body`);
  }
  if (headers !== undefined && !isHeaderMap(headers)) throw new TypeError("idempotent response headers must be a plain object");
  return {
    status,
    ...(headers === undefined ? {} : { headers: snapshotHeaders(headers) }),
    ...(body === undefined ? {} : { body }),
  };
}

/** A fresh copy of a snapshot for the caller, so nothing the caller changes reaches a stored or later result. */
function deliveryOf(snapshot: ResponseSnapshot): IdempotentResponse {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(snapshot.headers ?? {})) putHeader(headers, name, value);
  return {
    status: snapshot.status,
    ...(snapshot.headers === undefined ? {} : { headers }),
    ...(snapshot.body === undefined ? {} : { body: snapshot.body }),
  };
}

/** Field names a Connection header nominates as hop-by-hop (RFC 9110 7.6.1). Reads validated copies only. */
function connectionNominated(headers: Readonly<Record<string, string>>): Set<string> {
  const names = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "connection") continue;
    for (const token of value.split(",")) {
      const nominated = token.trim().toLowerCase();
      if (nominated) names.add(nominated);
    }
  }
  return names;
}

function headerBytes(headers: Readonly<Record<string, string>>): number {
  let total = 0;
  for (const [name, value] of Object.entries(headers)) total += byteLength(name) + byteLength(value) + 4;
  return total;
}

export interface NormalizeIdempotentResponseOptions {
  /** Upper bound for the stored copy: a positive integer up to 16 MiB. Default 64 KiB. */
  maxBytes?: number;
  /** Extra credential header names, dropped like the built-in list. */
  credentialHeaders?: readonly string[];
}

/**
 * Validates a response and bounds what is stored for replay. Credential and
 * hop-by-hop headers, including fields a Connection header nominates, are
 * never stored. When the response exceeds `maxBytes`
 * the body is dropped with its representation headers, then the headers.
 * Each field is read once through its descriptor; accessor-backed fields are
 * rejected without being invoked.
 */
export function normalizeIdempotentResponse(
  response: IdempotentResponse,
  options: NormalizeIdempotentResponseOptions = {},
): StoredIdempotentResponse {
  if (!isPlainObject(options)) throw new TypeError("normalizeIdempotentResponse options must be an object");
  const maxBytes: unknown = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_RESPONSE_BYTES_LIMIT) {
    throw new TypeError(`normalizeIdempotentResponse: maxBytes must be a positive integer no larger than ${MAX_RESPONSE_BYTES_LIMIT}`);
  }
  return boundSnapshot(snapshotResponse(response), maxBytes, credentialHeaderSet(options.credentialHeaders));
}

/** The replay copy of a validated snapshot, bounded by `maxBytes` (which may be `Infinity`). */
function boundSnapshot(snapshot: ResponseSnapshot, maxBytes: number, extraCredentials: ReadonlySet<string>): StoredIdempotentResponse {
  const { status, body } = snapshot;
  const headers = snapshot.headers ?? {};
  const nominated = connectionNominated(headers);
  const kept: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (isCredentialHeader(name, extraCredentials) || HOP_BY_HOP_HEADERS.has(name) || nominated.has(name)) continue;
    putHeader(kept, name, value);
  }
  if (body === undefined) {
    return headerBytes(kept) <= maxBytes ? { status, headers: kept } : { status, headers: {}, omitted: ["headers"] };
  }
  if (headerBytes(kept) + byteLength(body) <= maxBytes) return { status, headers: kept, body };
  const withoutBody: Record<string, string> = {};
  for (const [name, value] of Object.entries(kept)) {
    if (!BODY_REPRESENTATION_HEADERS.has(name)) putHeader(withoutBody, name, value);
  }
  if (headerBytes(withoutBody) <= maxBytes) return { status, headers: withoutBody, omitted: ["body"] };
  return { status, headers: {}, omitted: ["body", "headers"] };
}

/**
 * Re-applies the write-path header rules to a parsed stored response before
 * it is replayed, so a record written by another writer never replays
 * credential, framing or (without its body) representation headers.
 */
function replayable(response: StoredIdempotentResponse, extraCredentials: ReadonlySet<string>): StoredIdempotentResponse {
  const bodyOmitted = response.omitted?.includes("body") === true;
  const nominated = connectionNominated(response.headers);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (isCredentialHeader(name, extraCredentials) || HOP_BY_HOP_HEADERS.has(name) || nominated.has(name)) continue;
    if (bodyOmitted && BODY_REPRESENTATION_HEADERS.has(name)) continue;
    putHeader(headers, name, value);
  }
  return {
    status: response.status,
    headers,
    ...(response.body === undefined ? {} : { body: response.body }),
    ...(response.omitted === undefined ? {} : { omitted: [...response.omitted] }),
  };
}

/**
 * A stored response read once into a fresh copy and validated there, or
 * undefined when it is malformed. Only the response fields are copied, never
 * unknown fields a store kept, and an accessor makes the response malformed.
 */
function parseStoredResponse(value: unknown): StoredIdempotentResponse | undefined {
  if (!isPlainObject(value)) return undefined;
  const status = field(value, "status");
  const headers = field(value, "headers");
  const body = field(value, "body");
  const omitted = field(value, "omitted");
  if (!isValidStatus(status) || !isHeaderMap(headers)) return undefined;
  if (body !== undefined && typeof body !== "string") return undefined;
  if (body !== undefined && BODYLESS_STATUSES.has(status)) return undefined;
  const copy: Record<string, string> = {};
  for (const key of Reflect.ownKeys(headers)) {
    if (typeof key === "symbol" || !STORED_HEADER_NAME_PATTERN.test(key)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(headers, key);
    if (!descriptor?.enumerable || !("value" in descriptor) || !isSingleLine(descriptor.value)) return undefined;
    putHeader(copy, key, descriptor.value);
  }
  const response: StoredIdempotentResponse = { status, headers: copy, ...(body === undefined ? {} : { body }) };
  if (omitted === undefined) return response;
  if (!Array.isArray(omitted) || omitted.length === 0) return undefined;
  const parts: IdempotencyOmittedPart[] = [];
  // An index loop over descriptors: a sparse array's hole or an accessor item fails instead of being skipped or run.
  for (let index = 0; index < omitted.length; index += 1) {
    const part = field(omitted, String(index));
    if ((part !== "body" && part !== "headers") || parts.includes(part)) return undefined;
    parts.push(part);
  }
  // Parts the write path dropped are absent, and headers are dropped only after the body (or with no body).
  // A bodyless status never had a body to omit.
  if (parts.includes("body") && (body !== undefined || BODYLESS_STATUSES.has(status))) return undefined;
  if (parts.includes("headers") && (Object.keys(copy).length > 0 || body !== undefined)) return undefined;
  return { ...response, omitted: parts };
}

/** A store record read once into a fresh copy and validated there, or undefined when it is malformed. */
function parseRecord(value: unknown): IdempotencyRecord | undefined {
  if (!isPlainObject(value)) return undefined;
  const version = field(value, "version");
  const generation = field(value, "generation");
  const fingerprint = field(value, "fingerprint");
  const recovery = field(value, "recovery");
  const expiresAt = field(value, "expiresAt");
  const state = field(value, "state");
  if (
    !nonEmptyString(version) ||
    !Number.isSafeInteger(generation) ||
    (generation as number) <= 0 ||
    !nonEmptyString(fingerprint) ||
    (recovery !== "receipt" && recovery !== "none") ||
    !finiteNumber(expiresAt)
  ) {
    return undefined;
  }
  const base = { version, generation: generation as number, fingerprint, recovery, expiresAt } as const;
  if (state === "pending") {
    const leaseExpiresAt = field(value, "leaseExpiresAt");
    // A lease never outlives the record it belongs to.
    return finiteNumber(leaseExpiresAt) && leaseExpiresAt <= expiresAt ? { ...base, state, leaseExpiresAt } : undefined;
  }
  if (state === "released") return { ...base, state };
  if (state !== "completed") return undefined;
  const fromReceipt = field(value, "fromReceipt");
  const receiptClaimId = field(value, "receiptClaimId");
  if (fromReceipt !== undefined && typeof fromReceipt !== "boolean") return undefined;
  // Only a receipt-mode record can be recorded from a receipt, and such a record names the receipt's claim.
  if (fromReceipt === true && (recovery !== "receipt" || !nonEmptyString(receiptClaimId))) return undefined;
  if (fromReceipt !== true && receiptClaimId !== undefined) return undefined;
  // Only a copy recorded from a receipt can be provisional, and the flag is only ever true.
  const provisional = field(value, "provisional");
  if (provisional !== undefined && (provisional !== true || fromReceipt !== true)) return undefined;
  const response = parseStoredResponse(field(value, "response"));
  if (!response) return undefined;
  return fromReceipt === true
    ? { ...base, state, response, fromReceipt, receiptClaimId: receiptClaimId as string, ...(provisional ? { provisional } : {}) }
    : { ...base, state, response, ...(fromReceipt === undefined ? {} : { fromReceipt }) };
}

/** A token read once into a fresh frozen copy, or undefined when it is not a token from claim. */
function parseToken(value: unknown): IdempotencyToken | undefined {
  if (!isPlainObject(value)) return undefined;
  const storeKey = field(value, "storeKey");
  const version = field(value, "version");
  const claimId = field(value, "claimId");
  const fingerprint = field(value, "fingerprint");
  const operation = field(value, "operation");
  const generation = field(value, "generation");
  const recovery = field(value, "recovery");
  if (
    !nonEmptyString(storeKey) ||
    !nonEmptyString(version) ||
    !nonEmptyString(claimId) ||
    !nonEmptyString(fingerprint) ||
    !nonEmptyString(operation) ||
    !Number.isSafeInteger(generation) ||
    (generation as number) <= 0 ||
    (recovery !== "receipt" && recovery !== "none")
  ) {
    return undefined;
  }
  return Object.freeze({ storeKey, version, claimId, fingerprint, operation, generation: generation as number, recovery });
}

/** A receipt read once: its response is a validated snapshot. */
interface ParsedReceipt extends IdempotencyCommit {
  readonly response: ResponseSnapshot;
}

type Live =
  | {
      kind: "absent";
      expectedVersion: string | null;
      previousGeneration: number;
      /** Recovery mode of a released or expired record the store still holds. */
      previousRecovery?: IdempotencyRecovery;
    }
  | { kind: "present"; record: ActiveIdempotencyRecord };

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
  const extraCredentials = credentialHeaderSet(options.credentialHeaders);
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
    const raw = await store.get(storeKey);
    if (raw === undefined || raw === null) return { kind: "absent", expectedVersion: null, previousGeneration: 0 };
    // A fresh validated copy: every later step reads it, never the object the store returned.
    const stored = parseRecord(raw);
    if (!stored) throw new Error("idempotency store returned a malformed record");
    // A released tombstone frees the key but keeps the generation, so the next claim never reuses it.
    if (stored.state === "released" || stored.expiresAt <= at) {
      return {
        kind: "absent",
        expectedVersion: stored.version,
        previousGeneration: stored.generation,
        previousRecovery: stored.recovery,
      };
    }
    return { kind: "present", record: stored };
  };

  /** The receipt source's raw answer. Only its rejection is a source outage; validation happens in `parseReceipt`. */
  const lookupReceipt = async (storeKey: string): Promise<unknown> => (receipts ? receipts.find(storeKey) : undefined);

  /**
   * Validates a looked-up receipt once; its response becomes a snapshot that later steps read. A malformed
   * receipt, or one for another key, throws: the source answered, so it is never treated as an outage.
   */
  const parseReceipt = (storeKey: string, raw: unknown): ParsedReceipt | undefined => {
    if (raw === undefined || raw === null) return undefined;
    const malformed = () => new Error("idempotency receipt source returned a malformed receipt");
    if (!isPlainObject(raw)) throw malformed();
    const receiptKey = field(raw, "storeKey");
    const fingerprint = field(raw, "fingerprint");
    const claimId = field(raw, "claimId");
    const generation = field(raw, "generation");
    if (!nonEmptyString(fingerprint) || !nonEmptyString(claimId) || !Number.isSafeInteger(generation) || (generation as number) <= 0) {
      throw malformed();
    }
    let response: ResponseSnapshot;
    try {
      response = snapshotResponse(field(raw, "response"));
    } catch {
      throw malformed();
    }
    if (receiptKey !== storeKey) {
      throw new Error("idempotency receipt source returned a receipt for a different key");
    }
    return { storeKey, fingerprint, claimId, generation: generation as number, response };
  };

  const findReceipt = async (storeKey: string): Promise<ParsedReceipt | undefined> =>
    parseReceipt(storeKey, await lookupReceipt(storeKey));

  /** Whether two receipts are the same commit: the same claim and body. */
  const sameCommit = (a: ParsedReceipt, b: ParsedReceipt): boolean => a.claimId === b.claimId && a.fingerprint === b.fingerprint;

  /**
   * Writes a receipt's response as the completed result under `version`, if `expectedVersion` still holds. A
   * write over an absence (`null`) is provisional: that absence may be a later one than the receipt's.
   */
  const writeFromReceipt = async (
    storeKey: string,
    expectedVersion: string | null,
    generation: number,
    receipt: ParsedReceipt,
    version: string = nextVersion(),
  ): Promise<boolean> =>
    store.compareAndSet(storeKey, expectedVersion, {
      state: "completed",
      version,
      generation: Math.max(generation, receipt.generation, 1),
      fingerprint: receipt.fingerprint,
      recovery: "receipt",
      response: boundSnapshot(receipt.response, maxResponseBytes, extraCredentials),
      expiresAt: now() + retentionMs,
      fromReceipt: true,
      receiptClaimId: receipt.claimId,
      ...(expectedVersion === null ? { provisional: true as const } : {}),
    });

  /**
   * How recording a receipt ended: `recorded` (written), `lost` (a newer
   * writer holds the key: read it again), `failed` (the write threw, or a
   * recheck validated the receipt whatever the write did: it decides) or
   * `gone` (no receipt is left for the key: decide again).
   */
  type Recorded = { kind: "recorded" | "lost" | "failed"; receipt: ParsedReceipt } | { kind: "gone" };

  /** Retires a copy this step wrote, and only that version, with a tombstone that keeps the receipt contract. */
  const retireQuietly = async (storeKey: string, version: string, receipt: ParsedReceipt, generation: number): Promise<void> => {
    try {
      await store.compareAndSet(storeKey, version, {
        state: "released",
        version: nextVersion(),
        generation: Math.max(generation, receipt.generation, 1),
        fingerprint: receipt.fingerprint,
        recovery: "receipt",
        expiresAt: now() + retentionMs,
      });
    } catch {
      // A failed retire leaves a provisional copy, which no read treats as commit evidence without its receipt.
    }
  };

  /**
   * Records a receipt's response as the completed result, if `expectedVersion`
   * still holds. The record names the receipt's claim, so a later step knows
   * which commit it holds. A write over an absence (`null`) cannot tell the
   * absence its caller saw from a later one (a newer claim committed and its
   * record was evicted, or the receipt expired), so the copy it writes is
   * provisional, and whatever the write did, the receipt is read again and
   * the latest one decides: the same commit promotes the copy just written,
   * a newer commit replaces it, and no receipt retires it. Only the version
   * this step wrote is ever replaced or deleted. When that lookup fails, the
   * copy is retired and the error is thrown: an unverified receipt never
   * decides.
   */
  const completeFromReceipt = async (
    storeKey: string,
    expectedVersion: string | null,
    generation: number,
    receipt: ParsedReceipt,
  ): Promise<Recorded> => {
    if (expectedVersion !== null) {
      try {
        const written = await writeFromReceipt(storeKey, expectedVersion, generation, receipt);
        return { kind: written ? "recorded" : "lost", receipt };
      } catch {
        return { kind: "failed", receipt };
      }
    }
    const version = nextVersion();
    // A lost acknowledgement leaves the write unknown (`undefined`): it may hold this version.
    let written: boolean | undefined;
    try {
      written = await writeFromReceipt(storeKey, null, generation, receipt, version);
    } catch {
      written = undefined;
    }
    const attempted = written === false ? undefined : version;
    let latest: ParsedReceipt | undefined;
    try {
      latest = await findReceipt(storeKey);
    } catch (error) {
      if (attempted !== undefined) await retireQuietly(storeKey, attempted, receipt, generation);
      throw error;
    }
    if (!latest) {
      // No commit is left: the provisional copy is retired, and a failed retire leaves it provisional.
      if (attempted !== undefined) await retireQuietly(storeKey, attempted, receipt, generation);
      return { kind: "gone" };
    }
    if (attempted !== undefined) {
      // Confirms only the version this step wrote: the same commit promotes it, a newer one replaces it.
      try {
        await writeFromReceipt(storeKey, attempted, generation, latest);
      } catch {
        // The validated receipt still decides; the copy stays provisional and a later step confirms it.
      }
    }
    // The receipt the recheck validated decides whatever the write did, also when it lost to a writer of the same
    // commit or its acknowledgement was lost: the step never reads the key again from an unverified state.
    return { kind: written === true && sameCommit(latest, receipt) ? "recorded" : "failed", receipt: latest };
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
  const fullReceiptResponse = (receipt: ParsedReceipt): StoredIdempotentResponse =>
    boundSnapshot(receipt.response, Number.POSITIVE_INFINITY, extraCredentials);

  /**
   * Replays a completed record. A copy recorded from a receipt whose parts
   * were dropped for size is served in full from that receipt, which
   * `inspect` already matched to the record's commit.
   */
  const replayOf = (record: CompletedIdempotencyRecord, receipt: ParsedReceipt | undefined): IdempotencyReplay => {
    if (record.fromReceipt === true && record.response.omitted !== undefined && receipt) {
      return { outcome: "replay", response: fullReceiptResponse(receipt), source: "receipt" };
    }
    return { outcome: "replay", response: replayable(record.response, extraCredentials), source: "store" };
  };

  /** A copy recorded from a receipt and confirmed: commit evidence while its receipt is pruned or unreachable. */
  const isConfirmedCopy = (record: ActiveIdempotencyRecord | undefined): record is CompletedIdempotencyRecord =>
    record?.state === "completed" && record.fromReceipt === true && record.provisional !== true;

  /**
   * Whether the live record already holds this exact commit, confirmed: the receipt's claim, not only its body.
   * A provisional copy of it is recorded again over its version, which confirms it.
   */
  const holdsReceipt = (live: Live, receipt: ParsedReceipt): boolean =>
    live.kind === "present" &&
    isConfirmedCopy(live.record) &&
    live.record.receiptClaimId === receipt.claimId &&
    live.record.fingerprint === receipt.fingerprint;

  type ReceiptOutcome = IdempotencyReplay | { outcome: "conflict" };

  /**
   * Records a receipt over the live record if that record is unchanged, and
   * reports it: a replay for the same body, a conflict for another body. The
   * latest receipt decides the outcome whether or not the write wins; a lost
   * write leaves the newer record untouched, and a later step records the
   * receipt. Undefined when no receipt is left after a write over an absence.
   */
  const applyReceipt = async (
    storeKey: string,
    expectedVersion: string | null,
    generation: number,
    receipt: ParsedReceipt,
    fingerprint: string,
  ): Promise<ReceiptOutcome | undefined> => {
    // A failed fenced write never hides the durable receipt; a later step records it.
    const recorded = await completeFromReceipt(storeKey, expectedVersion, generation, receipt);
    // No receipt is left for the key: the caller's step decides again.
    if (recorded.kind === "gone") return undefined;
    const decides = recorded.receipt;
    return decides.fingerprint === fingerprint
      ? { outcome: "replay", response: fullReceiptResponse(decides), source: "receipt" }
      : { outcome: "conflict" };
  };

  /**
   * Reads the live record and its commit evidence. A recovery-mode mismatch
   * with a live record is a conflict. With no live record, a retained
   * receipt is checked for every mode: a `"none"` request over it is a
   * conflict, so a handler outside the receipt contract never re-runs a
   * committed key and never sees the receipt's response. For a receipt-mode
   * request the receipt is always read, also for a record recorded from a
   * receipt, and wins over any record that does not hold that exact commit:
   * a cached copy never masks a newer durable receipt. Only a confirmed copy
   * stands in for a pruned or unreachable receipt; a provisional one without
   * its receipt leaves the key free at its version. A receipt that fails
   * validation always fails closed. The matched receipt is returned for the
   * replay.
   */
  const inspect = async (
    prepared: Prepared,
    at: number,
  ): Promise<{ done: ReceiptOutcome | undefined } | { live: Live; receipt?: ParsedReceipt }> => {
    const { storeKey, fingerprint, recovery } = prepared;
    const live = await readLive(storeKey, at);
    const record = live.kind === "present" ? live.record : undefined;
    if (record && record.recovery !== recovery) return { done: { outcome: "conflict" } };
    if (recovery === "none") {
      // A released or expired receipt claim the store still holds keeps its contract, with or without receipts.
      if (live.kind === "absent" && live.previousRecovery === "receipt") return { done: { outcome: "conflict" } };
      if (!record && (await findReceipt(storeKey))) return { done: { outcome: "conflict" } };
      return { live };
    }
    let raw: unknown;
    try {
      raw = await lookupReceipt(storeKey);
    } catch (error) {
      // A receipt-source outage never hides a complete copy of a confirmed commit: it replays (or conflicts) from
      // the store. A provisional copy, a copy missing parts, and every other record need the receipt.
      if (isConfirmedCopy(record) && record.response.omitted === undefined) return { live };
      throw error;
    }
    // The source answered: a malformed receipt, or one for another key, fails closed over any record.
    const receipt = parseReceipt(storeKey, raw);
    if (!receipt) {
      // A provisional copy without its receipt is no commit evidence: the key is free at the copy's version.
      if (record?.state === "completed" && record.provisional === true) {
        return { live: { kind: "absent", expectedVersion: record.version, previousGeneration: record.generation, previousRecovery: record.recovery } };
      }
      // A confirmed copy whose receipt the host pruned still holds its commit: it replays until its own retention ends.
      return { live };
    }
    if (holdsReceipt(live, receipt)) return { live, receipt };
    const [expected, generation] =
      live.kind === "present" ? [live.record.version, live.record.generation] : [live.expectedVersion, live.previousGeneration];
    return { done: await applyReceipt(storeKey, expected, generation, receipt, fingerprint) };
  };

  /** An acquired claim before its final lease check. */
  type Acquired = { outcome: "acquired"; token: IdempotencyToken; leaseExpiresAt: number; prepared: Prepared };
  type ClaimStepResult = Exclude<IdempotencyClaimResult, { outcome: "acquired" }> | Acquired;

  /**
   * One read-decide-write step. Returns a final result, or undefined when a
   * concurrent writer changed the record and the step must run again.
   */
  const claimStep = async (prepared: Prepared): Promise<ClaimStepResult | undefined> => {
    const at = now();
    const inspected = await inspect(prepared, at);
    if ("done" in inspected) return inspected.done;
    const { live, receipt } = inspected;
    if (live.kind === "absent") {
      return acquire(prepared.storeKey, live.expectedVersion, live.previousGeneration + 1, prepared);
    }
    const { record } = live;
    if (record.fingerprint !== prepared.fingerprint) return { outcome: "conflict" };
    if (record.state === "completed") return replayOf(record, receipt);
    if (at < record.leaseExpiresAt) return { outcome: "in_progress", retryAfterMs: retryAfter(record.leaseExpiresAt, at) };
    // The lease expired and the receipt source shows no commit: take the key over.
    if (record.recovery === "receipt") return acquire(prepared.storeKey, record.version, record.generation + 1, prepared);
    // Without commit evidence the holder may have committed: never re-run before retention ends.
    return { outcome: "indeterminate", retryAfterMs: retryAfter(record.expiresAt, at) };
  };

  const acquire = async (
    storeKey: string,
    expectedVersion: string | null,
    generation: number,
    prepared: Prepared,
  ): Promise<ClaimStepResult | undefined> => {
    const version = nextVersion();
    // The lease starts at the write, after any slow receipt lookup, so it is never already expired.
    const at = now();
    let written: boolean;
    try {
      written = await store.compareAndSet(storeKey, expectedVersion, {
        state: "pending",
        version,
        generation,
        fingerprint: prepared.fingerprint,
        recovery: prepared.recovery,
        leaseExpiresAt: at + leaseMs,
        expiresAt: at + retentionMs,
      });
    } catch (error) {
      // The store may have written the claim and lost the acknowledgement. No handler runs under it, so free
      // exactly the version this attempt wrote: a newer writer, or a write that never happened, is untouched.
      await releaseUnusedQuietly(storeKey, version, generation, prepared);
      throw error;
    }
    if (!written) return undefined;
    // Durable commit evidence is checked after the claim is recorded and before any handler runs under it,
    // so a commit that landed during the write (by a holder whose lease expired) is never run a second time.
    if (receipts) {
      let receipt: ParsedReceipt | undefined;
      try {
        receipt = await findReceipt(storeKey);
      } catch (error) {
        // No handler runs under this claim: free it so it never strands the key, then report the lookup failure.
        await releaseUnusedQuietly(storeKey, version, generation, prepared);
        throw error;
      }
      if (receipt) {
        // A receipt-mode claim records the receipt over its own version and reports it.
        if (prepared.recovery === "receipt") return applyReceipt(storeKey, version, generation, receipt, prepared.fingerprint);
        // The tombstone keeps the receipt contract, so a later "none" request without receipts still conflicts.
        // The receipt decides: a failed tombstone write leaves the lease to expire and never hides the conflict.
        await releaseUnusedQuietly(storeKey, version, generation, prepared, "receipt");
        return { outcome: "conflict" };
      }
    }
    const token: IdempotencyToken = Object.freeze({
      storeKey,
      version,
      claimId: version,
      generation,
      fingerprint: prepared.fingerprint,
      recovery: prepared.recovery,
      operation: prepared.operation,
    });
    return { outcome: "acquired", token, leaseExpiresAt: at + leaseMs, prepared };
  };

  /** Releases a claim no handler ran under. A lost write means a newer writer already owns the key. */
  const releaseUnused = async (
    storeKey: string,
    version: string,
    generation: number,
    prepared: Prepared,
    recovery: IdempotencyRecovery = prepared.recovery,
  ): Promise<void> => {
    await store.compareAndSet(storeKey, version, {
      state: "released",
      version: nextVersion(),
      generation,
      fingerprint: prepared.fingerprint,
      recovery,
      expiresAt: now() + retentionMs,
    });
  };

  /** Frees an unused claim on a failure path; the original failure is the one the caller needs. */
  const releaseUnusedQuietly = async (
    storeKey: string,
    version: string,
    generation: number,
    prepared: Prepared,
    recovery: IdempotencyRecovery = prepared.recovery,
  ): Promise<void> => {
    try {
      await releaseUnused(storeKey, version, generation, prepared, recovery);
    } catch {
      // A failed release leaves the lease to expire.
    }
  };

  const claim = async (request: IdempotencyRequest): Promise<IdempotencyClaimResult> => {
    const prepared = await prepare(request);
    if ("invalid" in prepared) {
      emit({ action: "claim", outcome: prepared.invalid.outcome, operation: prepared.operation });
      return prepared.invalid;
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const step = await claimStep(prepared);
      if (step === undefined) continue;
      if (step.outcome !== "acquired") {
        emit({ action: "claim", outcome: step.outcome, operation: prepared.operation, storeKey: prepared.storeKey });
        return step;
      }
      const { token } = step;
      const event = { action: "claim", operation: prepared.operation, storeKey: prepared.storeKey, generation: token.generation } as const;
      // The diagnostic runs inside the lease window, before the final lease check.
      emit({ ...event, outcome: "acquired" });
      // The write (or the diagnostic) outlasted the lease, so another caller may already be taking the key over:
      // never hand the claim out; retire it and try again.
      if (now() >= step.leaseExpiresAt) {
        await releaseUnused(token.storeKey, token.version, token.generation, step.prepared);
        emit({ ...event, outcome: "lease_lapsed" });
        continue;
      }
      return { outcome: "acquired", token };
    }
    // Persistent contention: another caller keeps winning the write, or every claim outlasted its lease.
    const final = { outcome: "in_progress", retryAfterMs: 1 } as const;
    emit({ action: "claim", outcome: final.outcome, operation: prepared.operation, storeKey: prepared.storeKey });
    return final;
  };

  type Reconciled = { outcome: "receipt"; receipt: ParsedReceipt; own: boolean } | { outcome: "conflict" };

  /**
   * The one reconcile step for settle and release. For a receipt-mode token
   * whose key has a receipt, records the receipt over the live record unless
   * that record already holds the same commit, then reports it relative to
   * the token: the token's own commit (`own`), another holder's commit of the
   * same body, or `conflict` for a different body. Each attempt reads the
   * record first, then the receipt, and writes only over the version (or
   * absence) it saw, so a receipt read before a key's retention ended never
   * replaces a newer claim, and no lookup is reused by a later attempt's
   * write. The latest validated receipt decides the outcome even when other
   * writers keep winning the cache write; their newer record is never
   * overwritten. After a lost write, a failed read decides with the earlier
   * receipt only when the live record is a confirmed copy of that commit.
   * Undefined when the token has no receipt contract or the latest lookup
   * found no receipt.
   */
  const reconcileReceipt = async (token: IdempotencyToken): Promise<Reconciled | undefined> => {
    if (token.recovery !== "receipt") return undefined;
    let receipt: ParsedReceipt | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      // A receipt in hand here lost its cache write to a newer record, so it is unverified: a failed read throws.
      const live = await readLive(token.storeKey, now());
      let raw: unknown;
      try {
        raw = await lookupReceipt(token.storeKey);
      } catch (error) {
        // During a source outage an earlier receipt decides only while the live record confirms the same commit.
        if (receipt !== undefined && holdsReceipt(live, receipt)) break;
        throw error;
      }
      // The source answered: a malformed receipt fails closed.
      receipt = parseReceipt(token.storeKey, raw);
      if (!receipt) return undefined;
      if (holdsReceipt(live, receipt)) break;
      const [expected, generation] =
        live.kind === "present" ? [live.record.version, live.record.generation] : [live.expectedVersion, live.previousGeneration];
      const recorded = await completeFromReceipt(token.storeKey, expected, generation, receipt);
      if (recorded.kind === "gone") {
        // The receipt read over an absence is gone: never let it decide; read the key again.
        receipt = undefined;
        continue;
      }
      // A newer commit found after a write over an absence decides instead.
      receipt = recorded.receipt;
      // A failed cache write never hides the validated receipt; a later step records it.
      if (recorded.kind !== "lost") break;
    }
    if (receipt === undefined) return undefined;
    // Persistent contention leaves the cache write to the next step; the durable receipt still decides.
    if (receipt.fingerprint !== token.fingerprint) return { outcome: "conflict" };
    // The claim id, never the generation: a generation restarts after eviction.
    return { outcome: "receipt", receipt, own: receipt.claimId === token.claimId };
  };

  /**
   * The holder's own credential headers (Set-Cookie and similar) for its
   * first delivery, from its validated snapshot only, and never a field its
   * Connection header nominates.
   */
  const holderCredentials = (snapshot: ResponseSnapshot | undefined): [string, string][] => {
    if (snapshot?.headers === undefined) return [];
    const nominated = connectionNominated(snapshot.headers);
    const credentials: [string, string][] = [];
    for (const [rawName, value] of Object.entries(snapshot.headers)) {
      const name = rawName.toLowerCase();
      if (!isCredentialHeader(name, extraCredentials) || HOP_BY_HOP_HEADERS.has(name) || nominated.has(name)) continue;
      credentials.push([name, value]);
    }
    return credentials;
  };

  /**
   * Settle's view of a reconciled receipt. The token's own commit returns the
   * receipt's replay view (the replay header rules applied, never
   * size-bounded) plus only the holder's own credential headers, so the first
   * delivery differs from every replay only by the credentials a replay must
   * never carry. Another holder's commit returns the receipt's replay view.
   * A holder response that failed validation contributes nothing.
   */
  const settleResult = (reconciled: Reconciled, snapshot: ResponseSnapshot | undefined): IdempotencySettleResult => {
    if (reconciled.outcome !== "receipt") return reconciled;
    const { receipt, own } = reconciled;
    const view = fullReceiptResponse(receipt);
    if (!own) return { outcome: "committed", response: view };
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(view.headers)) putHeader(headers, name, value);
    for (const [name, value] of holderCredentials(snapshot)) putHeader(headers, name, value);
    return { outcome: "settled", response: { status: view.status, headers, ...(view.body === undefined ? {} : { body: view.body }) } };
  };

  /** Release's view: the key is committed, so the receipt's response is reported with the replay header rules. */
  const releaseResult = (reconciled: Reconciled): IdempotencyReleaseResult => {
    if (reconciled.outcome !== "receipt") return reconciled;
    return { outcome: "committed", response: fullReceiptResponse(reconciled.receipt) };
  };

  /** Completes the token's own claim with its validated snapshot when no receipt exists. */
  const settleOwn = async (token: IdempotencyToken, snapshot: ResponseSnapshot): Promise<IdempotencySettleResult> => {
    // Only the stored replay copy is bounded.
    const stored = boundSnapshot(snapshot, maxResponseBytes, extraCredentials);
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
    if (recheck) return settleResult(recheck, snapshot);
    // The caller sends its own full response, as validated before any await: never the object it may have changed since.
    return written ? { outcome: "settled", response: deliveryOf(snapshot) } : { outcome: "stale" };
  };

  const settle = async (input: IdempotencyToken, response: IdempotentResponse): Promise<IdempotencySettleResult> => {
    const token = parseToken(input);
    if (!token) throw new TypeError("idempotency settle needs a token from claim");
    requireReceiptSource("settle", token);
    // The response is read exactly once, before any await; every later step reads this snapshot.
    let snapshot: ResponseSnapshot | undefined;
    let invalid: unknown;
    try {
      snapshot = snapshotResponse(response);
    } catch (error) {
      invalid = error;
    }
    // Commit evidence first: the holder's response must be valid only when it is the result.
    const reconciled = await reconcileReceipt(token);
    let result: IdempotencySettleResult;
    if (reconciled) result = settleResult(reconciled, snapshot);
    else if (snapshot === undefined) throw invalid;
    else result = await settleOwn(token, snapshot);
    emit({
      action: "settle",
      outcome: result.outcome,
      operation: token.operation,
      storeKey: token.storeKey,
      generation: token.generation,
    });
    return result;
  };

  const release = async (input: IdempotencyToken): Promise<IdempotencyReleaseResult> => {
    const token = parseToken(input);
    if (!token) throw new TypeError("idempotency release needs a token from claim");
    requireReceiptSource("release", token);
    // A commit exists for this key: record it instead of freeing the key for a second run.
    const reconciled = await reconcileReceipt(token);
    let result: IdempotencyReleaseResult;
    if (reconciled) {
      result = releaseResult(reconciled);
    } else {
      // A tombstone, not a delete: the next claim continues the generation instead of restarting it.
      const released = await store.compareAndSet(token.storeKey, token.version, {
        state: "released",
        version: nextVersion(),
        generation: token.generation,
        fingerprint: token.fingerprint,
        recovery: token.recovery,
        expiresAt: now() + retentionMs,
      });
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
    const { live, receipt } = inspected;
    if (live.kind === "absent") return { outcome: "absent" };
    const { record } = live;
    if (record.fingerprint !== prepared.fingerprint) return { outcome: "conflict" };
    if (record.state === "completed") return replayOf(record, receipt);
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
