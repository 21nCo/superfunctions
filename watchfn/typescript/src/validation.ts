import { clip } from "./errors.js";
import type { AttributeValue, Attributes, JsonValue, QueryOrder, StorageQuery } from "./types.js";

/** Validation limits shared by ingestion, queries and storage adapters. */
export const LIMITS = Object.freeze({
  maxTypeLength: 200,
  maxAttributes: 64,
  maxAttributeKeyLength: 128,
  maxAttributeStringLength: 1024,
  maxDataBytes: 64 * 1024,
  maxDataDepth: 32,
  maxBatchSize: 100,
  maxQueryTypes: 20,
  defaultQueryLimit: 100,
  maxQueryLimit: 1000,
  /** 9999-12-31T23:59:59.999Z */
  maxTimestampMs: 253_402_300_799_999,
});

const TYPE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/;
const ATTRIBUTE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]*$/;
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/;

export interface NormalizedEvent {
  type: string;
  timestampMs?: number;
  attributes: Attributes;
  data?: JsonValue;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Reads a field only when the object owns it, so a polluted `Object.prototype`
 * (or `Array.prototype` for a sparse array's holes) never supplies input.
 */
export function ownField(value: object, key: PropertyKey): unknown {
  return Object.hasOwn(value, key) ? (value as Record<PropertyKey, unknown>)[key] : undefined;
}

/** Unknown field names reported by name; the rest are counted in one issue. */
const MAX_REPORTED_UNKNOWN_FIELDS = 10;
/** Longest caller-supplied field name echoed in an issue, in UTF-16 units plus one ellipsis. */
const MAX_REPORTED_NAME_LENGTH = 40;

/** A caller-supplied field name as an issue path shows it: cut to 40 units, surrogate pairs kept whole. */
function fieldName(key: string): string {
  return clip(key, MAX_REPORTED_NAME_LENGTH);
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: string[]): void {
  let unknown = 0;
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    unknown += 1;
    if (unknown <= MAX_REPORTED_UNKNOWN_FIELDS) issues.push(`${path}.${fieldName(key)}: unknown field`);
  }
  if (unknown > MAX_REPORTED_UNKNOWN_FIELDS) issues.push(`${path}: ${unknown - MAX_REPORTED_UNKNOWN_FIELDS} more unknown fields`);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** True for integer epoch milliseconds from 1970-01-01 to 9999-12-31, the range every adapter stores and returns. */
export function isTimestampMs(ms: unknown): ms is number {
  return typeof ms === "number" && Number.isSafeInteger(ms) && ms >= 0 && ms <= LIMITS.maxTimestampMs;
}

/** Parses a stored event's ISO timestamp for an adapter write, or throws when it is outside the stored range. */
export function storedTimestampMs(value: unknown, field: string, adapter: string): number {
  const ms = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!isTimestampMs(ms)) throw new RangeError(`${adapter} storage: ${field} must be an ISO date-time from 1970-01-01 to 9999-12-31`);
  return ms;
}

/** Parses a timestamp to epoch milliseconds, or returns an issue. */
export function parseTimestamp(value: unknown, path: string): number | string {
  let ms: number;
  if (value instanceof Date) {
    ms = value.getTime();
    if (!Number.isFinite(ms)) return `${path}: invalid Date`;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return `${path}: must be integer epoch milliseconds`;
    ms = value;
  } else if (typeof value === "string") {
    const match = ISO_PATTERN.exec(value);
    if (!match) return `${path}: must be an ISO 8601 date-time with a time zone`;
    const [year, month, day, hour, minute, second = 0] = match.slice(1, 7).map((part) => Number(part ?? 0));
    const offsetHours = match[9] === undefined ? 0 : Number(match[9]);
    const offsetMinutes = match[10] === undefined ? 0 : Number(match[10]);
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > daysInMonth(year, month) ||
      hour > 23 ||
      minute > 59 ||
      second > 59 ||
      offsetHours > 23 ||
      offsetMinutes > 59
    ) {
      return `${path}: date-time out of range`;
    }
    ms = Date.parse(value);
    if (!Number.isFinite(ms)) return `${path}: invalid date-time`;
  } else {
    return `${path}: must be a Date, epoch milliseconds or an ISO 8601 string`;
  }
  if (!isTimestampMs(ms)) return `${path}: must be between 1970-01-01 and 9999-12-31`;
  return ms;
}

