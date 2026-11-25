import { compareInstants, isUninsertedLeapSecond, parseRfc3339 } from "./datetime.js";
import { EXPECTED, has, isObject, isRelativePosixPath, isSubjectId, pointer } from "./json.js";
import type { EvidenceFailure } from "./types.js";

function malformed(path: string, expected: string): EvidenceFailure {
  return { code: "EVIDENCE_MALFORMED", path, detail: { expected } };
}

/**
 * Checks the record format v1 rules that the JSON Schema cannot express, or
 * that a JSON Schema validator may miss, so a consumer that validates with the
 * exported schema can run it next to the schema:
 *
 * - every subjectIds item is unique by exact string (Ajv 8's uniqueItems
 *   misses a repeated "__proto__"),
 * - every source.artifactHashes[].path is unique by exact string,
 * - timing.startedAt is not later than timing.completedAt, and
 * - a date-time with second 60 is a leap second UTC inserted (the schema
 *   pattern lists them at a zero offset but cannot apply another offset).
 *
 * Returns EVIDENCE_MALFORMED failures with the path and detail
 * validateEvidenceRecord reports for the same rule, and an empty list when
 * the record keeps all four. Members of the wrong type are skipped: the schema
 * reports those. Never throws for plain JSON values.
 */
export function checkEvidenceCrossValues(record: unknown): EvidenceFailure[] {
  const failures: EvidenceFailure[] = [];
  if (!isObject(record)) return failures;

  if (has(record, "subjectIds") && Array.isArray(record.subjectIds)) {
    const seen = new Set<string>();
    record.subjectIds.forEach((subjectId: unknown, index) => {
      if (!isSubjectId(subjectId)) return;
      if (seen.has(subjectId)) failures.push(malformed(pointer("/subjectIds", index), EXPECTED.uniqueSubjectId));
      else seen.add(subjectId);
    });
  }

  const source = has(record, "source") ? record.source : undefined;
  if (isObject(source) && has(source, "artifactHashes") && Array.isArray(source.artifactHashes)) {
    const seen = new Set<string>();
    source.artifactHashes.forEach((entry: unknown, index) => {
      if (!isObject(entry) || !has(entry, "path")) return;
      const path = entry.path;
      if (typeof path !== "string" || !isRelativePosixPath(path)) return;
      if (seen.has(path)) failures.push(malformed(pointer(pointer("/source/artifactHashes", index), "path"), EXPECTED.uniqueArtifactPath));
      else seen.add(path);
    });
  }

  const timing = has(record, "timing") && isObject(record.timing) ? record.timing : undefined;
  const dates: Array<[string, unknown]> = [];
  if (timing) {
    const startedAt = has(timing, "startedAt") ? timing.startedAt : undefined;
    const completedAt = has(timing, "completedAt") ? timing.completedAt : undefined;
    const started = parseRfc3339(startedAt);
    const completed = parseRfc3339(completedAt);
    if (started !== undefined && completed !== undefined && compareInstants(started, completed) > 0) {
      failures.push(malformed("/timing/startedAt", EXPECTED.startedNotAfterCompleted));
    }
    dates.push(["/timing/startedAt", startedAt], ["/timing/completedAt", completedAt]);
  }
  dates.push(["/expiresAt", has(record, "expiresAt") ? record.expiresAt : undefined]);
  for (const [path, value] of dates) {
    if (isUninsertedLeapSecond(value)) failures.push(malformed(path, EXPECTED.insertedLeapSecond));
  }
  return failures;
}
