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
  /** Whether the exported JSON Schema rejects the record; "accept" for records whose only failures are policy checks or constraints JSON Schema cannot express. */
  schema: "reject" | "accept";
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
export const validateWithSchema = ajv.compile(evidenceRecordSchemaV1);

export const STRUCTURAL_CODES: ReadonlySet<string> = new Set(["EVIDENCE_MISSING", "EVIDENCE_MISSING_FIELD", "EVIDENCE_MALFORMED"]);
