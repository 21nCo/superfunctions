import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { LogEvent, RedactionOptions } from "../src/index.js";

export const VECTORS_PATH = fileURLToPath(
  new URL("../conformance/redaction-vectors.json", import.meta.url)
);
export const PYTHON_VECTORS_PATH = fileURLToPath(
  new URL("../../python/tests/conformance/redaction-vectors.json", import.meta.url)
);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface RedactionVector {
  id: string;
  description: string;
  options?: RedactionOptions;
  layers?: {
    base?: Record<string, unknown>;
    child?: Record<string, unknown>;
    enrich?: Record<string, unknown>;
  };
  input: {
    msg: string;
    ctx?: Record<string, Json>;
    tags?: string[];
    userId?: string;
    tenantId?: string;
    fields?: Record<string, Json>;
  };
  expected: Record<string, Json>;
  /** Text that must not appear anywhere in the serialized event */
  absent?: string[];
}

export function loadVectors(): { marker: string; vectors: RedactionVector[] } {
  return JSON.parse(readFileSync(VECTORS_PATH, "utf8"));
}

interface ErrorSpec {
  name: string;
  message: string;
  stack?: string;
  cause?: Json;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Builds a vector's ctx: `$error` becomes an Error, `$bytes` binary data, `$ref` a shared or circular reference. */
export function buildContext(ctx: Record<string, Json> | undefined): Record<string, unknown> | undefined {
  if (ctx === undefined) return undefined;
  const refs: Array<{ parent: Record<string, unknown> | unknown[]; key: string | number; path: string }> = [];

  const build = (value: Json, parent: Record<string, unknown> | unknown[] | null, key: string | number): unknown => {
    if (Array.isArray(value)) {
      const array: unknown[] = [];
      value.forEach((item, index) => array.push(build(item, array, index)));
      return array;
    }
    if (!isObject(value)) return value;
    if (typeof value.$ref === "string") {
      if (parent === null) throw new Error("$ref at the root is not supported");
      refs.push({ parent, key, path: value.$ref });
      return null;
    }
    if (isObject(value.$bytes)) {
      const { text, kind } = value.$bytes as { text: string; kind: "bytes" | "mutable" | "view" };
      const bytes = Buffer.from(text, "utf8");
      if (kind === "bytes") return bytes;
      const copy = new Uint8Array(bytes).buffer;
      return kind === "mutable" ? copy : new DataView(copy);
    }
    if (isObject(value.$error)) {
      const spec = value.$error as unknown as ErrorSpec;
      const options = spec.cause !== undefined ? { cause: build(spec.cause, null, "cause") } : undefined;
      const error = new Error(spec.message, options);
      error.name = spec.name;
      if (spec.stack !== undefined) error.stack = spec.stack;
      return error;
    }
    const object: Record<string, unknown> = {};
    for (const [childKey, item] of Object.entries(value)) {
      object[childKey] = build(item, object, childKey);
    }
    return object;
  };

  const root = build(ctx, null, "") as Record<string, unknown>;
  for (const ref of refs) {
    let target: unknown = root;
    for (const segment of ref.path ? ref.path.split(".") : []) {
      target = (target as Record<string, unknown>)[segment];
    }
    (ref.parent as Record<string | number, unknown>)[ref.key] = target;
  }
  return root;
}

/** Effective ctx for a vector: enrich, base, child, then call ctx. */
export function effectiveContext(vector: RedactionVector): Record<string, unknown> | undefined {
  const call = buildContext(vector.input.ctx);
  const { base, child, enrich } = vector.layers ?? {};
  if (!base && !child && !enrich) return call;
  return { ...enrich, ...base, ...child, ...call };
}

export function vectorEvent(vector: RedactionVector): LogEvent {
  const event: LogEvent = {
    ts: "2026-10-27T00:00:00.000Z",
    level: "error",
    msg: vector.input.msg,
    name: "vectors",
    version: "0",
  };
  const ctx = effectiveContext(vector);
  if (ctx !== undefined) event.ctx = ctx;
  if (vector.input.tags) event.tags = [...vector.input.tags];
  if (vector.input.userId !== undefined) event.userId = vector.input.userId;
  if (vector.input.tenantId !== undefined) event.tenantId = vector.input.tenantId;
  return { ...event, ...structuredClone(vector.input.fields) };
}

function matchValue(actual: unknown, expected: Json, where: string): void {
  if (isObject(expected) && isObject(expected.$match)) {
    expect(typeof actual, `${where} is a string`).toBe("string");
    const { includes = [], excludes = [] } = expected.$match as { includes?: string[]; excludes?: string[] };
    for (const text of includes) expect(actual as string, `${where} includes ${text}`).toContain(text);
    for (const text of excludes) expect(actual as string, `${where} excludes ${text}`).not.toContain(text);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), `${where} is an array`).toBe(true);
    expect((actual as unknown[]).length, `${where} length`).toBe(expected.length);
    expected.forEach((item, index) => matchValue((actual as unknown[])[index], item, `${where}[${index}]`));
    return;
  }
  if (isObject(expected)) {
    expect(isObject(actual), `${where} is an object`).toBe(true);
    expect(Object.keys(actual as object).sort(), `${where} keys`).toEqual(Object.keys(expected).sort());
    for (const [key, item] of Object.entries(expected)) {
      matchValue((actual as Record<string, unknown>)[key], item, `${where}.${key}`);
    }
    return;
  }
  expect(actual, where).toEqual(expected);
}

/** Compares the fields present in `expected` (msg, ctx, tags, userId, tenantId, fields) and checks `absent`. */
export function expectVector(actual: LogEvent, vector: RedactionVector, mode: string): void {
  for (const [field, expected] of Object.entries(vector.expected)) {
    matchValue((actual as unknown as Record<string, unknown>)[field], expected, `${vector.id} (${mode}) ${field}`);
  }
  const serialized = JSON.stringify(actual);
  for (const text of vector.absent ?? []) {
    expect(serialized, `${vector.id} (${mode}) does not contain ${text}`).not.toContain(text);
  }
}
