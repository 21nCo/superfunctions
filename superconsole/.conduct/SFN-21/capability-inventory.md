# Capability inventory

The inventory defines the minimum real operator model for each module. Commercial products are comparison points for jobs and information architecture, not implementation dependencies.

The comparison tables are the product target, not an implementation claim.
The live manifest is authoritative for what can be enabled today: it exposes a
truthful subset with exact domain handlers and schemas. Unsupported target
capabilities are omitted. A function with no canonical operator service is
`unavailable` and exposes nothing; ContentFn is folded into CmsFn rather than
duplicating its server. This deliberately leaves roadmap gaps visible instead
of filling them with generic payload/execute façades.

## Live implementation status

The catalog contains 29 administration packages: 18 required selectable
modules, 2 optional selectable modules, 2 real nested modules, 1 folded empty
module, and 6 unavailable empty modules. Only required and optional modules are
independently selectable. Nested modules mount under their owner, folded
modules cannot be selected independently, and unavailable modules fail closed.

| Module | Live availability | Real implemented subset |
| --- | --- | --- |
| AuthFn | Required selectable | Scoped users and sessions: list/get/delete users, list a user's sessions, and revoke a session through AuthFn storage and hooks. |
| BillFn | Required selectable | Products, plans, prices, subscriptions, entitlements, usage, payments, and reconciliation; change/cancel subscriptions, refund payments, and reconcile the provider through the configured BillFn instance. |
| BrowseFn | Required selectable | Environment-bound provider availability, aggregate metrics, rate-limit state, sanitized lifecycle logs, and aggregate cache state; confirmed clearing of metrics, logs, or cache through the BrowseFn facade. |
| CiFn | Required selectable | Control-plane runs, materialized jobs, redacted logs, and retained artifacts; trigger/retry/cancel runs and issue audited signed artifact downloads. |
| CmsFn | Required selectable | Environment-bound ContentFn datasets, schemas, documents, and revisions; create/upsert/query/patch/delete, publish/unpublish, and restore revisions. |
| CompFn | Required selectable | Scoped frameworks, controls, checks, evidence, and reports; collect evidence and generate auditor reports through the CompFn API. |
| DataFn | Required selectable | Schemas, resources, relations, indices, capabilities, records, and query execution; query, mutate, and transact through the configured DataFn executor. |
| FileFn | Required selectable | Authorized files, versions, upload sessions, grants, share links, policies, and processing artifacts; upload lifecycle, deletion, grants, one-time share creation/revocation, and processing through FileFn services. |
| FlowFn | Required selectable | Environment-owned queues, jobs, workers, dead letters, and event log; pause/resume, enqueue, run/close workers, and redrive/delete/clean dead letters through FlowFn APIs. |
| MailFn | Required selectable | Project-scoped projects, inboxes, messages, threads, drafts, attachments, credentials, domains, webhooks, retention, quotas, and audit events; the implemented inbox, message, draft, domain, webhook, credential, and retention actions. |
| MemoryFn | Required selectable | Environment-scoped memory search and ingestion through the configured MemoryFn pipeline and storage adapter. |
| PlugFn | Required selectable | Project-owned providers, connections, provider installations, workflows, webhook receipts/deliveries, and sync jobs; OAuth authorization, connection lifecycle, installation lifecycle, workflow controls, and sync-job controls. |
| RecFn | Required selectable | Recording bots, recordings, transcripts, participants, chat, metadata, analytics, and webhooks through the RecFn router; bot leave/delete and webhook create/delete are the exposed mutations. |
| SearchFn | Required selectable | Isolated adapter, index, and health inspection plus document index/batch-index/remove and index clear through the configured SearchAdapter. |
| SecFn | Required selectable | Environments, namespaces, secret sets and members, secrets, audit events, scanner, and rate limits; lifecycle operations delegate to SecFn vault, scanner, audit, and limiter services. |
| SendFn | Required selectable | Templates, delivery events, channel sends, suppressions, and device tokens; explicit email/SMS/WhatsApp/push, template, suppression, and device-token operations through SendFn. |
| TestFn | Required selectable | Project-scoped persisted runs, redacted artifact metadata, analytics, visual diffs, and visual baselines; start/clean runs, compare screenshots, and update a confirmed baseline. |
| WatchFn | Required selectable | WatchFn events, exception/message capture, and alert list/create backed by the configured WatchFn instance; it owns the CatchFn and LogFn navigation surfaces. |
| CacheFn | Optional selectable | Environment/namespace-scoped key metadata and cache statistics; set/delete keys, invalidate tags, and clear a namespace without exposing cached values in reads. |
| ProbeFn | Optional selectable; workspace-private | Sessions, checkpoints, event deltas, reports, and repository-relative artifact paths; session transitions, evidence capture/diff, checkpoint capture, and report export. The admin package remains workspace-private because ProbeFn's runtime dependencies are private. |
| CatchFn | Nested real under WatchFn | Persisted bug reports: cursor list, get, and create through CatchFn storage, mounted at WatchFn errors. |
| LogFn | Nested real under WatchFn | Emit structured events and flush configured LogFn sinks, mounted at WatchFn logs. |
| ContentFn | Folded empty into CmsFn | No standalone resources, navigation, or operations. CmsFn owns the real ContentFn server-backed surface. |
| ApiFn | Unavailable empty | No canonical persistent operator store/service; exposes no resources, navigation, or operations. |
| BotFn | Unavailable empty | No canonical aggregate for bots, channels, deployments, commands, and conversations; exposes no resources, navigation, or operations. |
| DocsFn | Unavailable empty | No canonical site CRUD or deployment control plane; exposes no resources, navigation, or operations. |
| HostFn | Unavailable empty | CLI and command primitives do not form a reusable deployment/domain/traffic/secret operator API; exposes no resources, navigation, or operations. |
| LangFn | Unavailable empty | Execution, model, and tracing primitives do not provide the advertised persistent operator registry; exposes no resources, navigation, or operations. |
| UserFn | Unavailable empty | The client/UI engine cannot prove server-side scope or persistence ownership; exposes no resources, navigation, or operations. |

## Commercial comparison roadmap

The following tables describe the intended commercial-grade product breadth.
They are roadmap targets, not claims about the live manifests above.

### Required-module roadmap

| Module | Commercial reference | Resources and views | Mutations and actions |
| --- | --- | --- | --- |
| AuthFn | Clerk, Auth0, Descope, Better Auth | users, identities, sessions, workspaces, memberships, roles, API keys, OAuth providers/connections, MFA, regions, auth health, audit | invite/block/delete user, revoke session, rotate/revoke key, manage role, reset MFA, configure provider |
| BillFn | Stripe Billing, Paddle, Chargebee, RevenueCat | customers, products, plans, prices, subscriptions, entitlements, quotas, invoices, payments, usage, reconciliation, revenue | create/update catalog, grant entitlement, change/cancel subscription, issue credit/refund, reconcile provider |
| BrowseFn | Firecrawl, Browserless, Apify | providers, credentials, scrape/crawl jobs, sessions, queues, cache, policies, usage, cost, errors | start/cancel/retry crawl, invalidate cache, configure provider/policy |
| CiFn | GitHub Actions, CircleCI, Buildkite | control-plane runs, materialized jobs/steps, redacted logs, retained artifacts | trigger/retry/cancel run, issue signed artifact download; unsupported project/pipeline/runner/secret/schedule/webhook administration is not advertised |
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

### Optional-module roadmap

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
