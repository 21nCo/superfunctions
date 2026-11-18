/**
 * Evidence events, schema version 1.
 *
 * Every collector records its observations as one of these events. The
 * format is closed: a v1 event has exactly the fields below, and a consumer
 * can check one with {@link validateEvidenceEvent} or with any JSON Schema
 * validator and {@link evidenceEventSchema}.
 */
import type { SerializedValue } from "./utils/serialization.js";

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export const EVIDENCE_KINDS = ["console", "network", "breadcrumb", "error", "websocket"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const CONSOLE_LEVELS = ["log", "info", "warn", "error", "debug"] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

export const NETWORK_TRANSPORTS = ["fetch", "xhr"] as const;
export type NetworkTransport = (typeof NETWORK_TRANSPORTS)[number];

export const BREADCRUMB_TYPES = ["navigation", "console", "network", "user", "custom"] as const;
export type BreadcrumbType = (typeof BREADCRUMB_TYPES)[number];

export const BREADCRUMB_LEVELS = ["debug", "info", "warning", "error"] as const;
export type BreadcrumbLevel = (typeof BREADCRUMB_LEVELS)[number];

export const ERROR_SOURCES = ["error", "unhandledrejection"] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export const WEBSOCKET_EVENT_TYPES = ["open", "message", "close", "error"] as const;
export type WebSocketEventType = (typeof WEBSOCKET_EVENT_TYPES)[number];

export const WEBSOCKET_DIRECTIONS = ["sent", "received"] as const;
export type WebSocketDirection = (typeof WEBSOCKET_DIRECTIONS)[number];

export interface EvidenceEventBase {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  kind: EvidenceKind;
  /** Capture order within one loaded copy of catchfn, starting at 0. */
  seq: number;
  /** Capture time in milliseconds since the Unix epoch (`Date.now()`). */
  timestamp: number;
}

export interface ConsoleEvidenceEvent extends EvidenceEventBase {
  kind: "console";
  level: ConsoleLevel;
  args: SerializedValue[];
}

export interface NetworkEvidenceEvent extends EvidenceEventBase {
  kind: "network";
  transport: NetworkTransport;
  method: string;
  /** Redacted with `redactUrl`; never the application's raw URL. */
  url: string;
  /** Absent when the request failed before a response arrived. */
  status?: number;
  statusText?: string;
  /** Milliseconds from the call to its settlement. */
  duration?: number;
  /** Redacted with `redactHeaders`. */
  requestHeaders?: Record<string, string>;
  /** Redacted with `redactHeaders`. */
  responseHeaders?: Record<string, string>;
}

export interface BreadcrumbEvidenceEvent extends EvidenceEventBase {
  kind: "breadcrumb";
  type: BreadcrumbType;
  message?: string;
  data?: { [key: string]: SerializedValue };
  category?: string;
  level?: BreadcrumbLevel;
}

export interface ErrorEvidenceEvent extends EvidenceEventBase {
  kind: "error";
  /** The window event that reported it: an uncaught error or an unhandled rejection. */
  source: ErrorSource;
  message: string;
  /** Present when the thrown value or rejection reason is an `Error`. */
  name?: string;
  stack?: string;
  /** Script URL of an uncaught error, redacted with `redactUrl`. */
  filename?: string;
  lineno?: number;
  colno?: number;
  /**
   * The thrown value or rejection reason when it is not an `Error`, serialized.
   * Absent for an uncaught error whose `ErrorEvent.error` is null or undefined
   * (a cross-origin "Script error.", or `throw null` / `throw undefined`).
   */
  value?: SerializedValue;
}

export interface WebSocketEvidenceEvent extends EvidenceEventBase {
  kind: "websocket";
  type: WebSocketEventType;
  /** Redacted with `redactUrl`; never the application's raw URL. */
  url: string;
  /** Message events only: whether the page sent or received it. */
  direction?: WebSocketDirection;
  /** Message events only: the payload size in bytes. The payload itself is never recorded. */
  size?: number;
  /** Close events only. */
  code?: number;
  wasClean?: boolean;
}

export type EvidenceEvent =
  | ConsoleEvidenceEvent
  | NetworkEvidenceEvent
  | BreadcrumbEvidenceEvent
  | ErrorEvidenceEvent
  | WebSocketEvidenceEvent;

// Integers are JavaScript safe integers, as `validateEvidenceEvent` checks.
const safeInteger = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

const base = {
  schemaVersion: { const: EVIDENCE_SCHEMA_VERSION },
  seq: safeInteger,
  timestamp: safeInteger,
} as const;

const stringRecord = { type: "object", additionalProperties: { type: "string" } } as const;

/** JSON Schema (draft 2020-12) for one v1 evidence event. */
export const evidenceEventSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "urn:catchfn:evidence-event:v1",
  title: "catchfn evidence event v1",
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "kind", "seq", "timestamp", "level", "args"],
      properties: {
        ...base,
        kind: { const: "console" },
        level: { enum: [...CONSOLE_LEVELS] },
        args: { type: "array" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "kind", "seq", "timestamp", "transport", "method", "url"],
      properties: {
        ...base,
        kind: { const: "network" },
        transport: { enum: [...NETWORK_TRANSPORTS] },
        method: { type: "string" },
        url: { type: "string" },
        status: safeInteger,
        statusText: { type: "string" },
        duration: { type: "number", minimum: 0 },
        requestHeaders: stringRecord,
        responseHeaders: stringRecord,
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "kind", "seq", "timestamp", "type"],
      properties: {
        ...base,
        kind: { const: "breadcrumb" },
        type: { enum: [...BREADCRUMB_TYPES] },
        message: { type: "string" },
        data: { type: "object" },
        category: { type: "string" },
        level: { enum: [...BREADCRUMB_LEVELS] },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "kind", "seq", "timestamp", "source", "message"],
      properties: {
        ...base,
        kind: { const: "error" },
        source: { enum: [...ERROR_SOURCES] },
        message: { type: "string" },
        name: { type: "string" },
        stack: { type: "string" },
        filename: { type: "string" },
        lineno: safeInteger,
        colno: safeInteger,
        value: {},
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "kind", "seq", "timestamp", "type", "url"],
      properties: {
        ...base,
        kind: { const: "websocket" },
        type: { enum: [...WEBSOCKET_EVENT_TYPES] },
        url: { type: "string" },
        direction: { enum: [...WEBSOCKET_DIRECTIONS] },
        size: safeInteger,
        code: safeInteger,
        wasClean: { type: "boolean" },
      },
      // direction and size belong to message events only, code and wasClean to close events only.
      allOf: [
        { if: { properties: { type: { const: "message" } } }, else: { properties: { direction: false, size: false } } },
        { if: { properties: { type: { const: "close" } } }, else: { properties: { code: false, wasClean: false } } },
      ],
    },
  ],
} as const;

