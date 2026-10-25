# Default LogFn privacy boundary

2026-10-20. The original v0 specification explicitly requires default redaction
and masking user/tenant IDs unless opted in. Previously the logger and presets
used an empty default pipeline, and the optional string-pattern stage did not
recognize secret-bearing object keys such as `{password: "opaque-value"}`.

TypeScript and Python loggers now normalize event data and apply a terminal
privacy policy after user pipelines, before final size enforcement and sinks.
The guard covers known normalized secret/identity keys throughout context and
additional fields, credential assignments (including quoted JSON field names and
escaped quoted values), bearer/basic text and emails. User pipeline enrichment
cannot reintroduce those values after masking. Error/getter/custom-serializer/
cycle handling occurs before the guard; output remains plain bounded JSON data.
Masking failures fail closed. Independent sink snapshots prevent one sink's
mutation from affecting another. Built-in diagnostics apply masking, including
Python stage/sink names; explicit error callbacks and propagated errors remain
caller-owned.

The additive `redaction: {allowlist: [...]}` option uses exact JSON Pointer paths
to primitive leaves. It is copied at construction and inherited by children.
Parent/subtree exemptions are not supported; literal slash/tilde keys are escaped
so they cannot authorize unrelated nested fields. Existing explicit redaction
stage APIs retain their contracts, but their stage-local exceptions do not disable
the terminal boundary. README migration examples make the changed default output
and intentional identity opt-in explicit. No package rename or dependency change
is included.

## Validation

- TypeScript core: 241 tests, source typecheck and build pass. New tests exercise
  actual console presets and local HTTP transport, child inheritance, custom
  pipeline additions, errors/getters/custom serializers/cycles, nonmutation,
  sink isolation, prototype keys, exact/escaped allowlist paths, quoted JSON
  credentials, invalid policy input, and final UTF-8 event bounds. Existing
  middleware correlation tests opt in explicitly where raw identities are the
  behavior under test.
- Python 3.9 source: 43 tests pass, with one existing large-integer test skipped
  because that runtime has no integer-conversion limit. A fresh installed Python
  3.12 wheel passes all 44 tests. Strict mypy passes the three changed core/type/
  policy modules. Tests include real asyncio HTTP receipt and console output.
- Actual Chrome 154.0.8037.58: a default child logger writes during a 503 outage.
  Inspecting IndexedDB confirms private password/token/user values and fields
  injected by a custom pipeline are masked before persistence. Closing and
  reopening the browser profile delivers the masked event; acknowledgement
  removes it and another reload sends nothing. Temporary profile/server cleanup
  completes.
- Fresh npm tarball: Node 18.17.0, 20.19.0 and 22.23.3 deliver masked defaults to a
  real local HTTP server, retain the explicitly opted-in identity, and flush/close.
  Strict Node16/NodeNext consumers validate the new public options type. Core
  runtime dependency audit reports zero vulnerabilities. The packed shared HTTP
  integration also passes Node 18.18.0, 20.19.0 and 22.23.3, declarations and audit.

The existing local LogFn-to-WatchFn HTTP composition passes all eight requests
(metadata, delayed storage, failure recovery, authentication and stopped storage),
and all six admin tests pass. That composition uses memory/deterministic storage
fixtures; it is not a new database durability result.

## Boundaries still open

This is heuristic masking of documented keys and recognizable text, not a claim
that arbitrary unlabelled secrets, unusual encodings or all PII can be detected.
Application policy still matters. Calls directly into transport sinks bypass the
logger policy by design; existing durable queue entries are not retroactively
rewritten. Deliberate allowlist exceptions and custom error callbacks are host
responsibilities. Local HTTP/browser/wheel/tarball evidence is not hosted
production evidence. SecFn policy administration, informational performance
benchmarks, remaining browser/runtime matrix and package-ownership questions,
and other original readiness requirements remain open. Python full parity and
framework middleware remain future v0.2 scope in the original specification.
