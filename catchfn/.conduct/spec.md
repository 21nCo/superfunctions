# CatchFn Specification (Draft)

Last updated: 2026-01-14  
Status: Draft (implementation not started)  
Owner: Platform (Superfunctions)

## Goal
Create `catchfn`, a self-hosted bug capture and reporting layer (similar to Bugasura/Jam.dev) built on top of existing Superfunctions primitives. Focus on lightweight in-app reporting, automated context capture, issue syncing, and reuse of `watchfn` for ingestion/analysis.

## Scope (v1)
- In-app reporter widget (JS/browser) that lets users submit a bug with screenshot/annotation, description, steps, severity, tags.
- Automatic context capture: URL, user/session, environment, console logs, network requests summary, breadcrumbs, device info.
- Manual API: `catchFn().captureBug()` to programmatically submit bug reports.
- Storage/transport: reuse `watchfn` ingestion/event router; introduce `bug_report` event type.
- Issue sync: optional auto-create/link to GitHub/Linear via existing `botfn` integrations.
- Attachments: inline screenshot (base64 or blob reference) and optional additional attachments (URLs or uploaded via `watchfn` file channel if available).

## Persistence & Storage
- Transport: reuse `watchfn` ingestion endpoint/auth/batching; no new transport surface.
- Schema: extend `watchfn` event schema with `type: "bug_report"` and the data model above; validate required fields at ingest.
- Storage: same datastore as other watchfn events; partition by `app`/`type`; indexes on (`type`, `app`, `timestamp`), (`type`, `app`, `report.severity`), (`integration.issueId`), (`sessionId`), (`replayId`).
- Attachments: small images inline (data URL); large assets uploaded via watchfn’s file channel/blob adapter and stored as URLs in the event record.
- Query: accessible via watchfn query API with filters for `type = bug_report`, severity, tags, time range, app.
- Retention: default to watchfn retention; allow `bug_report`-specific TTL override and size caps (truncate console/network logs to last N).

## Non-Goals (v1)
- Full dashboard UI (rely on `watchfn` queries/filters for now).
- Native mobile SDKs (web-only; React Native later).
- Video/session replay (planned v1.1).
- On-prem deployment changes (reuse existing `watchfn` deployment).

## Personas & Use Cases
- Frontend engineers: fast repro context when a user reports an issue.
- QA: submit annotated repros during test runs; auto-file to GitHub/Linear.
- Support: capture user-facing issues with environment + logs without dev tools.

## Architecture
- Client SDK (`catchfn/typescript/src`):
  - Wraps/depends on `watchfn` browser client for transport and breadcrumbs.
  - Reporter widget UI (vanilla + React helper) that triggers capture + UI overlay.
  - Uses `drawfn` for screenshot annotation.
- Event model:
  - New event type `bug_report` in `watchfn` ingestion schema.
  - Stored alongside other watch events; query via `watchfn` API.
- Issue sync:
  - Optional webhook/bridge to `botfn` persistence service to create/link issues (GitHub/Linear).
  - Status sync via existing `botfn` jobs/hooks.
- Session replay (v1.1):
  - Plugin that records DOM mutations/redacted inputs; links `replayId` to bug report.

## Data Model (`bug_report` event)
- `id`: string (generated client-side)
- `timestamp`: ISO string
- `type`: "bug_report"
- `app`: { name, version? }
- `user`: { id?, email?, name? } (configurable; redaction supported)
- `sessionId`: string
- `context`: {
  url,
  locale?,
  env?: "prod" | "staging" | "dev" | string,
  release?: string,
  featureFlags?: Record<string, boolean|string>,
  viewport?: { width, height, dpr },
  device?: { os, browser, ua },
  network?: { downlink?, rtt?, effectiveType? },
  console?: Array<{ level, message, ts }>,
  networkLogs?: Array<{ method, url, status?, durationMs?, error? }>,
  breadcrumbs?: Breadcrumb[],
  custom?: Record<string, any>
}
- `report`: {
  title: string,
  description?: string,
  steps?: string[],
  severity?: "critical" | "high" | "medium" | "low",
  tags?: string[],
}
- `attachments`: [
  {
    kind: "screenshot" | "file" | "link",
    mimeType?: string,
    dataUrl?: string,   # for small images (configurable size cap)
    url?: string,       # for uploaded asset
    annotationScene?: Scene  # drawfn scene for annotations
  }
]
- `integration`: {
  target?: "github" | "linear",
  project?: string,
  issueId?: string,     # when linked/created
  issueUrl?: string
}
- `replayId?`: string (when session replay enabled)

