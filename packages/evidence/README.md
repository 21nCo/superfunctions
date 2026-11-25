# @superfunctions/evidence

Source-bound evidence records: a JSON format that says which work was checked, at which commit, with which artifacts and environment, with what outcome and until when the result counts. The package exports the record format v1 JSON Schema, its TypeScript types, `validateEvidenceRecord`, which checks a record against the commit it must come from, the evaluation time and an expiry policy, and `checkEvidenceCrossValues`, which checks the rules the JSON Schema cannot express.

It has no runtime dependencies. The `.` entry uses no Node built-ins, so the same validator and checker run in Node, browsers and workers. The `@superfunctions/evidence/node` entry adds `verifyEvidence`, which also re-hashes the record's artifacts in a checkout on disk.

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
| `EVIDENCE_OPTIONS_INVALID` | `expectedCommit` is not 40 or 64 lowercase hex characters, `now` is not a valid `Date`, a finite number of epoch milliseconds or an RFC 3339 date-time with an offset, or `expiryPolicy` is not an object whose values are positive finite hours | | `invalid`: the option names |
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

The list is exported as `EVIDENCE_FAILURE_CODES`, together with the `EVIDENCE_ARTIFACT_*` codes that only `verifyEvidence` reports (see below). `detail.now` and `detail.maximumExpiresAt` are RFC 3339 UTC date-times with at least millisecond digits; they are left out when the instant falls outside the years 0000 to 9999 in UTC, which RFC 3339 cannot write.

## Verify a record against a checkout

`@superfunctions/evidence/node` requires Node 22 or later.

```ts
import { verifyEvidence } from "@superfunctions/evidence/node";

const result = await verifyEvidence(JSON.parse(text), {
  expectedCommit: "<the 40- or 64-character commit under test>",
  now: new Date(),
  expiryPolicy: { "unit-test": 24 },
  artifactRoot: "/abs/path/to/checkout", // source.artifactHashes[].path is relative to it
});
```

`verifyEvidence(record, options)` runs `validateEvidenceRecord` with the same options, then re-hashes every `source.artifactHashes` entry under `artifactRoot` and resolves to the same `{ ok, failures }` shape, with the record's failures first and then the artifacts' failures in list order.

- `artifactRoot` must be an absolute path to an existing directory; otherwise the result is `EVIDENCE_OPTIONS_INVALID` alone, with `artifactRoot` in `detail.invalid` (after any other invalid option names). The root is resolved once with `realpath`, so the root may itself be a symlink or sit below one.
- When the record is missing or has a structural failure (`EVIDENCE_MISSING`, `EVIDENCE_MISSING_FIELD` or `EVIDENCE_MALFORMED`), or an option is invalid, no artifact is read. Otherwise every artifact is checked, also when the record has other failures such as `EVIDENCE_COMMIT_MISMATCH`.
- An artifact is hashed with streaming SHA-256 over its raw bytes, with no size limit, one file at a time. `format` is recorded but never interpreted: a catchfn evidence event file is bytes to this package.
- Each artifact path is walked from the root one component at a time without following symlinks. The artifact must be a regular file, with no symlink anywhere below the root, including the file itself, even when the link's target is inside the root.

| Code | When | `path` | `detail` |
| --- | --- | --- | --- |
| `EVIDENCE_ARTIFACT_MISSING` | Nothing exists at the path, or a component before the last is not a directory | `/source/artifactHashes/<i>/path` | `artifact` |
| `EVIDENCE_ARTIFACT_NOT_REGULAR_FILE` | The path names a directory, FIFO, socket or device | `/source/artifactHashes/<i>/path` | `artifact` |
| `EVIDENCE_ARTIFACT_SYMLINK` | The file or a directory between the root and it is a symlink | `/source/artifactHashes/<i>/path` | `artifact`, `symlink`: the path up to the link |
| `EVIDENCE_ARTIFACT_OUTSIDE_ROOT` | The file's real path is not under the root's real path | `/source/artifactHashes/<i>/path` | `artifact` |
| `EVIDENCE_ARTIFACT_UNREADABLE` | The file or a directory on the way cannot be read, for example without permission | `/source/artifactHashes/<i>/path` | `artifact`, `reason`: the error code, such as `EACCES` |
| `EVIDENCE_ARTIFACT_HASH_MISMATCH` | The file's SHA-256 differs from `sha256` | `/source/artifactHashes/<i>/sha256` | `artifact`, `expected`, `actual` |

`artifact` is the path as the record lists it; no detail contains an absolute path.

The verifier guards against a record that lists any path and against files that changed, were removed, were left partly written or were replaced by a symlink, directory or special file after the record was written. It does not guard against another process swapping a file or directory between the checks and the read, and it does not handle Windows path semantics (drive letters, case-insensitive names, junctions).

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