type Check = (value: unknown) => boolean;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * A callable `toJSON`, own or inherited, enumerable or not, replaces the value
 * in JSON. A `toJSON` key holding data is ordinary data, as in JSON.stringify.
 */
const hasToJson = (value: object): boolean => typeof (value as { toJSON?: unknown }).toJSON === "function";
/**
 * A record that JSON keeps as is: a plain or null-prototype object (from any
 * realm) with no callable `toJSON`. A `Date`, a `Map` or a class instance is not one.
 */
const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value) || hasToJson(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
};
const isString: Check = (value) => typeof value === "string";
const isNonNegativeInteger: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
const isNonNegativeNumber: Check = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const oneOf = (values: readonly string[]): Check => (value) => typeof value === "string" && values.includes(value);
const isStringRecord: Check = (value) => isPlainRecord(value) && Object.values(value).every(isString);
const isJsonValue: Check = (value) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return !hasToJson(value) && value.every(isJsonValue);
  return isPlainRecord(value) && Object.values(value).every(isJsonValue);
};

const common: Record<string, Check> = {
  schemaVersion: (value) => value === EVIDENCE_SCHEMA_VERSION,
  kind: isString,
  seq: isNonNegativeInteger,
  timestamp: isNonNegativeInteger,
};

interface Shape {
  required: Record<string, Check>;
  optional: Record<string, Check>;
  /** Optional fields allowed only when the `type` field has the given value. */
  onlyForType?: Record<string, string>;
}

