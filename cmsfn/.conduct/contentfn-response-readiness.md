# ContentFn response validation and server type safety

2026-10-22 UTC. Follow-up to release authorization checkpoint `cc6e4f81e`.

## Correctness and contract

CmsFn's seven ContentFn clients now share a local typed transport-envelope validator. ContentFn business failures commonly arrive as HTTP 200 `{ ok: false, error }` responses. Previously the audit clients converted those failures into successful empty lists, while other clients returned unchecked shapes and non-CmsFn error codes. Malformed JSON, malformed envelopes/results, network failures and non-success HTTP responses containing success envelopes now return errors. Neither a missing result nor a broken upstream service is an empty successful audit page.

The validator checks the literal boolean discriminant and error code/message/details types. Known shared codes retain their identity. ContentFn missing-resource codes map to `NOT_FOUND`; existing-resource/revision-conflict codes map to `CONFLICT`; schema/patch/query validation codes map to `VALIDATION_FAILED`. Other foreign codes map to `CONTENTFN_UNAVAILABLE`. Mapped and unknown original codes remain in `error.details.upstreamCode`; HTTP status remains in `upstreamStatus`. These fields override similarly named upstream detail fields. Parser/network error messages do not include response bodies or exception text. Valid upstream error messages and other error details remain visible as before.

Endpoint-specific consumers validate the fields they use:

- Draft and published documents must match the requested identity and contain a string type; optional revision and workflow-state fields must have the expected shapes. Other document fields remain opaque JSON. CmsFn uses a small validated local HTTP projection instead of an undeclared `@contentfn/core` package import.
- Export requires format version 1, the requested dataset, a string export time, schema presence and the four array sections. Their contents remain opaque; this is not ContentFn's full archive/schema validator. Import and unpublish require their documented empty-object result.
- Audit pages require arrays and a string-or-null cursor. Events and deliveries must match the requested dataset. Events project only documented document identifiers, actor subject and changed paths; arbitrary nested body/secret fields are omitted. Invalid nested shapes and delivery statuses/attempts fail the page instead of manufacturing defaults.

The source contract was inspected in ContentFn core errors, HTTP router, docs/publish endpoints and storage, and import/export format/endpoints at sibling source head `842eb1b7e9bcb108d575af318249b256b63f8e48`. That router does **not** provide `/contentfn/audit/events` or `/contentfn/audit/webhooks`. This change does not invent those producer endpoints or claim functional audit integration.

## Type safety

Full `@cmsfn/server` typecheck now passes, replacing the 143 historical diagnostics recorded at the preceding checkpoint. No compiler options, shared packages, dependencies or lockfiles changed. Production unknown response values are narrowed at runtime. Existing HTTP tests now use an envelope reader and checked field/array/string helpers that keep result data unknown until inspected; their assertions remain intact. The remaining narrow source corrections widen the status capability accumulator to strings and accept structured objects directly in the existing logger filter instead of casting them to an index-signature type.

## Verification

- `npm run typecheck --workspace=@cmsfn/server`: passes.
- `npm test --workspace=@cmsfn/server`: 87 tests pass in 13 files.
- `npm run build --workspace=@cmsfn/server`: ESM, CJS and declaration outputs pass.
- Nine new transport tests use owned real HTTP servers across all seven clients: success and result projection, malformed JSON/envelopes/results, HTTP 500 success contradictions, HTTP 200/403 business failures, unknown-code preservation, foreign-code mapping, closed connections, mismatched document identity, unsafe audit nested fields and wrong datasets.
- Built CmsFn and the existing built ContentFn sibling were served together on owned local HTTP sockets with memory adapters. Dataset export succeeded. Missing dataset export and missing document release publication mapped actual ContentFn codes to `NOT_FOUND`. Both unsupported audit routes returned error envelopes with upstream status 404, confirming the integration gap remains visible. All servers were closed. This is local producer/consumer evidence, not deployment evidence.

Logs: `/tmp/cms-transport-types.log`, `/tmp/cms-transport-tests.log`, `/tmp/cms-transport-build.log`, `/tmp/cms-transport-producer-http.log`.

## Remaining scope

Other route authorization and request limits, upstream authentication forwarding/configuration, response byte/time limits, complete producer audit APIs, full export archive validation, release scheduling, concurrent mutations, database-provider acceptance and studio workflows remain separate requirements. Network requests are not retried; errors do not prove an attempted upstream mutation was rolled back. Passing full server typecheck does not establish whole-function production readiness.