export function validateType(value: unknown, path: string, issues: string[]): value is string {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${path}: must be a non-empty string`);
    return false;
  }
  if (value.length > LIMITS.maxTypeLength) {
    issues.push(`${path}: longer than ${LIMITS.maxTypeLength} characters`);
    return false;
  }
  if (!TYPE_PATTERN.test(value)) {
    issues.push(`${path}: may contain only letters, digits and _ . : / -`);
    return false;
  }
  return true;
}

function validateAttributeValue(value: unknown, path: string, issues: string[]): value is AttributeValue {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return true;
    issues.push(`${path}: must be a finite number`);
    return false;
  }
  if (typeof value === "string") {
    if (value.length <= LIMITS.maxAttributeStringLength) return true;
    issues.push(`${path}: longer than ${LIMITS.maxAttributeStringLength} characters`);
    return false;
  }
  issues.push(`${path}: must be a string, finite number or boolean`);
  return false;
}

/** Validates flat attributes and returns a detached copy. */
export function validateAttributes(value: unknown, path: string, issues: string[]): Attributes | undefined {
  if (!isPlainObject(value)) {
    issues.push(`${path}: must be a plain object`);
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length > LIMITS.maxAttributes) {
    issues.push(`${path}: more than ${LIMITS.maxAttributes} attributes`);
    return undefined;
  }
  const result: Attributes = {};
  for (const key of keys) {
    if (key.length > LIMITS.maxAttributeKeyLength || !ATTRIBUTE_KEY_PATTERN.test(key) || RESERVED_KEYS.has(key)) {
      issues.push(`${path}.${fieldName(key)}: invalid attribute name`);
      continue;
    }
    if (!Object.hasOwn(value, key)) {
      issues.push(`${path}.${fieldName(key)}: changed while it was read`);
      continue;
    }
    const item = value[key];
    if (validateAttributeValue(item, `${path}.${key}`, issues)) result[key] = item;
  }
  return result;
}

/** Serialized JSON bytes still allowed for the payload being copied. */
interface DataBudget {
  remaining: number;
  exceeded: boolean;
}

const encoder = new TextEncoder();

/** Charges `bytes` against the budget; false once the payload is too large. */
function charge(budget: DataBudget, bytes: number): boolean {
  budget.remaining -= bytes;
  if (budget.remaining < 0) budget.exceeded = true;
  return !budget.exceeded;
}

/** Charges a string as JSON.stringify writes it: quotes, escapes and UTF-8 bytes. */
function chargeString(budget: DataBudget, value: string): boolean {
  // Each UTF-16 unit takes at least one byte, so an oversized string fails before it is encoded.
  if (value.length + 2 > budget.remaining) return charge(budget, value.length + 2);
  return charge(budget, encoder.encode(JSON.stringify(value)).byteLength);
}

function changed(path: string, issues: string[]): undefined {
  issues.push(`${path}: changed while it was read`);
  return undefined;
}

/**
 * Copies an array from one read of its length: brackets and commas are charged
 * for exactly the items copied, and a getter that grows, shrinks or empties the
 * array while it is read rejects it.
 */
function copyArray(value: unknown[], path: string, depth: number, issues: string[], budget: DataBudget): JsonValue[] | undefined {
  const length = value.length;
  if (!charge(budget, length > 0 ? length + 1 : 2)) return undefined; // brackets and commas
  const copy: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      if (value.length !== length) return changed(path, issues);
      issues.push(`${path}[${index}]: sparse arrays are not JSON`);
      return undefined;
    }
    const item = copyJson(value[index], `${path}[${index}]`, depth + 1, issues, budget);
    if (item === undefined) return undefined;
    copy.push(item);
  }
  return value.length === length ? copy : changed(path, issues);
}

/**
 * Copies an object from one snapshot of its own enumerable keys. Listing the
 * keys is linear in the caller's own object and reads no values; a wide object
 * fails the comma charge before any value is read. Removing a key before it
 * is read, or changing the key count while values are read, rejects the object.
 */
function copyObject(value: Record<string, unknown>, path: string, depth: number, issues: string[], budget: DataBudget): JsonValue | undefined {
  const keys = Object.keys(value);
  if (!charge(budget, keys.length > 0 ? keys.length + 1 : 2)) return undefined; // braces and commas
  const copy: Record<string, JsonValue> = {};
  for (const key of keys) {
    if (!chargeString(budget, key) || !charge(budget, 1)) return undefined; // key and colon
    if (!Object.hasOwn(value, key)) return changed(path, issues);
    const item = copyJson(value[key], `${path}.${fieldName(key)}`, depth + 1, issues, budget);
    if (item === undefined) return undefined;
    // defineProperty keeps a "__proto__" key as data instead of changing the prototype.
    Object.defineProperty(copy, key, { value: item, enumerable: true, writable: true, configurable: true });
  }
  return Object.keys(value).length === keys.length ? copy : changed(path, issues);
}

/**
 * Checks a strict JSON value and builds a detached copy in the same pass, so
 * each property is read once and the copy is exactly what was checked. It
 * charges every value's JSON.stringify bytes against `budget` as it goes and
 * stops once they exceed it, so a graph that shares references is rejected
 * before its expansion is copied. Returns undefined after pushing an issue or
 * exhausting the budget.
 */
function copyJson(value: unknown, path: string, depth: number, issues: string[], budget: DataBudget): JsonValue | undefined {
  if (value === null || typeof value === "boolean") return charge(budget, String(value).length) ? value : undefined;
  if (typeof value === "string") return chargeString(budget, value) ? value : undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      issues.push(`${path}: must be a finite number`);
      return undefined;
    }
    return charge(budget, JSON.stringify(value).length) ? value : undefined;
  }
  if (depth >= LIMITS.maxDataDepth) {
    issues.push(`${path}: nested deeper than ${LIMITS.maxDataDepth} levels`);
    return undefined;
  }
  if (Array.isArray(value)) return copyArray(value, path, depth, issues, budget);
  if (isPlainObject(value)) return copyObject(value, path, depth, issues, budget);
  issues.push(`${path}: must be JSON (null, boolean, finite number, string, array or plain object)`);
  return undefined;
}

/** Result of {@link copyData}: the detached copy, or the issues that rejected it, and the JSON bytes charged. */
export interface DataCopy {
  copy: JsonValue | undefined;
  issues: string[];
  /** Serialized UTF-8 bytes charged; equals the copy's JSON.stringify size when a copy is returned. */
  chargedBytes: number;
}

/**
 * Copies a strict JSON payload within `maxBytes` of serialized JSON. Internal:
 * exported so tests can check that the bytes charged match the copy.
 */
export function copyData(value: unknown, path: string, maxBytes: number = LIMITS.maxDataBytes): DataCopy {
  // Own issue list: earlier problems elsewhere in the event must not skip this check.
  const own: string[] = [];
  const budget: DataBudget = { remaining: maxBytes, exceeded: false };
  const copy = copyJson(value, path, 0, own, budget);
  const chargedBytes = maxBytes - budget.remaining;
  if (budget.exceeded) return { copy: undefined, issues: [`${path}: larger than ${maxBytes} bytes as JSON`], chargedBytes };
  return { copy, issues: copy === undefined ? own : [], chargedBytes };
}

/** Validates a strict JSON payload within the size limit and returns a detached copy. */
export function validateData(value: unknown, path: string, issues: string[]): JsonValue | undefined {
  const result = copyData(value, path);
  issues.push(...result.issues);
  return result.copy;
}

/** Validates an event input without touching storage. */
export function normalizeEvent(input: unknown, path = "event"): Validated<NormalizedEvent> {
  const issues: string[] = [];
  if (!isPlainObject(input)) return { ok: false, issues: [`${path}: must be a plain object`] };
  unknownKeys(input, ["type", "timestamp", "attributes", "data"], path, issues);
  const type = ownField(input, "type");
  validateType(type, `${path}.type`, issues);
  let timestampMs: number | undefined;
  const timestamp = ownField(input, "timestamp");
  if (timestamp !== undefined) {
    const parsed = parseTimestamp(timestamp, `${path}.timestamp`);
    if (typeof parsed === "string") issues.push(parsed);
    else timestampMs = parsed;
  }
  const rawAttributes = ownField(input, "attributes");
  const attributes = rawAttributes === undefined ? {} : validateAttributes(rawAttributes, `${path}.attributes`, issues);
  const rawData = ownField(input, "data");
  const data = rawData === undefined ? undefined : validateData(rawData, `${path}.data`, issues);
  if (issues.length > 0) return { ok: false, issues };
  const event: NormalizedEvent = { type: type as string, attributes: attributes ?? {} };
  if (timestampMs !== undefined) event.timestampMs = timestampMs;
  if (data !== undefined) event.data = data;
  return { ok: true, value: event };
}

/** Validates a query and converts it to the storage adapter form. */
export function normalizeQuery(input: unknown): Validated<StorageQuery> {
  const issues: string[] = [];
  if (input === undefined) input = {};
  if (!isPlainObject(input)) return { ok: false, issues: ["query: must be a plain object"] };
  unknownKeys(input, ["from", "to", "type", "attributes", "limit", "order"], "query", issues);

  const query: StorageQuery = { attributes: [], limit: LIMITS.defaultQueryLimit, order: "desc" };
  for (const bound of ["from", "to"] as const) {
    const value = ownField(input, bound);
    if (value === undefined) continue;
    const parsed = parseTimestamp(value, `query.${bound}`);
    if (typeof parsed === "string") issues.push(parsed);
    else if (bound === "from") query.fromMs = parsed;
    else query.toMs = parsed;
  }
  if (query.fromMs !== undefined && query.toMs !== undefined && query.fromMs > query.toMs) {
    issues.push("query.from: must not be after query.to");
  }

  const type = ownField(input, "type");
  if (type !== undefined) {
    const list = Array.isArray(type);
    const types: unknown[] = list ? type : [type];
    if (types.length === 0 || types.length > LIMITS.maxQueryTypes) {
      issues.push(`query.type: must list 1 to ${LIMITS.maxQueryTypes} types`);
    } else {
      // Index every slot: forEach would skip the holes of a sparse array.
      const checked: string[] = [];
      for (let index = 0; index < types.length; index += 1) {
        const item = ownField(types, index);
        if (validateType(item, list ? `query.type[${index}]` : "query.type", issues)) checked.push(item);
      }
      query.types = [...new Set(checked)];
    }
  }

  const rawAttributes = ownField(input, "attributes");
  if (rawAttributes !== undefined) {
    const attributes = validateAttributes(rawAttributes, "query.attributes", issues);
    if (attributes) query.attributes = Object.entries(attributes);
  }

  const limit = ownField(input, "limit");
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxQueryLimit) {
      issues.push(`query.limit: must be an integer from 1 to ${LIMITS.maxQueryLimit}`);
    } else {
      query.limit = limit;
    }
  }

  const order = ownField(input, "order");
  if (order !== undefined) {
    if (order !== "asc" && order !== "desc") issues.push('query.order: must be "asc" or "desc"');
    else query.order = order as QueryOrder;
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: query };
}

/** True when a stored event satisfies a storage query's filters (ignores limit and order). */
export function matchesQuery(event: { type: string; timestampMs: number; attributes: Attributes }, query: StorageQuery): boolean {
  if (query.fromMs !== undefined && event.timestampMs < query.fromMs) return false;
  if (query.toMs !== undefined && event.timestampMs >= query.toMs) return false;
  if (query.types && !query.types.includes(event.type)) return false;
  for (const [key, value] of query.attributes) {
    if (!Object.hasOwn(event.attributes, key)) return false;
    const actual = event.attributes[key];
    if (typeof actual !== typeof value || actual !== value) return false;
  }
  return true;
}
