# Capability inventory

The inventory defines the minimum real operator model for each module. Commercial products are comparison points for jobs and information architecture, not implementation dependencies.

This table is the normative product coverage map, not a claim that every
listed action already has its final domain-specific public request schema. The
v1 packages register all listed resources/actions with target, permission,
safety, audit, REST/OpenAPI, and MCP metadata through an injected service. An
owning function must still stabilize required payload fields and generated
client methods before treating a generic-payload action as a mature public API.

## Required modules

| Module | Commercial reference | Resources and views | Mutations and actions |
| --- | --- | --- | --- |
| AuthFn | Clerk, Auth0, Descope, Better Auth | users, identities, sessions, workspaces, memberships, roles, API keys, OAuth providers/connections, MFA, regions, auth health, audit | invite/block/delete user, revoke session, rotate/revoke key, manage role, reset MFA, configure provider |
| BillFn | Stripe Billing, Paddle, Chargebee, RevenueCat | customers, products, plans, prices, subscriptions, entitlements, quotas, invoices, payments, usage, reconciliation, revenue | create/update catalog, grant entitlement, change/cancel subscription, issue credit/refund, reconcile provider |
| BrowseFn | Firecrawl, Browserless, Apify | providers, credentials, scrape/crawl jobs, sessions, queues, cache, policies, usage, cost, errors | start/cancel/retry crawl, invalidate cache, configure provider/policy |
| CiFn | GitHub Actions, CircleCI, Buildkite | projects, pipelines, runs, jobs, steps, runners, logs, artifacts, secrets, schedules, webhooks | trigger/retry/cancel run or job, manage runner, rotate secret, download/delete artifact |
| CmsFn | Sanity, Contentful | datasets, schemas, documents, drafts, revisions, assets, previews, workflows, releases, collaborators | create/edit/archive document, publish/unpublish, restore revision, upload asset, advance workflow |
| ContentFn | Sanity Content Lake | nested in CmsFn: datasets, schema types, documents, drafts, revisions, assets, queries, webhooks | import/export, mutate document, publish draft, manage webhook |
| CompFn | Vanta, Drata | frameworks, controls, checks, evidence, policies, risks, exceptions, owners, auditors, reports | map control, collect/approve evidence, accept risk, grant exception, generate report |
| DataFn | Supabase, Firebase, Hasura | schemas, resources, relations, indices, capabilities, records, queries, sync clients, conflicts, permissions, public links, retention, sequence/idempotency, regions | query/mutate/transact, seed, resolve conflict, clone/pull/push/reconcile, grant/revoke, migrate, prune |
| FileFn | Cloudinary, S3 Console, Supabase Storage | files, versions, upload sessions/parts, storage targets, policies, grants, share links, processors/jobs, artifacts, quotas, dedup/retention | upload/complete/abort, restore/delete, grant/revoke, create/revoke share, reprocess, migrate storage |
| FlowFn | Temporal Cloud, Trigger.dev, Inngest | workflows, queues, streams, messages, executions, jobs, workers, consumers, schedules, retries, dead letters, metrics | start/signal/cancel/terminate/retry/replay, pause queue, redrive dead letter, manage schedule |
| HostFn | Vercel, Netlify, Render, Fly | projects, apps/services, deployments, builds, previews, domains, certificates, targets, environments, secrets, traffic, logs, usage | deploy/cancel/retry/rollback/promote, attach domain, renew certificate, rotate secret, scale target |
| MailFn | MailSlurp, Mailtrap, AgentMail | projects, inboxes, messages, threads, drafts, attachments, credentials, domains/routes, webhooks, retention, quotas, compliance/audit | create/expire inbox, label/delete message, send/reply draft, manage domain/webhook, rotate credential, purge |
| MemoryFn | Mem0, Zep | tenants, agents, memories, profiles, sources, ingestion jobs, graph, conflicts, retention, consent, usage/cost | ingest/update/merge/delete memory, resolve conflict, export/delete subject, change retention |
| PlugFn | Nango, Paragon, WorkOS Integrations | provider catalog, provider config, OAuth apps, connections, credentials, webhooks, workflows, sync jobs, executions, failures, usage | authorize/revoke connection, rotate credential, replay webhook, run/retry/cancel sync or workflow |
| RecFn | Recall.ai | recording bots/jobs, meetings, participants, recordings, transcripts, media providers, ASR config, webhooks, retention, usage/errors | schedule/join/stop bot, retry recording/transcription, redact/delete/export recording, manage webhook |
| SearchFn | Algolia, Elastic, Typesense, Meilisearch | adapters/backends, indexes/collections, schema, documents, ingestion, diagnostics, synonyms, ranking, analytics, keys, snapshots, health | index/batch/reindex, remove/clear, manage schema/synonym/ranking/key, restore snapshot |
| SecFn | Snyk, Vault, Wiz, Infisical | secrets/versions, rotation, policies, identities/RBAC, scanners, findings, rate limits, incidents, events, integrations, audit | create/rotate/revoke secret, change policy, scan, suppress/remediate finding, manage incident/rate limit |
| SendFn | Resend, Twilio, OneSignal | providers, credentials, domains/senders, templates, messages/batches, delivery events, contacts, suppressions/unsubscribes, device tokens, webhooks, usage | verify domain, send/cancel batch, retry delivery, manage template/contact/suppression/device/webhook/key |
| TestFn | BrowserStack, Sauce Labs, Percy | projects, suites, cases, runs/results, agents, browsers/devices, environments, artifacts, baselines/diffs, flakiness, schedules | start/cancel/rerun, approve/reject baseline, quarantine test, manage agent/environment/schedule |
| UserFn | Intercom, LaunchDarkly, Canny, Userflow | users, traits, segments, flags/environments/rules, campaigns, surveys/responses, feedback/votes, roadmap, changelog, analytics | update trait/segment, target flag, launch/pause campaign, publish survey/roadmap/changelog, triage feedback |
| WatchFn | Datadog, Sentry, Grafana Cloud, New Relic | organizations, projects, services, dashboards, metrics, traces, logs, errors, replays, monitors, alerts, incidents, integrations, retention, keys, usage | create/mute monitor, acknowledge/resolve incident, save query/dashboard, change retention/integration/key |
| CatchFn | Sentry Feedback, Jam | nested in WatchFn: feedback/bug inbox, screenshots, attachments, breadcrumbs, sessions, severity, status, assignee, linked issue | triage, assign, merge, resolve, link/export issue |
| LogFn | Datadog Logs, Better Stack, Axiom | nested in WatchFn: log events, sources, live tail, queries, saved views, charts, alerts, retention | save query/view, create alert, change retention, manage source/token |