## Client API (TS)
```ts
import { catchFn } from "catchfn";

const catcher = catchFn({
  name: "my-app",
  watch: { apiKey, endpoint },   // passed to watchfn init
  user: () => ({ id: user.id, email: user.email }),
  env: "prod",
  enableConsoleCapture: true,
  enableNetworkCapture: true,
  beforeSend: (event) => event,  // allow redaction/drop
  integrations: { github: { repo: "org/repo", token?: string }, linear: { teamId: "ENG" } },
});

// Manual capture
await catcher.captureBug({
  title: "Checkout button unresponsive",
  description: "Clicks do nothing on Safari",
  steps: ["Go to /checkout", "Click Pay"],
  severity: "high",
  tags: ["checkout", "safari"],
});

// Open reporter widget (end-user/QA flow)
catcher.openReporter();
```

Key classes/modules:
- `CatchFn`: main facade; holds watchfn client, config, reporters.
- `ReporterWidget`: overlay UI; collects form inputs, captures screenshot, allows annotation via `drawfn`.
- `ContextCollectors`: console log buffer, network interceptor (wraps fetch/XMLHttpRequest), device/env collectors; must be opt-in and size-capped.
- `Uploader`: (optional) uploads large attachments to watchfn file channel or provided endpoint; falls back to dataURL for small images.

## UI/UX (Reporter Widget)
- Trigger: `catcher.openReporter()` or global hotkey (configurable) or floating button (opt-in).
- Flow:
  1) Capture screenshot of current viewport (html2canvas or browser capture API).
  2) Annotate using `drawfn` overlay (arrows, boxes, text, blur).
  3) Form: title (required), description, steps, severity, tags, checkbox to include console/network logs.
  4) Submit -> calls `captureBug`; shows success + issue link if integration enabled.
- Accessibility: focus trap, keyboard navigation, prefers-reduced-motion respect.

## Transport & Ingestion
- Reuse `watchfn` browser client; add `bug_report` event type.
- Batching/resilience: leverage `watchfn` batcher; retries with backoff; drop on exceeding size cap.
- Size limits: enforce configurable max payload; compress console/network logs (truncate to last N).
- Security: API key via `watchfn` auth; CORS same as watchfn.

## Issue Sync (GitHub/Linear)
- Client includes optional `integration` hint.
- Server-side (via `botfn` service or lightweight handler) creates issue and writes back `issueId/issueUrl`.
- Status sync: when issue closes, propagate to watchfn/botfn state (future v1.1).

## Session Replay (v1.1)
- Optional plugin that records DOM mutations + input events with redaction; stores `replayId` via `watchfn`.
- Bug reports include `replayId` for playback in dashboard.

## Privacy & Redaction
- `beforeSend(event)` hook to drop or scrub fields.
- Default PII scrubbing for inputs with `data-catchfn-mask` or standard selectors (password, credit card).
- Configurable block/allow lists for URLs and headers in network logs.

## Packaging & Workspaces
- New package: `catchfn/typescript/` (workspace entry already covered by `catchfn/*` if added to root `package.json` when created).
- Name: `catchfn` (aligns with core function naming convention).
- Dependencies: reuse `watchfn` browser client, `drawfn` for annotation, shared `@superfunctions/http` if server adapter needed.
- Future: Python SDK to open bug reports from backend contexts.

## Testing Strategy
- Unit: widget logic, payload construction, collectors (console/network), beforeSend hook behavior.
- Integration (browser): happy path submit with screenshot + annotation; network/console capture opt-in; size cap truncation; failure retries.
- Contract: ensure `bug_report` payload accepted by watchfn ingestion; schema validation.
- E2E (optional): Playwright script that opens widget, submits bug, verifies watchfn received event.

## Milestones
1) Schema + SDK core (`bug_report` event, `captureBug`, watchers)  
2) Reporter widget + annotation via drawfn  
3) Issue sync hook to `botfn` (GitHub/Linear)  
4) Hardening: size limits, redaction, retries  
5) Session replay plugin (v1.1)  
6) Minimal dashboard view (reuse watchfn queries) (post-v1)