const shapes: Record<EvidenceKind, Shape> = {
  console: {
    required: { ...common, level: oneOf(CONSOLE_LEVELS), args: (value) => Array.isArray(value) && isJsonValue(value) },
    optional: {},
  },
  network: {
    required: { ...common, transport: oneOf(NETWORK_TRANSPORTS), method: isString, url: isString },
    optional: {
      status: isNonNegativeInteger,
      statusText: isString,
      duration: isNonNegativeNumber,
      requestHeaders: isStringRecord,
      responseHeaders: isStringRecord,
    },
  },
  breadcrumb: {
    required: { ...common, type: oneOf(BREADCRUMB_TYPES) },
    optional: {
      message: isString,
      data: (value) => isPlainRecord(value) && isJsonValue(value),
      category: isString,
      level: oneOf(BREADCRUMB_LEVELS),
    },
  },
  error: {
    required: { ...common, source: oneOf(ERROR_SOURCES), message: isString },
    optional: {
      name: isString,
      stack: isString,
      filename: isString,
      lineno: isNonNegativeInteger,
      colno: isNonNegativeInteger,
      value: isJsonValue,
    },
  },
  websocket: {
    required: { ...common, type: oneOf(WEBSOCKET_EVENT_TYPES), url: isString },
    optional: {
      direction: oneOf(WEBSOCKET_DIRECTIONS),
      size: isNonNegativeInteger,
      code: isNonNegativeInteger,
      wasClean: (value) => typeof value === "boolean",
    },
    onlyForType: { direction: "message", size: "message", code: "close", wasClean: "close" },
  },
};

/**
 * Check a value against the v1 event format. Returns the list of problems;
 * an empty list means the value is a valid v1 event.
 */
export function validateEvidenceEvent(value: unknown): string[] {
  try {
    return problems(value);
  } catch {
    // A throwing getter, a proxy or a structure too deep to walk is not a v1 event.
    return ["event could not be read"];
  }
}

// Only own entries of a shape table count: `toString`, `constructor` and
// `__proto__` are never event fields.
const ownCheck = (table: Record<string, Check>, field: string): Check | undefined =>
  Object.hasOwn(table, field) ? table[field] : undefined;

function problems(value: unknown): string[] {
  // The event itself must keep its JSON form too: plain, with no callable toJSON.
  if (!isPlainRecord(value)) return ["event must be a plain object"];
  // Each field is read once, from its own data property: a getter could
  // answer one way here (as the `kind` or `type` that selects the checks) and
  // another way when the event is serialized.
  const fields: Record<string, unknown> = Object.create(null);
  const accessors: string[] = [];
  for (const field of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor && "value" in descriptor) fields[field] = descriptor.value;
    else accessors.push(`${field} must be a data property`);
  }
  if (accessors.length > 0) return accessors;
  const kind = fields.kind;
  if (typeof kind !== "string" || !(EVIDENCE_KINDS as readonly string[]).includes(kind)) {
    return [`kind must be one of ${EVIDENCE_KINDS.join(", ")}`];
  }
  const shape = shapes[kind as EvidenceKind];
  const errors: string[] = [];
  for (const [field, check] of Object.entries(shape.required)) {
    if (!Object.hasOwn(fields, field)) errors.push(`${field} is required`);
    else if (!check(fields[field])) errors.push(`${field} is invalid`);
  }
  for (const field of Object.keys(fields)) {
    if (Object.hasOwn(shape.required, field)) continue;
    const check = ownCheck(shape.optional, field);
    if (typeof check !== "function") errors.push(`${field} is not a ${kind} event field`);
    else if (!check(fields[field])) errors.push(`${field} is invalid`);
    else {
      const type = shape.onlyForType && Object.hasOwn(shape.onlyForType, field) ? shape.onlyForType[field] : undefined;
      if (type !== undefined && fields.type !== type) errors.push(`${field} is only a ${type} ${kind} event field`);
    }
  }
  return errors;
}

export function isEvidenceEvent(value: unknown): value is EvidenceEvent {
  return validateEvidenceEvent(value).length === 0;
}

let nextSeq = 0;

/** @internal Next capture sequence number. */
export function takeSeq(): number {
  const seq = nextSeq;
  nextSeq = nextSeq >= Number.MAX_SAFE_INTEGER ? 0 : nextSeq + 1;
  return seq;
}

/** @internal Freeze a captured event and everything inside it. */
export function freezeEvent<T extends EvidenceEvent>(event: T): T {
  const freeze = (value: unknown): void => {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const entry of Object.values(value)) freeze(entry);
  };
  freeze(event);
  return event;
}
