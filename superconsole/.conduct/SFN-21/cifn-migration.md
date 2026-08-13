# CiFn dashboard migration

## Source behavior

The existing React dashboard provides:

- authentication gating;
- paginated/filterable run listing;
- run detail with job and step status;
- job log retrieval/display;
- artifact listing and access;
- stable API error handling.

These workflows are ported, not iframe-embedded. The React application remains migration evidence but is no longer the target operator shell.

## Super Console routes

- `/modules/cifn` — scoped control-plane runs and pipeline references;
- `/modules/cifn/runs/{runId}` — run, jobs, steps, trigger, timing, and links to permitted resource actions;
- `/modules/cifn/runs/{runId}/jobs/{jobKey}/logs` — structured/plain logs with navigation and follow behavior when supported;
- `/modules/cifn/runs/{runId}/artifacts` — artifact metadata and authorized access.

The precise route shapes may be generated from the CiFn manifest, but these user-facing paths remain stable aliases.

## Domain boundary

The CiFn admin package declares only the resources backed by the current control plane: runs, materialized jobs/steps, redacted job logs, and retained artifacts. `createCiFnControlPlaneAdminService` connects that function-owned contract to a scoped CiFn installation. A deployment may provide one static connection or resolve an isolated connection from the authorized operator scope. UI route loaders do not reuse the React dashboard's direct fetch client.

Projects, stored pipeline definitions, runner administration, secret administration, schedules, and webhook administration are deliberately absent. The current CiFn control plane has no corresponding service or persistence APIs, so exposing them would fabricate product behavior.

## Action parity

In addition to retained reads, the function-owned contract supports trigger, retry, cancel, and artifact download issuance:

- trigger invokes the real create-run API with a typed pipeline reference or inline pipeline document;
- retry resolves the original run, then creates a new workflow-dispatch run from its resolved repository pipeline reference. Inline pipelines fail with `precondition_failed` because CiFn does not retain their source document;
- cancel invokes the control plane's state-checked cancellation route;
- download returns only an HTTPS signed destination issued by the configured artifact adapter. An unsigned/memory-only artifact fails with `precondition_failed`.

Retry and cancellation are projected into the specialized run view according to run state. All mutations retain Super Console permission, scope, confirmation, idempotency, and audit enforcement.

## Presentation

UIFn supplies tables, status badges, breadcrumbs, cards, tabs, pagination, confirmations, and empty/error/loading states. Logs use an accessible console-specific viewer composite built from UIFn foundations. Artifact metadata may contain a same-origin admin URL or an explicitly marked signed HTTPS URL; mutation-style artifact issuance/deletion remains available through the declared audited action rather than being inferred from a raw storage path.

## Verification

- source API types and fixtures inform parity tests;
- run list preserves status, trigger, creation time, cursor, and navigation;
- run detail preserves job/step status and links;
- log and artifact errors retain request IDs and authorization behavior;
- trigger/list/detail/jobs/logs/artifacts/retry/cancel are exercised against `createApp` with its real store, queue, log, artifact, secret, and pipeline-resolver boundaries;
- declared retry/cancel operations use idempotency, bound confirmation, and audit receipts, including from the specialized run-detail controls;
- the production Playwright probe composes the adapter over an actual in-process CiFn control plane rather than returning fabricated run records;
- disabled CiFn removes all UI, REST/OpenAPI, SDK discovery, and MCP surface;
- no React runtime or iframe is required by Super Console.
