# @superfunctions/evidence

Source-bound evidence records: a JSON format that says which work was checked, at which commit, with which artifacts and environment, with what outcome and until when the result counts. The package exports the record format v1 JSON Schema, its TypeScript types and `validateEvidenceRecord`, which checks a record against the commit it must come from, the evaluation time and an expiry policy.

It has no runtime dependencies and uses no Node built-ins, so the same validator runs in Node, browsers and workers.

```sh
npm install @superfunctions/evidence
```

## Validate a record

```ts
import { validateEvidenceRecord } from "@superfunctions/evidence";

const result = validateEvidenceRecord(JSON.parse(text), {
  expectedCommit: "<the 40- or 64-character commit under test>",
  now: new Date(), // or epoch milliseconds, or an RFC 3339 date-time with an offset
  expiryPolicy: { "unit-test": 24, "browser-run": 168 }, // hours after timing.completedAt
});

if (!result.ok) {
  for (const failure of result.failures) console.error(failure.code, failure.path ?? "", failure.detail ?? "");
}
```

`validateEvidenceRecord(record, options)` returns `{ ok, failures }` and never throws for plain JSON values. `ok` is true only when `failures` is empty. Each failure is `{ code, path?, detail? }`; `path` is a JSON Pointer (RFC 6901) such as `/source/artifactHashes/0/path`, and no code and path pair repeats.

Invalid options or a missing record return that one failure. Otherwise every check runs and every failure is reported. Checks that compare a member with the options (expiry, commit, status) run only when that member is well formed; a malformed member reports `EVIDENCE_MALFORMED` alone.

| Code | When | `path` | `detail` |
| --- | --- | --- | --- |
| `EVIDENCE_OPTIONS_INVALID` | `expectedCommit` is not 40 or 64 lowercase hex characters, `now` is not a valid `Date`, epoch milliseconds or RFC 3339 date-time with an offset, or `expiryPolicy` is not an object whose values are positive finite hours | | `invalid`: the option names |
| `EVIDENCE_MISSING` | The record is `undefined`, `null`, an array or not an object | | |
| `EVIDENCE_MISSING_FIELD` | A required member is absent | the member | |
| `EVIDENCE_MALFORMED` | A member breaks the format, including unknown members and `schemaVersion` other than 1 | the member | `expected` |
| `EVIDENCE_CLASS_NOT_IN_POLICY` | `expiryPolicy` has no own entry for `evidenceClass` | `/evidenceClass` | `evidenceClass` |
| `EVIDENCE_EXPIRED` | `expiresAt` is at or before `now` | `/expiresAt` | `now` |
| `EVIDENCE_EXPIRY_EXCEEDS_POLICY` | `expiresAt` is later than `timing.completedAt` plus the class's policy hours | `/expiresAt` | `maximumExpiresAt`, `policyHours` |
| `EVIDENCE_COMPLETED_IN_FUTURE` | `timing.completedAt` is later than `now` | `/timing/completedAt` | `now` |
| `EVIDENCE_COMMIT_MISMATCH` | `source.commit` is not exactly `expectedCommit` | `/source/commit` | `expectedCommit` |
| `EVIDENCE_DIRTY` | `source.dirty` is true | `/source/dirty` | |
| `EVIDENCE_NOT_PASSED` | `status` is `failed`, `blocked`, `skipped` or `not-applicable` | `/status` | `status` |

The list is exported as `EVIDENCE_FAILURE_CODES`.

## Record format v1

```json
{
  "schemaVersion": 1,
  "recordId": "set-25.unit-test.2026-11-01",
  "evidenceClass": "unit-test",
  "subjectIds": ["SET-25"],
  "status": "passed",
  "source": {
    "commit": "<40 or 64 lowercase hex characters>",
    "dirty": false,
    "lockfileSha256": null,
    "artifactHashes": [{ "path": "reports/unit.json", "sha256": "<64 lowercase hex characters>" }]
  },
  "environment": { "os": "linux", "arch": "x64", "runtime": "node 22.13.0", "tools": {} },
  "timing": { "startedAt": "2026-11-01T09:00:00Z", "completedAt": "2026-11-01T10:00:00Z", "durationMs": 3600000 },
  "expiresAt": "2026-11-02T09:00:00Z"
}
```

Every member is required unless marked optional. Unknown members are rejected at every level except inside `environment.tools` and `environment.attributes`.

- `schemaVersion`: `1`.
- `recordId`: 1 to 200 characters matching `^[A-Za-z0-9][A-Za-z0-9._:-]*$`.
- `evidenceClass`: a non-empty string of at most 100 characters. The package defines no classes; the caller's expiry policy does.
- `subjectIds`: at least one unique, non-empty string of at most 200 characters, such as `SET-25` or `A11Y-001`.
- `status`: `passed`, `failed`, `blocked`, `skipped` or `not-applicable`.
- `source.commit`: 40 or 64 lowercase hex characters. `source.dirty`: a boolean. `source.dirtyReason` (optional): a string or null. `source.lockfileSha256`: 64 lowercase hex characters, or null.
- `source.artifactHashes`: at least one `{ path, sha256, format? }`. `path` is a relative POSIX path, unique within the record: not empty, no leading `/`, no `.` or `..` segment, no backslash and no NUL. Paths are compared as exact strings. `sha256` is 64 lowercase hex characters. `format` (optional) is a free string such as `catchfn.evidence-event/v1`.
- `environment`: `os`, `arch` and `runtime` (non-empty strings), `tools` (an object of string values, may be empty) and `attributes` (optional, an object of string or null values, for example a browser or framework).
- `timing`: `startedAt` and `completedAt`, RFC 3339 date-times with an offset, with `startedAt` not later than `completedAt`, and `durationMs`, a number of at least 0.
- `expiresAt`: an RFC 3339 date-time with an offset.
- `supersedes` (optional): a record ID, or null.

Date-times take a `Z` or numeric offset and an optional fraction of a second, on a real proleptic Gregorian calendar day; `T` and `Z` may be lowercase, as RFC 3339 allows. Times compare exactly, with every fraction digit, including a `now` given as an RFC 3339 string; a `Date` or epoch-milliseconds `now` is exact to the value given. A leap second (second 60) is accepted in any minute, since the package keeps no leap-second table: it sorts after second 59 of its minute and before the next minute's second 0. The policy limit (`completedAt` plus the class's hours) is computed on the POSIX time scale, where second 60 counts as the next minute's second 0, and takes the hours as the decimal JavaScript prints for them (so `0.1` is exactly 6 minutes).

## JSON Schema

The JSON Schema (draft 2020-12, `$id` `urn:superfunctions:evidence-record:v1`) is exported as `evidenceRecordSchemaV1` (frozen) and as the file `@superfunctions/evidence/schema/evidence-record.v1.json`. It describes the same format, except for two rules JSON Schema cannot express, which only `validateEvidenceRecord` enforces: unique `artifactHashes[].path` values and `startedAt` not later than `completedAt`. The schema checks date-times with a pattern rather than `format`, so validators reject malformed dates and days a month does not have (such as 30 February, or 29 February 2100) without a format plugin.

## Not in this version

- Re-hashing artifacts against files on disk.
- Profile data such as signatures, test counts, defects or requirement ID patterns. Profiles add them on top of this format.
- Validating inputs that are not plain JSON values, such as getters, proxies or class instances.
