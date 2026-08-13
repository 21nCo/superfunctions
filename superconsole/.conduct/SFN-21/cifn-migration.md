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

- `/modules/cifn` — runs and project/pipeline context;
- `/modules/cifn/runs/{runId}` — run, jobs, steps, trigger, timing, and links to permitted resource actions;
- `/modules/cifn/runs/{runId}/jobs/{jobKey}/logs` — structured/plain logs with navigation and follow behavior when supported;
- `/modules/cifn/runs/{runId}/artifacts` — artifact metadata and authorized access.

The precise route shapes may be generated from the CiFn manifest, but these user-facing paths remain stable aliases.

## Domain boundary

The CiFn admin package declares projects, pipelines, runs, jobs, runners, logs, artifacts, secrets, schedules, and webhooks. Super Console calls the shared dispatcher, which delegates to an injected CiFn service. UI route loaders do not reuse the React dashboard's direct fetch client.

## Action parity

In addition to retained reads, the CiFn capability inventory includes trigger, retry, cancel, runner management, secret rotation, artifact access, schedules, and webhook inspection. The generic module/resource pages expose actions only when permitted and bound. The specialized run-detail presentation currently prioritizes read parity; retry/cancel buttons on that view require the bound CiFn service to return the action projection and stable target identifiers. Unimplemented domain methods are never represented as clickable no-op controls.

## Presentation

UIFn supplies tables, status badges, breadcrumbs, cards, tabs, pagination, confirmations, and empty/error/loading states. Logs use an accessible console-specific viewer composite built from UIFn foundations. Artifact metadata may contain a same-origin admin URL or an explicitly marked signed HTTPS URL; mutation-style artifact issuance/deletion remains available through the declared audited action rather than being inferred from a raw storage path.

## Verification

- source API types and fixtures inform parity tests;
- run list preserves status, trigger, creation time, cursor, and navigation;
- run detail preserves job/step status and links;
- log and artifact errors retain request IDs and authorization behavior;
- declared retry/cancel operations use idempotency and produce audit receipts when invoked from the generic resource/action surface; specialized run-detail controls remain a follow-up projection;
- disabled CiFn removes all UI, REST/OpenAPI, SDK discovery, and MCP surface;
- no React runtime or iframe is required by Super Console.