## Optional modules

| Module | Commercial reference | Resources and views | Mutations and actions |
| --- | --- | --- | --- |
| ApiFn | Postman, Stoplight, SwaggerHub | specs, services/endpoints, collections, environments, mocks, test history, diffs, performance | import/update spec, run collection, create mock, change environment, promote revision |
| BotFn | Botpress | bots, channels, credentials, commands, workflows, conversations, events, deployments, logs, spend | deploy/pause bot, manage channel/credential/command, replay event, close conversation |
| CacheFn | Upstash, Redis Cloud | namespaces, keys, tags, TTL, hit/miss, hot keys, evictions, capacity, providers, health | get/set/delete, invalidate tag, purge/warm namespace, change TTL/eviction/limit |
| DocsFn | Mintlify, ReadMe, GitBook | sites, navigation, content sources, OpenAPI inputs, versions, previews, deployments, redirects, domains, search analytics | build/preview/deploy/rollback, manage source/version/domain/redirect, rebuild index |
| LangFn | LangSmith, Braintrust | providers/models, prompts/versions, runs/traces, datasets, evaluations, agents/graphs/tools, feedback, token usage/cost | version prompt, run/retry eval, manage dataset/provider, annotate/score trace |
| ProbeFn | BrowserStack, Percy, Checkly | sessions, pages, checkpoints, screenshots, traces, network/logs, baselines/diffs, flows, auth profiles, reports | run/cancel probe, approve baseline, retry checkpoint, manage flow/auth profile |

## No standalone module

| Function | Ownership |
| --- | --- |
| ChartFn | rendering library used by module views; no independent operator state |
| CliFn | developer CLI primitives |
| DrawFn | canvas is end-user product UI |
| ExtFn | generated extension UI and developer build tooling |
| IconFn | icon asset library |
| McpFn | powers MCP projection and conformance rather than an operator dashboard |
| UIFn | powers the visual system and catalog/workbench rather than operator state |

## Forward compatibility with dirty `dev`

The uncommitted `dev` worktree indicates upcoming contract changes. Super Console does not import those uncommitted paths, but its admin model reserves and forwards:

- function namespace and region in addition to universal tenant scope;
- actor, request, and correlation identifiers;
- canonical observation metadata;
- durable idempotency outcomes;
- adapter health and provisioning signals;
- explicit runtime-store capabilities such as atomic KV and indexed directories;
- generic delivery-provider identities;
- server/application separation through injected services.

AuthFn adapters must anticipate standalone plugin packages and runtime configuration. DataFn adapters must preserve namespaced authorization and synchronization semantics. FileFn adapters must delegate through protected file services instead of raw storage. SearchFn operations must carry namespace and region filters and must never default to cross-tenant indexing or search.
