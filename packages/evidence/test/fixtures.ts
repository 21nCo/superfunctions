import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { evidenceRecordSchemaV1 } from "../src/index.js";
import type { EvidenceFailure, ValidateEvidenceRecordOptions } from "../src/index.js";

// Records and cases are JSON files so the format is shown as it travels.
// A case starts from a base record (or a literal `record`), then removes and
// sets members by JSON Pointer, and may override options.

type Json = unknown;

export interface Case {
  name: string;
  base?: "minimal" | "full";
  record?: Json;
  set?: Record<string, Json>;
  remove?: string[];
  options?: Partial<ValidateEvidenceRecordOptions>;
}

export interface InvalidCase extends Case {
  expected: EvidenceFailure[];
  /** Whether the documented JSON Schema path (the schema plus the cross-value checks) accepts the record; "accept" only when every failure is beyond structure. */
  schema: "reject" | "accept";
  /** Set when the plain schema accepts the record and only a cross-value check rejects it: names the rule the schema cannot express. */
  schemaNote?: string;
}

function readJson(relative: string): Json {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), "utf8"));
}

export const records = {
  minimal: readJson("./fixtures/records/minimal.json"),
  full: readJson("./fixtures/records/full.json"),
} as const;

export const cases = readJson("./fixtures/cases.json") as {
  options: ValidateEvidenceRecordOptions;
  valid: Case[];
  invalid: InvalidCase[];
};

export function tokens(pointer: string): string[] {
  return pointer
    .split("/")
    .slice(1)
    .map((token) => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function parentOf(root: Json, pointer: string): [Record<string, Json> | Json[], string] {
  const path = tokens(pointer);
  const key = path.pop() as string;
  let cursor = root as Record<string, Json>;
  for (const token of path) cursor = cursor[token] as Record<string, Json>;
  return [cursor, key];
}

export function setAt(root: Json, pointer: string, value: Json): void {
  const [parent, key] = parentOf(root, pointer);
  (parent as Record<string, Json>)[key] = structuredClone(value);
}

export function removeAt(root: Json, pointer: string): void {
  const [parent, key] = parentOf(root, pointer);
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete (parent as Record<string, Json>)[key];
}

/** Every JSON Pointer below the root of a value, parents before children. */
export function pointers(value: Json, base = ""): string[] {
  if (typeof value !== "object" || value === null) return [];
  const keys = Array.isArray(value) ? value.map((_, index) => String(index)) : Object.keys(value);
  return keys.flatMap((key) => {
    const pointer = `${base}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
    return [pointer, ...pointers((value as Record<string, Json>)[key], pointer)];
  });
}

export function materialize(entry: Case): { record: Json; options: ValidateEvidenceRecordOptions } {
  const record = entry.base ? structuredClone(records[entry.base]) : structuredClone(entry.record);
  for (const pointer of entry.remove ?? []) removeAt(record, pointer);
  for (const [pointer, value] of Object.entries(entry.set ?? {})) setAt(record, pointer, value);
  return { record, options: { ...cases.options, ...entry.options } };
}

// An independent JSON Schema validator, so the exported schema itself is
// checked and not only the hand-written validator.
const ajv = new Ajv2020({ strict: true, allErrors: true });
export const validatePlainSchema = ajv.compile(evidenceRecordSchemaV1);

// The rules standard JSON Schema cannot express, written here independently of
// src/ (Date.UTC instead of the package's calendar code). The README documents
// them as the checks a JSON Schema validator needs next to the schema.

const DATE_TIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})[Tt]([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]+))?(?:[Zz]|([+-])([0-9]{2}):([0-9]{2}))$/;

interface UtcTime {
  /** Epoch milliseconds of the UTC minute. */
  minute: number;
  second: number;
  fraction: string;
}

function utcTime(value: unknown): UtcTime | undefined {
  const match = typeof value === "string" ? DATE_TIME.exec(value) : null;
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute);
  const offset = (match[8] === "-" ? -1 : 1) * (Number(match[9] ?? 0) * 60 + Number(match[10] ?? 0));
  return { minute: date.getTime() - offset * 60_000, second, fraction: match[7] ?? "" };
}

function compareUtc(a: UtcTime, b: UtcTime): number {
  if (a.minute !== b.minute) return a.minute - b.minute;
  if (a.second !== b.second) return a.second - b.second;
  const length = Math.max(a.fraction.length, b.fraction.length);
  const left = a.fraction.padEnd(length, "0");
  const right = b.fraction.padEnd(length, "0");
  return left === right ? 0 : left < right ? -1 : 1;
}

/** JSON Pointers of the members that break a rule the plain schema cannot express. */
export function crossValueFailures(record: Json): string[] {
  if (typeof record !== "object" || record === null) return [];
  const failures: string[] = [];
  const { subjectIds, source, timing, expiresAt } = record as Record<string, Json>;
  // Ajv 8's scalar uniqueItems indexes items in a plain object, so it misses a
  // repeated "__proto__"; compare subject IDs by exact string instead.
  if (Array.isArray(subjectIds)) {
    const seen = new Set<string>();
    subjectIds.forEach((subjectId: Json, index) => {
      if (typeof subjectId !== "string") return;
      if (seen.has(subjectId)) failures.push(`/subjectIds/${index}`);
      seen.add(subjectId);
    });
  }
  const artifactHashes = (source as Record<string, Json> | null)?.artifactHashes;
  if (Array.isArray(artifactHashes)) {
    const seen = new Set<unknown>();
    artifactHashes.forEach((entry: Json, index) => {
      const path = (entry as Record<string, Json> | null)?.path;
      if (typeof path !== "string") return;
      if (seen.has(path)) failures.push(`/source/artifactHashes/${index}/path`);
      seen.add(path);
    });
  }
  const dates: Array<[string, Json]> = [["/expiresAt", expiresAt]];
  if (typeof timing === "object" && timing !== null) {
    const { startedAt, completedAt } = timing as Record<string, Json>;
    dates.push(["/timing/startedAt", startedAt], ["/timing/completedAt", completedAt]);
    const started = utcTime(startedAt);
    const completed = utcTime(completedAt);
    if (started && completed && compareUtc(started, completed) > 0) failures.push("/timing/startedAt");
  }
  for (const [pointer, value] of dates) {
    const time = utcTime(value);
    if (time?.second !== 60) continue;
    // UTC inserts a leap second only after 23:59:59 on the last day of a month.
    const next = new Date(time.minute + 60_000);
    if (next.getUTCHours() !== 0 || next.getUTCMinutes() !== 0 || next.getUTCDate() !== 1) failures.push(pointer);
  }
  return failures;
}

/** The documented JSON Schema path: the exported schema plus the cross-value checks. */
export function validateWithSchema(record: Json): boolean {
  return validatePlainSchema(record) && crossValueFailures(record).length === 0;
}

export function schemaErrors(record: Json): string {
  return JSON.stringify({ schema: validatePlainSchema.errors, crossValue: crossValueFailures(record) });
}

export const STRUCTURAL_CODES: ReadonlySet<string> = new Set(["EVIDENCE_MISSING", "EVIDENCE_MISSING_FIELD", "EVIDENCE_MALFORMED"]);
