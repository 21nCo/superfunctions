# UserFn Specification (Draft)

Last updated: 2026-01-14  
Status: Draft (implementation not started)  
Owner: Platform (Superfunctions)

## Goal
Build `userfn`, a self-hosted user engagement platform covering in-app messaging (Intercom-style), surveys/forms, feature flags, feedback boards (Canny-style with unified sources), roadmap, and changelog—leveraging existing Superfunctions primitives (`watchfn`, `botfn`, `plugfn`, `authfn`, `drawfn`, shared packages).

## Scope (v1)
- Identity & traits with segmentation.
- Feature flags: deterministic eval, rollouts, prerequisites, kill switches, typed SDKs.
- In-app messaging: campaigns, banners/modals/tooltips/inbox, targeting, throttling, impressions/clicks tracking.
- Surveys/forms: NPS/CSAT/CES/custom; branching; throttling; submissions stored as structured events.
- Feedback board: voting, statuses, tags; unified ingestion from in-app + Discord + GitHub Discussions + Discourse + email/web form.
- Roadmap: public view backed by feedback links.
- Changelog: in-app “What’s new”, RSS/webhook.
- Analytics: reuse `watchfn` for events (impressions, clicks, exposures, survey responses).

## Non-Goals (v1)
- Native mobile SDKs (web first; RN later).
- Full-blown CRM; focus on product-facing engagement.
- Billing/entitlements (reuse existing infra later).

## Architecture
- Client SDK (`userfn/typescript`): identity, flags, messaging renderer, surveys, feedback submission; React/Svelte helpers.
- Server service (`userfn/service`): REST/tRPC (uses `@superfunctions/http`, `@superfunctions/db`); stores config (flags, campaigns, surveys, feedback board, roadmap, changelog).
- Transport/analytics: reuse `watchfn` ingestion for runtime events; dedicated service endpoints for config CRUD and feedback/roadmap data.
- Integrations: `botfn` for Discord + issue trackers; `plugfn`/webhooks for GitHub Discussions, Discourse.
- UI: lightweight embeddable components; themeable; accessible.

## Data Model (high level)
- User: `id`, `traits` (plan, role, region, locale), `createdAt`, `lastSeenAt`.
- Segment: rules over traits/events (operators: equals/contains/in/regex/range/time/geo).
- Flag: `key`, `variations`, `default`, `rules` (segments, % rollout, prerequisites, env overrides, kill switch), `tags`, `owner`.
- Campaign: `id`, `kind` (banner/modal/tooltip/inbox), `content`, `audience` (segments), `triggers` (url match, event, flag), `schedule`, `priority`, `caps` (per-user, global), `dismissible`.
- Delivery state: per-user per-campaign `status` (eligible/shown/clicked/dismissed), `timestamps`.
- Survey: `id`, `type` (NPS/CSAT/CES/custom), `questions` (branching optional), `audience`, `frequency cap`, `start/end`, `cta`.
- SurveyResponse: `user`, `answers`, `score`, `submittedAt`.
- Feedback: `id`, `title`, `body`, `source` (in_app/discord/github_discussion/discourse/email/form), `status` (open/planned/in_progress/done/closed), `tags`, `productArea`, `votes`, `linkedIssues` (GitHub/Linear), `linkedRoadmapItems`, `createdBy`, `attachments?`, `duplicates?`.
- RoadmapItem: `id`, `title`, `description`, `status`, `owner`, `ETA?`, `linkedFeedback[]`, `linkedFlags[]`.
- ChangelogEntry: `id`, `title`, `body`, `tags`, `publishedAt`, `relatedFlags`, `relatedRoadmapItems`.

## SDKs (TS browser, Node; Python later)
- Identity: `userfn.identify({ id, traits })`, `reset()`.
- Flags:
  - `getFlag(key, default)`, `useFlag` hook; typed variations.
  - Bootstrap payload + local cache; background refresh with ETag.
  - Emit exposure events to `watchfn`.
  - Deterministic bucketing (userId/sessionId hash), prerequisites, env overrides.
- Messaging:
  - `userfn.render(slotId)` to hydrate widgets; components for banner/modal/tooltip/inbox.
  - Triggering from campaigns; dedupe, caps, priority.
  - Track impressions, clicks, dismissals via `watchfn`.
- Surveys:
  - `openSurvey(id)` / inline render; validators; submission with throttling; responses sent as structured events and stored in service.
- Feedback:
  - `submitFeedback({ title, body, tags, attachments? })`; optional screenshot+annotation via `drawfn`; source = `in_app`.
  - Votes: `voteFeedback(id, dir)`.
- Server/Edge (Node):
  - Flag evaluation (for SSR/edge) using same rules engine; bootstrap API client.
  - Webhooks client for ingesting external feedback events (Discord, GitHub, Discourse).

## In-App Messaging
- Campaign definition: audience (segments), triggers (URL glob/regex, event name, flag on/off), schedule (start/end), priority, frequency caps (per-user, per-session), cooldowns, dismissal behavior.
- Message types: banner, modal, tooltip/nudge (anchor selector), inbox list.
- Content: rich text/MD subset, CTAs (open URL, emit event, open survey).
- Renderer: themeable (CSS vars), accessible (focus trap, ARIA), reduced motion.
- Delivery state persisted client-side with sync to service for reconciliation.

