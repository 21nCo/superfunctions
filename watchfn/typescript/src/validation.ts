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

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}${key}: unknown field`);
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
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
  if (ms < 0 || ms > LIMITS.maxTimestampMs) return `${path}: must be between 1970-01-01 and 9999-12-31`;
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
      issues.push(`${path}.${key.slice(0, 40)}: invalid attribute name`);
      continue;
    }
    const item = value[key];
    if (validateAttributeValue(item, `${path}.${key}`, issues)) result[key] = item;
  }
  return result;
}

function checkJson(value: unknown, path: string, depth: number, issues: string[]): void {
  if (issues.length > 0) return;
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issues.push(`${path}: must be a finite number`);
    return;
  }
  if (depth >= LIMITS.maxDataDepth) {
    issues.push(`${path}: nested deeper than ${LIMITS.maxDataDepth} levels`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        issues.push(`${path}[${index}]: sparse arrays are not JSON`);
        return;
      }
      checkJson(value[index], `${path}[${index}]`, depth + 1, issues);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) checkJson(value[key], `${path}.${key}`, depth + 1, issues);
    return;
  }
  issues.push(`${path}: must be JSON (null, boolean, finite number, string, array or plain object)`);
}

/** Validates a strict JSON payload within the size limit and returns a detached copy. */
export function validateData(value: unknown, path: string, issues: string[]): JsonValue | undefined {
  const before = issues.length;
  checkJson(value, path, 0, issues);
  if (issues.length > before) return undefined;
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength > LIMITS.maxDataBytes) {
    issues.push(`${path}: larger than ${LIMITS.maxDataBytes} bytes as JSON`);
    return undefined;
  }
  return JSON.parse(serialized) as JsonValue;
}

/** Validates an event input without touching storage. */
export function normalizeEvent(input: unknown, path = "event"): Validated<NormalizedEvent> {
  const issues: string[] = [];
  if (!isPlainObject(input)) return { ok: false, issues: [`${path}: must be a plain object`] };
  unknownKeys(input, ["type", "timestamp", "attributes", "data"], `${path}.`, issues);
  const type = input.type;
  validateType(type, `${path}.type`, issues);
  let timestampMs: number | undefined;
  if (input.timestamp !== undefined) {
    const parsed = parseTimestamp(input.timestamp, `${path}.timestamp`);
    if (typeof parsed === "string") issues.push(parsed);
    else timestampMs = parsed;
  }
  const attributes = input.attributes === undefined ? {} : validateAttributes(input.attributes, `${path}.attributes`, issues);
  const data = "data" in input && input.data !== undefined ? validateData(input.data, `${path}.data`, issues) : undefined;
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
  unknownKeys(input, ["from", "to", "type", "attributes", "limit", "order"], "query.", issues);

  const query: StorageQuery = { attributes: [], limit: LIMITS.defaultQueryLimit, order: "desc" };
  for (const bound of ["from", "to"] as const) {
    if (input[bound] === undefined) continue;
    const parsed = parseTimestamp(input[bound], `query.${bound}`);
    if (typeof parsed === "string") issues.push(parsed);
    else if (bound === "from") query.fromMs = parsed;
    else query.toMs = parsed;
  }
  if (query.fromMs !== undefined && query.toMs !== undefined && query.fromMs > query.toMs) {
    issues.push("query.from: must not be after query.to");
  }

  if (input.type !== undefined) {
    const types = Array.isArray(input.type) ? input.type : [input.type];
    if (types.length === 0 || types.length > LIMITS.maxQueryTypes) {
      issues.push(`query.type: must list 1 to ${LIMITS.maxQueryTypes} types`);
    } else {
      types.forEach((type, index) => validateType(type, Array.isArray(input.type) ? `query.type[${index}]` : "query.type", issues));
      query.types = [...new Set(types as string[])];
    }
  }

  if (input.attributes !== undefined) {
    const attributes = validateAttributes(input.attributes, "query.attributes", issues);
    if (attributes) query.attributes = Object.entries(attributes);
  }

  if (input.limit !== undefined) {
    const limit = input.limit;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxQueryLimit) {
      issues.push(`query.limit: must be an integer from 1 to ${LIMITS.maxQueryLimit}`);
    } else {
      query.limit = limit;
    }
  }

  if (input.order !== undefined) {
    if (input.order !== "asc" && input.order !== "desc") issues.push('query.order: must be "asc" or "desc"');
    else query.order = input.order as QueryOrder;
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: query };
}

/** True when a stored event satisfies a storage query's filters (ignores limit and order). */
export function matchesQuery(event: { type: string; timestampMs: number; attributes: Attributes }, query: StorageQuery): boolean {
  if (query.fromMs !== undefined && event.timestampMs < query.fromMs) return false;
  if (query.toMs !== undefined && event.timestampMs >= query.toMs) return false;
  if (query.types && !query.types.includes(event.type)) return false;
  for (const [key, value] of query.attributes) {
    if (!Object.prototype.hasOwnProperty.call(event.attributes, key)) return false;
    const actual = event.attributes[key];
    if (typeof actual !== typeof value || actual !== value) return false;
  }
  return true;
}