Date-times take a `Z` or numeric offset and an optional fraction of a second, on a real proleptic Gregorian calendar day; `T` and `Z` may be lowercase, as RFC 3339 allows. Times compare exactly, with every fraction digit, including a `now` given as an RFC 3339 string, and parsing stays linear in the length of the fraction. A numeric `now` (or a `Date`'s time value) is epoch milliseconds on the POSIX scale, taken at the exact value of its binary64 representation: `0.3` is 0.299999999999999988897769753748434595763683319091796875 milliseconds. Any finite number is accepted, even beyond the range a `Date` can hold. Policy hours are configuration written in decimal, so they are taken as the decimal JavaScript prints for them: `0.1` hours is exactly 6 minutes.

### Leap seconds

A leap second (second 60) is valid only where UTC inserted one: at 23:59:60 UTC, after applying the offset, on one of the 27 days in IANA's `leap-seconds.list` (tzdb 2026f, complete until 2027-06-28; the last is 2016-12-31). So `2016-12-31T23:59:60Z` and `2017-01-01T00:59:60.5+01:00` are valid, while `2026-02-28T23:59:60Z`, `2016-12-31T23:59:60+01:00` and `2026-11-01T10:00:60Z` are `EVIDENCE_MALFORMED` (or `EVIDENCE_OPTIONS_INVALID` as `now`). A leap second the IERS announces after the list expires needs a new release of this package.

A leap second sorts after second 59 of its minute and before the next minute's second 0. Policy hours are elapsed time: the cutoff is `completedAt` plus the hours, counting each inserted second inside the interval as a second, and `detail.maximumExpiresAt` is that cutoff, which can be second 60. For example, with a 1-hour policy and `completedAt` `2016-12-31T23:00:00Z` the cutoff is `2016-12-31T23:59:60Z`, so `expiresAt` `2017-01-01T00:00:00Z` fails with `EVIDENCE_EXPIRY_EXCEEDS_POLICY`; with `completedAt` `2016-12-31T23:59:60Z` the cutoff is `2017-01-01T00:59:59Z`. A numeric or `Date` `now` is a POSIX time, which has no second 60.

The package's test suite compares these results with the pinned IANA file and records every expected and actual value in `test/reference/leap-second-comparison.json` in the repository.

## JSON Schema

The JSON Schema (draft 2020-12, `$id` `urn:superfunctions:evidence-record:v1`) is exported as `evidenceRecordSchemaV1` (frozen) and as the file `@superfunctions/evidence/schema/evidence-record.v1.json`. The schema checks date-times with a pattern rather than `format`, so validators reject malformed dates and days a month does not have (such as 30 February, or 29 February 2100) without a format plugin. Its patterns avoid lookaround, `\u` escapes and `\d`/`\s`/`\w`, and every `$`-anchored pattern sits next to a length or character rule, so a trailing newline is rejected even where `$` also matches before one (Python): the schema compiles and gives the same results in ECMA-262 (Ajv), RE2 (Go) and Python validators (apart from the Ajv `uniqueItems` gap for a repeated `"__proto__"` noted below).

Four rules are beyond the schema. `validateEvidenceRecord` enforces them, and `checkEvidenceCrossValues(record)` checks them on their own, so a consumer that validates with a JSON Schema validator runs it next to the schema:

- Each `subjectIds` item is unique (exact string comparison). The schema says so with `uniqueItems`, but Ajv 8 misses a repeated `"__proto__"` string (for example `subjectIds: ["__proto__", "__proto__"]`) and accepts the record.
- Each `source.artifactHashes[].path` is unique within the record (exact string comparison), which also makes the entries unique. The schema leaves this rule to the checker and has no `uniqueItems` on `artifactHashes`: Ajv 8 compares object items with their `valueOf` and `toString` and throws a `TypeError` when an entry has those as its own members, instead of rejecting the record.
- `timing.startedAt` is not later than `timing.completedAt`, compared as instants with every fraction digit.
- A date-time with second 60 is a leap second UTC inserted. The pattern lists the leap-second days at `Z`, `+00:00` and `-00:00`, but cannot apply other offsets.

```ts
import Ajv2020 from "ajv/dist/2020.js";
import { checkEvidenceCrossValues, evidenceRecordSchemaV1 } from "@superfunctions/evidence";

const validateSchema = new Ajv2020({ strict: true }).compile(evidenceRecordSchemaV1);
const valid = validateSchema(record) && checkEvidenceCrossValues(record).length === 0;
```

`checkEvidenceCrossValues` returns `EVIDENCE_MALFORMED` failures with the same `path` and `detail` as `validateEvidenceRecord`, or an empty list. It skips members of the wrong type, which the schema reports, and never throws for plain JSON values.

## Not in this version

- Guarding re-hashing against a concurrent process or local user racing the verifier, and Windows path semantics.
- Profile data such as signatures, test counts, defects or requirement ID patterns. Profiles add them on top of this format.
- Validating inputs that are not plain JSON values, such as getters, proxies or class instances.