## Surveys & Forms
- Templates: NPS, CSAT, CES, custom (multi-choice, text, scale).
- Branching/skip logic (basic: based on previous answer).
- Caps: per-user, per-time-window; eligibility by segment and URL.
- Storage: responses stored server-side; events to `watchfn` for analytics.

## Feature Flags
- Config service stores flags and rules; publish signed/ETagged config.
- Client eval: local, deterministic hashing; respects prerequisites; supports `context` (traits) for segment matching.
- Exposure events: emit to `watchfn`; include flag key, variation, rule id.
- Offline/bootstrap: embedded payload option; fallback to defaults on fetch failure.

## Feedback Board (Canny-style, unified sources)
- Core CRUD: create/update status, merge duplicates, tag, assign product area.
- Voting: per-user; prevent multi-vote; anonymous allowed if enabled.
- Sources:
  - In-app submissions.
  - Discord: via `botfn` polling/webhooks; map threads/messages to feedback items.
  - GitHub Discussions: via `plugfn`/webhook; map discussion to feedback.
  - Discourse: via webhook.
  - Email/form: inbound webhook to create feedback.
- Deduplication: title/body similarity; manual merge; store `duplicates` list.
- Surfacing: embeddable board widget with filters (status, tag, product area).

## Roadmap & Changelog
- Roadmap: lanes (Planned/In Progress/Done); cards link to feedback and flags; optional ETA/owner.
- Changelog: entries with tags/categories; relates to flags/roadmap items; delivery via in-app widget + RSS + webhook; impressions tracked via `watchfn`.

## Integrations
- Discord (botfn): ingest messages/threads; post status updates back.
- GitHub Discussions (plugfn/webhook): ingest new/updated discussions.
- Discourse: webhook ingestion.
- Issue trackers (GitHub/Linear via botfn): link feedback to issues; sync status back.
- Webhooks: outbound for feedback/roadmap/changelog updates; inbound for forms/email parsers.

## Storage & Transport
- Runtime events (impressions, clicks, exposures, survey responses): send to `watchfn` ingestion; use batching/retries/auth like `watchfn`.
- Config/data service (userfn):
  - Uses `@superfunctions/http` + `@superfunctions/db`.
  - Tables/collections (sketch): users, traits, segments, flags, flag_rules, campaigns, deliveries, surveys, survey_questions, survey_responses, feedback, feedback_votes, feedback_sources, roadmap_items, roadmap_links, changelog_entries.
  - Indexes: flag key; segment id; campaign audience/active; feedback status/source; roadmap status; userId on deliveries/responses.
  - Caching: edge cache for flag configs; ETag/If-None-Match for SDK bootstrap; CDN for assets.
- Attachments: small images inline (data URL) for feedback; larger via blob store adapter (same pattern as watchfn file channel) and store URLs.
- Tenancy/Auth: reuse `authfn`; per-tenant API keys for SDK; RBAC (viewer/editor/admin).

## Targeting & Rules Engine
- Operators: equals/contains/startsWith/regex/in/not-in/range/gt/lt/geo/time window.
- Segment evaluation shared across client/server; deterministic bucketing for rollouts.
- Prerequisites for flags; environment overrides; kill switch.

## Privacy, Security, Compliance
- PII controls: redact fields in feedback forms; configurable allow/block lists.
- Consent: respect “do not track” and app-level consent flags before analytics/messaging.
- Rate limits: per-user and per-tenant caps for messaging and submissions.
- Content moderation: profanity filter toggle for public feedback.

## UI/UX Components
- React/Svelte adapters; vanilla bundle.
- Theming via CSS vars; light/dark; font configurable.
- Accessibility: ARIA, focus management, keyboard navigation, reduced motion.
- Offline: queue events; show cached flags/messages when offline; replay on reconnect.

## APIs (Service surface, sketch)
- Flags: `GET /flags` (bootstrap), `PUT /flags/:key`, `POST /flags/:key/rules`, publish endpoint for cache busting.
- Campaigns: CRUD + publish; `GET /messages/bootstrap` for eligible messages (server-side filter).
- Surveys: CRUD; `POST /surveys/:id/respond`.
- Feedback: CRUD; `POST /feedback/:id/vote`; merge; status update.
- Roadmap: `GET /roadmap`, CRUD for editors.
- Changelog: `GET /changelog`, CRUD for editors.
- Webhooks: inbound (feedback sources), outbound (status/roadmap/changelog updates).

## Testing Strategy
- Unit: flag evaluator, segment matcher, rollout bucketing; messaging eligibility; survey validation; feedback merge/vote logic.
- Integration: SDK bootstrap/ETag; message delivery caps; flag exposure events to watchfn; feedback ingestion from Discord/GitHub webhooks (mock); changelog/roadmap fetch.
- E2E (Playwright): render banner/modal/tooltip; submit survey; submit feedback with screenshot; board vote; flag-based UI toggle.
- Load/perf: flag bootstrap at edge; message bootstrap latency; watchfn ingest throughput for events.

## Milestones (phased)
1) Foundation: identity/traits, segments, flags service + client eval + exposures to watchfn.
2) Messaging + Surveys: campaigns, renderer, impressions/clicks tracking, survey submissions.
3) Feedback board unified ingestion (in-app + Discord + GitHub Discussions + Discourse), voting, status.
4) Roadmap + Changelog widgets and APIs.
5) Hardening: privacy/rate limits/moderation, caching/ETag, RBAC, edge bootstrap.
6) Nice-to-haves: in-app inbox, localization, AI-assisted dedupe/triage, multi-product support.
