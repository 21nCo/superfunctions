# Phase 10: Dashboard

## Phase goal
Provide a dashboard (uifn/docsfn style) for run list, run detail (jobs, steps, logs), and artifact list; data from control plane API; auth same as API.

## In scope
- Dashboard app: SPA or static pages that call control plane /api/v1/runs, /api/v1/runs/:id, /api/v1/runs/:id/jobs/:jobKey/logs, /api/v1/runs/:id/artifacts.
- Auth: same as API (Bearer token or API key); store in env or login form; send with every request.
- Pages: Run list (table or cards); Run detail (jobs, steps, status, link to logs); Logs view (per job); Artifacts list with download links.
- Align with uifn/docsfn patterns: component library or doc site style; no requirement for full uifn integration if not in repo.

## Out of scope
- Optional sendfn notifications (Phase 11); editing pipeline from dashboard; real-time live log streaming (optional).

## Deliverables
- `cifn/dashboard/` or `cifn/typescript/dashboard/`: app (React, Svelte, or static HTML+JS); run list page; run detail page; logs and artifacts.
- Auth: token input or env; attach to fetch/axios.
- Tests: TV-DASH-001.

## Requirements covered
- DASH-001.

## Implementation tasks
1. Create dashboard package or directory; add build (Vite, Next, or static).
2. Run list: fetch GET /runs; display runs in table (runId, status, createdAt, trigger); link to run detail.
3. Run detail: fetch GET /runs/:runId; display jobs with steps and status; buttons or links to view logs per job; link to artifacts.
4. Logs: fetch GET /runs/:runId/jobs/:jobKey/logs; display in pre or log viewer.
5. Artifacts: fetch GET /runs/:runId/artifacts; display list; each artifact has download link (url from response).
6. Auth: read CIFN_API_KEY or prompt; set Authorization header on all API calls; if 401 show login or error.
7. Test: load dashboard; authenticate; list runs; open run; view logs and artifacts. TV-DASH-001.

## Verification steps
- Open dashboard; without auth, run list fails or prompts; with valid token, run list loads. Open a run; jobs and steps visible; logs and artifacts accessible. TV-DASH-001 pass.
- Run tests or manual checklist for dashboard.

## Stop condition
- Dashboard shows run list, run detail, logs, and artifacts with API auth. Report: "Phase 10 complete; dashboard ready for Phase 11 (limits, sendfn)."
