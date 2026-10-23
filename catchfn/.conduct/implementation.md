# CatchFn Implementation Plan (Draft)

Last updated: 2026-01-14  
Status: Planning  
Owner: Platform (Superfunctions)

## Dependencies / Pre-reqs
- `watchfn` ingestion/storage: add `bug_report` event type + schema validation.
- `watchfn` file/attachment channel (or blob adapter) for large screenshots.
- `drawfn` for screenshot annotation in the reporter widget.
- `authfn` for API key/tenant auth on ingestion and config endpoints.
- `@superfunctions/http`, `@superfunctions/db` if a thin service is added (optional).
- Optional: `botfn` for GitHub/Linear issue sync.

## Phase 0 — Alignment & Schema
- Define `bug_report` payload schema in `watchfn` (types + validation).
- Add indexes/partitioning plan (type/app/timestamp/severity/integration).
- Decide attachment size caps and blob storage adapter.
- Document ingestion contract for other agents.

## Phase 1 — SDK Core (TS)
- Create package `catchfn/typescript` (workspace entry).
- Implement `CatchFn` facade:
  - Init with watchfn client; config (user/env/hooks/integrations).
  - `captureBug` API to construct and send `bug_report` events.
- Context collectors:
  - Breadcrumbs (reuse watchfn), console buffer (opt-in), network summary (fetch/XHR intercept, opt-in), device/viewport/env.
  - Size trimming (last N logs/requests).
- Attachment pipeline:
  - Inline small data URLs; large uploads via watchfn blob channel; reference URLs in payload.
- Hooks: `beforeSend` for redaction/drop; ignore lists.
- Tests: payload construction, redaction, size caps, retries via watchfn client mock.

## Phase 2 — Reporter Widget (UI)
- Build vanilla overlay + React helper:
  - Trigger (`openReporter`, hotkey, optional floating button).
  - Screenshot capture (html2canvas or equivalent), annotation via drawfn overlay.
  - Form fields: title (required), description, steps, severity, tags, include-logs toggles.
  - Accessibility: focus trap, keyboard nav, reduced motion.
- Submission flow:
  - Collect context + attachments -> `captureBug`.
  - Success UI with optional issue link.
- Tests: Playwright flow (capture, annotate, submit); ARIA checks.

## Phase 3 — Issue Sync (Optional)
- Integrate with `botfn` to create/link GitHub/Linear issues.
- Update `integration.issueId/issueUrl` on the bug_report event after creation.
- Backfill job to sync status updates from trackers.

## Phase 4 — Session Replay (Optional v1.1)
- Add plugin to record DOM/input with redaction; produce `replayId` stored via watchfn.
- Link `replayId` in bug_report payload.

## Phase 5 — Ops & Docs
- Add README/Getting Started, config examples.
- Add retention/config notes (TTL, caps).
- Add minimal dashboards guidance (reuse watchfn queries).
- CI: lint/test/build for package; example app.

## Milestone Checkpoints
- M1: Schema + SDK core shipped.
- M2: Reporter widget shipped.
- M3: Issue sync live.
- M4: Replay plugin.
- M5: Docs + examples + stability.
