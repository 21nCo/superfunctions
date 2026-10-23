# UserFn Implementation Plan (Draft)

Last updated: 2026-01-14  
Status: Planning  
Owner: Platform (Superfunctions)

## Dependencies / Pre-reqs
- `watchfn` for event ingestion/analytics (impressions, clicks, exposures, survey responses).
- `authfn` for tenant/user auth and API keys.
- `@superfunctions/http`, `@superfunctions/db` for the config/data service (REST/tRPC).
- `botfn` for Discord + issue tracker bridges; `plugfn` for GitHub Discussions/Discourse webhooks/providers.
- `drawfn` for optional annotated feedback screenshots.
- Edge caching/CDN for flag/config bootstrap (optional but recommended).

## Phase 0 — Foundations & Schema
- Define core schemas: users/traits, segments, flags/rules, campaigns, deliveries, surveys/responses, feedback/votes/sources, roadmap items, changelog entries.
- Decide multi-tenant model and RBAC roles (viewer/editor/admin).
- Index plan: flags (key), segments, campaigns active/by audience, feedback (status/source), roadmap (status), deliveries/responses by user.
- API surface sketch and versioning.

## Phase 1 — Flags Service + Evaluator
- Service endpoints: fetch flags (bootstrap, ETag), CRUD for flags/rules.
- Deterministic evaluator shared client/server; supports segments, rollouts, prerequisites, env overrides, kill switch.
- Client SDK: TS browser + Node (edge/SSR); `getFlag`/`useFlag`; exposure events to watchfn.
- Caching: local cache + background refresh; bootstrap payload.
- Tests: evaluator determinism, rollouts, prerequisites, overrides, exposure emission.

## Phase 2 — Identity & Segments
- SDK: `identify({id, traits})`, `reset`.
- Segment engine: rule operators (equals/contains/in/regex/range/time/geo).
- Server-side segment storage; optional precomputed segment membership per user.
- Tests: segment evaluation correctness, caching/ETag for bootstrap.

## Phase 3 — In-App Messaging
- Campaign model: triggers (URL/event/flag), schedule, priority, per-user/per-session caps, cooldown, dismissal.
- Renderer components: banner, modal, tooltip (anchor selector), inbox list; themeable, accessible.
- Delivery state: client-side cache + server reconciliation.
- Events: impressions/clicks/dismissals to watchfn.
- Tests: eligibility, caps, priority ordering, rendering, ARIA/accessibility, Playwright E2E.

## Phase 4 — Surveys & Forms
- Survey definitions: NPS/CSAT/CES/custom; branching (basic).
- UI components + validation; submission pipeline to service + watchfn event.
- Throttling/frequency caps; audience via segments/URL.
- Tests: branching, caps, submission storage, analytics events.

## Phase 5 — Feedback Board (Unified Sources)
- CRUD: create/update/merge, status changes, voting (per-user), tags/product area.
- In-app submission (with optional screenshot/annotation via drawfn).
- Ingestion connectors:
  - Discord via botfn (webhook/polling).
  - GitHub Discussions via plugfn/webhook.
  - Discourse via webhook.
  - Email/form inbound webhook.
- Deduping: title/body similarity; manual merge; record duplicates.
- Board widget: list/filter by status/tag/product area; public/private modes.
- Tests: vote idempotency, merge semantics, ingestion adapters (mocked).

## Phase 6 — Roadmap & Changelog
- Roadmap lanes (Planned/In Progress/Done), cards linked to feedback/flags; optional ETA/owner.
- Changelog entries with tags/categories; delivery via in-app widget + RSS/webhook; impression tracking via watchfn.
- Tests: linkage integrity, fetch/render, filters.

## Phase 7 — Integrations & Sync
- Issue trackers (GitHub/Linear via botfn): link feedback to issues, sync status back.
- Outbound webhooks for feedback/roadmap/changelog updates.
- Rate limits and backoff for external APIs.

## Phase 8 — Privacy, Safety, Performance
- PII redaction for feedback/forms; allow/block lists; consent-aware delivery.
- Rate limits per tenant/user for messaging, submissions.
- Edge caching for flag/config bootstrap; ETag/If-None-Match; CDN headers.
- Moderation toggle (profanity filter) for public feedback.

## Phase 9 — Docs, Examples, Ops
- README/Getting Started for SDK + service.
- Examples: flag toggle in UI; banner campaign; survey; feedback board embed.
- CI: lint/test/build; contract tests for webhooks; load test plan for bootstrap endpoints.
- Observability: emit service metrics to watchfn/logfn; health checks.

## Milestones (phased rollout)
- M1: Flags + identity/segments shipped.
- M2: Messaging renderer + tracking.
- M3: Surveys live.
- M4: Feedback board with in-app + at least one external source (Discord or GitHub Discussions).
- M5: Roadmap + changelog widgets.
- M6: Integrations hardening, privacy/rate limits, docs/examples. 
