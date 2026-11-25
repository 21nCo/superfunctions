import { addHours, compareInstants, formatInstant, fromEpochMilliseconds, isUninsertedLeapSecond, parseRfc3339 } from "./datetime.js";
import type { Instant } from "./datetime.js";
import { EXPECTED, codePoints, has, isObject, isRelativePosixPath, isSubjectId, pointer } from "./json.js";
import type { JsonObject } from "./json.js";
import type {
  EvidenceFailure,
  EvidenceFailureCode,
  EvidenceStatus,
  EvidenceValidationResult,
  ValidateEvidenceRecordOptions,
} from "./types.js";

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const STATUSES: ReadonlySet<string> = new Set<EvidenceStatus>(["passed", "failed", "blocked", "skipped", "not-applicable"]);

interface Settings {
  expectedCommit: string;
  now: Instant;
  expiryPolicy: ReadonlyMap<string, number>;
}

/** What the structural pass learned, for the checks that compare members with the options. */
interface Facts {
  evidenceClass?: string;
  status?: string;
  commit?: string;
  dirty?: boolean;
  completedAt?: Instant;
  expiresAt?: Instant;
}

class Failures {
  readonly list: EvidenceFailure[] = [];
  private readonly seen = new Set<string>();

  add(code: EvidenceFailureCode, path?: string, detail?: Readonly<Record<string, unknown>>): void {
    const key = path === undefined ? code : `${code} ${path}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const failure: EvidenceFailure = { code };
    if (path !== undefined) failure.path = path;
    if (detail !== undefined) failure.detail = detail;
    this.list.push(failure);
  }

  malformed(path: string, expected: string): void {
    this.add("EVIDENCE_MALFORMED", path, { expected });
  }
}

/** Reports absent required members and unknown members of an object. */
function checkMembers(failures: Failures, value: JsonObject, base: string, required: readonly string[], optional: readonly string[]): void {
  for (const key of required) {
    if (!has(value, key)) failures.add("EVIDENCE_MISSING_FIELD", pointer(base, key));
  }
  const known = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!known.has(key) && value[key] !== undefined) failures.malformed(pointer(base, key), "no unknown members");
  }
}

interface StringRule {
  min?: number;
  max?: number;
  pattern?: RegExp;
  expected: string;
}

/** Returns the member when it is a string that meets the rule. Absent members return undefined without a failure. */
function readString(failures: Failures, value: JsonObject, base: string, key: string, rule: StringRule): string | undefined {
  if (!has(value, key)) return undefined;
  const member = value[key];
  const path = pointer(base, key);
  if (typeof member !== "string") {
    failures.malformed(path, rule.expected);
    return undefined;
  }
  const length = codePoints(member);
  if ((rule.min !== undefined && length < rule.min) || (rule.max !== undefined && length > rule.max) || (rule.pattern && !rule.pattern.test(member))) {
    failures.malformed(path, rule.expected);
    return undefined;
  }
  return member;
}

/** Reads an optional member that may be null or meet a string rule. */
function readNullableString(failures: Failures, value: JsonObject, base: string, key: string, rule: StringRule): void {
  if (has(value, key) && value[key] !== null) readString(failures, value, base, key, rule);
}

function readDateTime(failures: Failures, value: JsonObject, base: string, key: string): Instant | undefined {
  if (!has(value, key)) return undefined;
  const time = parseRfc3339(value[key]);
  if (time === undefined) failures.malformed(pointer(base, key), isUninsertedLeapSecond(value[key]) ? EXPECTED.insertedLeapSecond : EXPECTED.dateTime);
  return time;
}

/** Reads an object member; reports it when it is present but not an object. */
function readObject(failures: Failures, value: JsonObject, base: string, key: string): JsonObject | undefined {
  if (!has(value, key)) return undefined;
  const member = value[key];
  if (!isObject(member)) {
    failures.malformed(pointer(base, key), "an object");
    return undefined;
  }
  return member;
}

const RECORD_ID_RULE: StringRule = { min: 1, max: 200, pattern: RECORD_ID, expected: "1 to 200 characters matching ^[A-Za-z0-9][A-Za-z0-9._:-]*$" };
const SHA256_RULE: StringRule = { pattern: SHA256, expected: "64 lowercase hex characters" };
const NON_EMPTY: StringRule = { min: 1, expected: "a non-empty string" };

function checkSubjectIds(failures: Failures, record: JsonObject): void {
  if (!has(record, "subjectIds")) return;
  const subjectIds = record.subjectIds;
  if (!Array.isArray(subjectIds) || subjectIds.length === 0) {
    failures.malformed("/subjectIds", "an array of at least one subject ID");
    return;
  }
  const seen = new Set<string>();
  subjectIds.forEach((subjectId: unknown, index) => {
    const path = pointer("/subjectIds", index);
    if (!isSubjectId(subjectId)) failures.malformed(path, "a non-empty string of at most 200 characters");
    else if (seen.has(subjectId)) failures.malformed(path, EXPECTED.uniqueSubjectId);
    else seen.add(subjectId);
  });
}

function checkArtifactHashes(failures: Failures, source: JsonObject): void {
  if (!has(source, "artifactHashes")) return;
  const artifactHashes = source.artifactHashes;
  if (!Array.isArray(artifactHashes) || artifactHashes.length === 0) {
    failures.malformed("/source/artifactHashes", "an array of at least one artifact hash");
    return;
  }
  const paths = new Set<string>();
  artifactHashes.forEach((entry: unknown, index) => {
    const base = pointer("/source/artifactHashes", index);
    if (!isObject(entry)) {
      failures.malformed(base, "an object");
      return;
    }
    checkMembers(failures, entry, base, ["path", "sha256"], ["format"]);
    const path = readString(failures, entry, base, "path", { expected: "a relative POSIX path" });
    if (path !== undefined) {
      if (!isRelativePosixPath(path)) failures.malformed(pointer(base, "path"), "a relative POSIX path without . or .. segments, backslashes or NUL");
      else if (paths.has(path)) failures.malformed(pointer(base, "path"), EXPECTED.uniqueArtifactPath);
      else paths.add(path);
    }
    readString(failures, entry, base, "sha256", SHA256_RULE);
    readString(failures, entry, base, "format", { expected: "a string" });
  });
}

function checkSource(failures: Failures, record: JsonObject, facts: Facts): void {
  const source = readObject(failures, record, "", "source");
  if (!source) return;
  checkMembers(failures, source, "/source", ["commit", "dirty", "lockfileSha256", "artifactHashes"], ["dirtyReason"]);
  facts.commit = readString(failures, source, "/source", "commit", { pattern: COMMIT, expected: "40 or 64 lowercase hex characters" });
  if (has(source, "dirty")) {
    if (typeof source.dirty === "boolean") facts.dirty = source.dirty;
    else failures.malformed("/source/dirty", "a boolean");
  }
  readNullableString(failures, source, "/source", "dirtyReason", { expected: "a string or null" });
  readNullableString(failures, source, "/source", "lockfileSha256", { ...SHA256_RULE, expected: "64 lowercase hex characters or null" });
  checkArtifactHashes(failures, source);
}

/** Checks an object whose members are all strings, or strings and null. */
function checkStringMap(failures: Failures, value: JsonObject, base: string, allowNull: boolean): void {
  for (const key of Object.keys(value)) {
    const member = value[key];
    if (typeof member === "string" || (allowNull && member === null)) continue;
    failures.malformed(pointer(base, key), allowNull ? "a string or null" : "a string");
  }
}

function checkEnvironment(failures: Failures, record: JsonObject): void {
  const environment = readObject(failures, record, "", "environment");
  if (!environment) return;
  checkMembers(failures, environment, "/environment", ["os", "arch", "runtime", "tools"], ["attributes"]);
  for (const key of ["os", "arch", "runtime"]) readString(failures, environment, "/environment", key, NON_EMPTY);
  const tools = readObject(failures, environment, "/environment", "tools");
  if (tools) checkStringMap(failures, tools, "/environment/tools", false);
  const attributes = readObject(failures, environment, "/environment", "attributes");
  if (attributes) checkStringMap(failures, attributes, "/environment/attributes", true);
}

function checkTiming(failures: Failures, record: JsonObject, facts: Facts): void {
  const timing = readObject(failures, record, "", "timing");
  if (!timing) return;
  checkMembers(failures, timing, "/timing", ["startedAt", "completedAt", "durationMs"], []);
  const startedAt = readDateTime(failures, timing, "/timing", "startedAt");
  facts.completedAt = readDateTime(failures, timing, "/timing", "completedAt");
  if (startedAt !== undefined && facts.completedAt !== undefined && compareInstants(startedAt, facts.completedAt) > 0) {
    failures.malformed("/timing/startedAt", EXPECTED.startedNotAfterCompleted);
  }
  if (has(timing, "durationMs")) {
    const durationMs = timing.durationMs;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) failures.malformed("/timing/durationMs", "a number of at least 0");
  }
}

/** The structural pass: every member against record format v1. */
function checkRecord(failures: Failures, record: JsonObject): Facts {
  const facts: Facts = {};
  checkMembers(
    failures,
    record,
    "",
    ["schemaVersion", "recordId", "evidenceClass", "subjectIds", "status", "source", "environment", "timing", "expiresAt"],
    ["supersedes"],
  );
  if (has(record, "schemaVersion") && record.schemaVersion !== 1) failures.malformed("/schemaVersion", "1");
  readString(failures, record, "", "recordId", RECORD_ID_RULE);
  facts.evidenceClass = readString(failures, record, "", "evidenceClass", { min: 1, max: 100, expected: "a non-empty string of at most 100 characters" });
  checkSubjectIds(failures, record);
  if (has(record, "status")) {
    if (typeof record.status === "string" && STATUSES.has(record.status)) facts.status = record.status;
    else failures.malformed("/status", "passed, failed, blocked, skipped or not-applicable");
  }
  checkSource(failures, record, facts);
  checkEnvironment(failures, record);
  checkTiming(failures, record, facts);
  facts.expiresAt = readDateTime(failures, record, "", "expiresAt");
  readNullableString(failures, record, "", "supersedes", { ...RECORD_ID_RULE, expected: "a record ID or null" });
  return facts;
}

/** Any finite number of epoch milliseconds, at its exact binary64 value; an invalid Date's NaN is not one. */
function fromMilliseconds(value: number): Instant | undefined {
  return Number.isFinite(value) ? fromEpochMilliseconds(value) : undefined;
}

function readNow(value: unknown): Instant | undefined {
  if (typeof value === "number") return fromMilliseconds(value);
  if (typeof value === "string") return parseRfc3339(value);
  if (typeof value !== "object" || value === null) return undefined;
  try {
    // Works for Dates from any realm; throws for every other object.
    return fromMilliseconds(Date.prototype.getTime.call(value));
  } catch {
    return undefined;
  }
}

function readExpiryPolicy(value: unknown): Map<string, number> | undefined {
  if (!isObject(value)) return undefined;
  const policy = new Map<string, number>();
  for (const key of Object.keys(value)) {
    const hours = value[key];
    if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) return undefined;
    policy.set(key, hours);
  }
  return policy;
}

function readOptions(options: unknown): Settings | { invalid: string[] } {
  if (!isObject(options)) return { invalid: ["options"] };
  const invalid: string[] = [];
  const expectedCommit = options.expectedCommit;
  if (typeof expectedCommit !== "string" || !COMMIT.test(expectedCommit)) invalid.push("expectedCommit");
  const now = readNow(options.now);
  if (now === undefined) invalid.push("now");
  const expiryPolicy = readExpiryPolicy(options.expiryPolicy);
  if (expiryPolicy === undefined) invalid.push("expiryPolicy");
  if (invalid.length > 0 || now === undefined || expiryPolicy === undefined) return { invalid };
  return { expectedCommit: expectedCommit as string, now, expiryPolicy };
}

function nowDetail(now: Instant): Readonly<Record<string, unknown>> | undefined {
  const formatted = formatInstant(now);
  return formatted === undefined ? undefined : { now: formatted };
}

function result(failures: EvidenceFailure[]): EvidenceValidationResult {
  return { ok: failures.length === 0, failures };
}

/** The policy, expiry and completion checks against the evaluation time. */
function checkTimes(failures: Failures, facts: Facts, now: Instant, expiryPolicy: ReadonlyMap<string, number>): void {
  const policyHours = facts.evidenceClass === undefined ? undefined : expiryPolicy.get(facts.evidenceClass);
  if (facts.evidenceClass !== undefined && policyHours === undefined) {
    failures.add("EVIDENCE_CLASS_NOT_IN_POLICY", "/evidenceClass", { evidenceClass: facts.evidenceClass });
  }
  if (facts.expiresAt !== undefined && compareInstants(facts.expiresAt, now) <= 0) {
    failures.add("EVIDENCE_EXPIRED", "/expiresAt", nowDetail(now));
  }
  const maximum = facts.completedAt !== undefined && policyHours !== undefined ? addHours(facts.completedAt, policyHours) : undefined;
  if (facts.expiresAt !== undefined && maximum !== undefined && compareInstants(facts.expiresAt, maximum) > 0) {
    const maximumExpiresAt = formatInstant(maximum);
    failures.add("EVIDENCE_EXPIRY_EXCEEDS_POLICY", "/expiresAt", maximumExpiresAt === undefined ? { policyHours } : { maximumExpiresAt, policyHours });
  }
  if (facts.completedAt !== undefined && compareInstants(facts.completedAt, now) > 0) {
    failures.add("EVIDENCE_COMPLETED_IN_FUTURE", "/timing/completedAt", nowDetail(now));
  }
}

/**
 * Validates an evidence record (format v1) against the commit it must come
 * from, the evaluation time and an expiry policy. Runs in any JavaScript
 * runtime and never throws for plain JSON values. Invalid options or a
 * missing record return that one failure; otherwise every failure is reported.
 */
export function validateEvidenceRecord(record: unknown, options: ValidateEvidenceRecordOptions): EvidenceValidationResult {
  const settings = readOptions(options);
  if ("invalid" in settings) return result([{ code: "EVIDENCE_OPTIONS_INVALID", detail: { invalid: settings.invalid } }]);
  if (!isObject(record)) return result([{ code: "EVIDENCE_MISSING" }]);

  const failures = new Failures();
  const facts = checkRecord(failures, record);
  const { now, expiryPolicy, expectedCommit } = settings;
  checkTimes(failures, facts, now, expiryPolicy);
  if (facts.commit !== undefined && facts.commit !== expectedCommit) {
    failures.add("EVIDENCE_COMMIT_MISMATCH", "/source/commit", { expectedCommit });
  }
  if (facts.dirty === true) failures.add("EVIDENCE_DIRTY", "/source/dirty");
  if (facts.status !== undefined && facts.status !== "passed") {
    failures.add("EVIDENCE_NOT_PASSED", "/status", { status: facts.status });
  }
  return result(failures.list);
}
