# Original UserFn requirements: implementation and evidence status

Snapshot: 2026-10-20, source through `1c1d322e8` (including Watch merge
`cc7e5a0c2`). Authority: [original specification](spec.md). Its “implementation
not started” header is historical; its product scope and six milestones remain
applicable. This inventory does not declare the platform production-ready.

Paths below are relative to `userfn/`. “Implemented, bounded” means the named
behavior exists with the stated evidence; it does not close adjacent requirements.
“Partial” includes prototypes and contracts without durable service behavior.
Python is later in the original SDK heading, but its existing supported surfaces
must retain parity; browser renderers are not implied Python requirements.

Subsequent renderer checkpoint: [campaign content/navigation correction](renderer-content-readiness.md)
resolves the raw toast HTML and executable CTA paths identified below. The
remaining rich-content/accessibility and durable messaging work is still open.

Subsequent [targeting semantics checkpoint](targeting-semantics-readiness.md)
adds strict JSON/text parity, documented decimal numeric strings and `startsWith`.
Its assignment migration is explicit; range/geo/time and regex limits remain open.

Subsequent [framework flag checkpoint](framework-flags-readiness.md) adds optional
React hooks and Svelte readable stores with actual packed SSR/browser acceptance.
Other UI components, accessibility and full product requirements remain open.

## Resume priorities

1. **Make existing messaging content safe before expanding rendering.**
   `typescript/src/ui/renderer.ts:renderToast` interpolates campaign title/body
   into `innerHTML`; the modal path uses text. Define the promised rich-text/MD
   subset, constrain CTA destinations, and add actual-browser adversarial content
   and keyboard/focus tests. Static unsafe interpolation is present; this audit
   did not execute a new exploit fixture.
2. **Complete messaging delivery as a vertical slice.** Add durable campaign
   publication and actor/session-specific delivery state, actual schedule/caps,
   then real Watch impression/click/dismissal ingestion. Current “global” caps
   are instance-memory counters, not distributed limits; Python/TS eligibility
   alone is not delivery acceptance.
3. **Close targeting semantics before widening rollout use.** Shared vectors
   must cover segment coercion, booleans/numbers and regex behavior across SDKs;
   implement the missing named operators. Prerequisite JSON equality/hash parity
   does not establish segment matcher parity.
4. **Implement survey submission end to end**, then external feedback ingestion,
   roadmap/changelog. Keep privacy/consent and tenant-aware rate limits in those
   contracts rather than treating them as optional polish.

## Requirement inventory

| Original requirement / source section | Current implementation and evidence | Missing implementation or proof | Next concrete action |
| --- | --- | --- | --- |
| Goal; Architecture: self-hosted platform using shared primitives | `service/src/index.ts` uses shared HTTP/auth and internally schema-wrapped DB; SDKs and admin capability package exist. | Campaign/survey/roadmap/changelog services and deployable operational composition are absent. | Extend function-owned schemas/routes; prove each durable product flow independently. |
| Identity & traits; User model; SDK identify/reset | Both `core/identity` implementations keep an ID/traits object; public identify/reset and unit tests exist. | Memory-only; no users/traits service, createdAt/lastSeenAt, client persistence, identity reconciliation or session-ID rollout policy. TS API is positional, not the spec's object sketch. | Define authoritative identity/session contract and persistence without trusting client traits as authorization. |
| Segments; Targeting & Rules Engine | Both `core/segments` evaluate all/any trait rules; missing segment fails closed. Signed config carries validated segments. Subsequent shared vectors cover strict JSON equality/membership, text/numeric rules and startsWith in both SDKs. | Event-derived targeting and range/geo/time-window operators remain absent. Coercion/membership differences are corrected with an explicit assignment migration; regex engines still differ and have no runtime budget proof. | Add shared adversarial vectors and explicit typed operator semantics, then missing operators. |
| Flag variations/defaults, deterministic rollout, context, prerequisites, env overrides, kill switch | Both `core/flags`, `utils/hash`; flag-context/hash tests. Iterative dependency traversal, missing/cycle fail-closed, configured JSON snapshot isolation and UTF-16 hashing. | Anonymous partial rollout has no stable session ID; flag owner/tags absent; Python non-BMP hash migration is compatibility-sensitive. | Preserve published migration note; add session policy and owner/tag persistence/schema roundtrip. |
| SDK getFlag, typed variations, useFlag; React/Svelte helpers | TS/Python value APIs; optional React provider/useFlag and structural Svelte flag store; stable snapshots, committed exposure provenance, packed React18/19 SSR/hydration and compiled Svelte browser acceptance. | Other framework UI components and cross-browser/accessibility evidence remain absent; remote FlagValue is a union, not inferred from fallback. | Extend the next complete messaging/survey vertical slice with framework UI and accessibility tests. |
| Feature Flags: signed config service; SDK bootstrap/ETag/background refresh | `service/src/flag-config.ts`, both `core/config_http/config-http` and refresh loops; actual HTTP/SQLite CAS/reopen, Chrome WebCrypto/CORS, installed package checks. | Latest snapshot only; durable client cache, rollback/freshness policy, key lifecycle UI, CDN/edge deployment and fleet jitter/load absent. Whole-environment GET/PUT `/config/:environment` replaces the sketch; per-flag CRUD/rules routes are not implemented. | Define rollback/key rotation and durable cache semantics; implement granular authoring if required without bypassing atomic publication. |
| Flags: Watch exposure key/variation/rule; offline fallback | Both `core/exposures` preserve selected-branch IDs and bootstrap/unavailable reasons; only public requested flag emits. `verify-exposure-watch.mjs` proves built Node/Chrome and Python through actual Watch HTTP and SQLite reopen. | Queues are memory-only; ordinary ingestion is at least once; successful status is trusted, not a signed/count-verified receipt. Watch keys are neither ingestion-only nor tenant-scoped. | Establish safe proxy/credential deployment and durable offline queue requirements; preserve explicit flush failures. |
| Campaign model / CRUD / publish / message bootstrap | TS/Python campaign types and local setters; admin package declares operations. | No campaign table/routes/publication, schedule persistence or `/messages/bootstrap`; admin requires an injected service and is not durable implementation. | Implement validated tenant-scoped campaign storage/publication and bootstrap API. |
| Messaging trigger URL glob/regex, event, flag; audience/priority | `core/messaging` applies segment targeting, priority and substring URL/event matching in both SDKs. | No glob/regex semantics or flag trigger evaluation; schedule start/end and cooldowns not enforced. | Define trigger grammar and clock semantics; test actual eligibility boundaries in both SDKs. |
| Messaging dedupe, per-user/session/global caps, delivery reconciliation | Instance maps track shown/clicked/dismissed; simple local global count gate. | No actor/session keys in delivery records, durable cap authority, cross-instance enforcement, persisted client state or service sync. The subsequent campaign-cap correction aligns explicit zero with Python (zero deliveries); omitted caps remain uncapped. | Atomic durable delivery receipts/cap claims with concurrent actors/restarts and offline reconciliation tests. |
| Message kinds, render(slotId), rich content, CTA actions | Vanilla modal and inbox-item toast rendering; `trigger` invokes renderer. | Public `render(slotId)` only logs. Banner/anchored tooltip/inbox list absent; rich-text safety unresolved; CTA emit-event/open-survey incomplete. Toast title/body enters `innerHTML`. | Safe content contract first, then slot-based renderer and each required kind/action with browser acceptance. |
| Messaging impression/click/dismissal analytics | Local `trackDelivery` updates memory; flag exposure transport exists separately. | No messaging Watch delivery; public `track` logs. No proof that shown corresponds to successful mounting. | Emit provenance-bearing delivery events after actual render/actions and verify Watch persistence. |
| Survey templates NPS/CSAT/CES/custom, choice/text/scale | TS survey/question types, local eligibility engine, vanilla NPS/CSAT/text UI. | Unsupported question types render fallback; no complete CES/multi-choice/scale templates. Python has types but no survey engine/client integration. | Add validated templates and supported answer schemas; document Python server/client surface explicitly. |
| Survey branching, validators, frequency/time-window caps, URL/segment eligibility | TS local segment/substring eligibility; required nonempty answer check; in-memory global response gate. | No branching/skip evaluation, robust typed answer validation, per-user/time-window cap, start/end enforcement or public openSurvey(id). | Implement deterministic survey progression and actor-scoped eligibility with adversarial answer tests. |
| SurveyResponse model, service storage, Watch events | TS renderer returns answers/submittedAt; `SurveyEngine.trackResponse` stores in memory. | No durable survey response route/table; client callback has Watch TODO; no stored user/score contract or delivery receipt. | Add idempotent authenticated response endpoint + Watch delivery and actual browser→SQLite acceptance. |
| Feedback core create/read, status/tags/product area, authoritative actor | `service/src/index.ts`, validation/filter modules; both SDK HTTP clients; native HTTP/reopen and metadata tests. Tenant-scoped idempotency, status and transactional metadata changes exist. | General title/body edit/delete/CRUD policy not implemented; source is explicitly only `in_app`. | Define supported edit lifecycle without weakening receipt identity or tenant boundaries. |
| Feedback voting, per-user uniqueness, anonymous policy | Actor-type/ID keyed vote upsert/delete, readback; native concurrency/reopen evidence. | Anonymous voting policy toggle absent; client identity is intentionally not vote authority. Large vote projection has an explicit bounded overflow failure, not unlimited scaling. | Add trusted anonymous actor policy if enabled, then indexed aggregate scaling/load proof. |
| Feedback board filtering / embeddable widget | Paginated HTTP board with status/tag/product-area filters; normalized indexes and resumable migration; TS/Python traversal tests. | No board UI or browser vote flow; no ranked sorting/snapshot export semantics. | Build accessible filtered board against live service and prove pagination/vote behavior. |
| Feedback duplicate detection/manual merge/duplicates list | Request idempotency detects retries; this is not semantic duplicate detection. | Similarity matching, manual merge, duplicate links and vote/issue reconciliation absent. | Define transactional merge invariants and acceptance for conflicting votes/links. |
| Feedback attachments; optional DrawFn screenshot/annotation | Bounded attachment strings accepted by validation; feedback widget submits text/category. | No verified MIME/URL policy, DrawFn capture, blob adapter lifecycle or screenshot submission browser evidence. | Implement a bounded attachment contract and real DrawFn→submission flow. |
| Unified sources: Discord, GitHub Discussions, Discourse, email/form | Feedback input rejects non-in_app sources; no source-specific handlers in service tree. | External ingestion, authentication/signatures, normalization, replay keys and source records absent. | Add one authenticated source adapter end to end, retaining stable external IDs and update semantics. |
| Integrations: Discord status reply, issue links/status sync; outbound webhooks | Admin feedback schema may describe fields; no UserFn integration runtime found. | BotFn/PlugFn transport, linked issue persistence, inbound/outbound delivery and retry/receipt semantics absent. | Implement durable source/link/outbox contracts with local real HTTP and provider fixtures. |
| Roadmap model, lanes, feedback/flag links, owner/ETA, public/editor APIs | No roadmap implementation/schema/routes in current service/SDK tree. | Entire original vertical slice, including widgets and relation integrity. | Add function-owned tables, tenant/RBAC routes, then public lane widget with live data. |
| Changelog model, related flags/roadmap, widget/RSS/webhook/impressions | No changelog implementation/schema/routes in current service/SDK tree. | Entire original vertical slice and delivery channels. | Add publication lifecycle and fetch/RSS first; durable webhooks and Watch impressions follow. |
| Storage tables/indexes; shared DB wrapping | `service/src/schema.ts` owns config + feedback/votes/attributes/tags/migration schemas. SQLite transaction/reopen evidence for implemented routes. | Users, campaigns/deliveries, surveys/responses, sources, roadmap/changelog schemas absent; non-SQLite adapters and scale not certified. | Add only schemas required by next vertical slice; run actual adapter acceptance. |
| Transport batching/retries/auth for all runtime events | TS exposures reuse current Watch browser package; Python optional HTTP transport batches, coalesces and retains failures for explicit retry. | Impressions/clicks/survey events not wired; no reconnect replay across process loss or durable event store. | Generalize deliberate event lifecycle after defining consent and event contracts; do not replace failures with logs. |
| Tenancy/Auth: AuthFn, per-tenant keys, viewer/editor/admin | Service requires verified shared-auth subject/tenant/scopes before body parsing; scopes separate read/write/vote/moderate/config actions. Actual AuthFn source acceptance exists with tenant resolver and revocation. | Concrete role provisioning/UI absent. AuthFn acceptance uses in-memory key storage/source aliases; packed durable AuthFn closure and deployment enrollment/rotation remain open. Watch app name is not a tenant boundary. | Prove packaged AuthFn + supported durable provider, map roles to scopes, and separate ingestion credentials/proxy. |
| Privacy/PII allow/block lists; consent/DNT | Exposure events deliberately omit values/traits; admin capability includes redaction metadata. | No SDK DNT/app consent gate; feedback traits/body lack configurable redaction policy. Admin descriptor redaction is not product PII enforcement. | Add consent before any analytics/messaging side effect and explicit feedback field policy tests. |
| Per-user/per-tenant rate limits; moderation | Request byte/depth bounds and scoped authorization exist. | No rate limiter or profanity toggle; local campaign counters are not service rate limits. | Define authoritative counters/rejection/retry contract and moderation behavior before public endpoints. |
| UI theming/accessibility/offline | Vanilla stylesheet and modal/toast/form scaffolds exist. | Hard-coded styles, no full CSS-variable/light-dark/font API; no proper focus trap/ARIA/keyboard/reduced-motion acceptance; no durable cached messages/reconnect queue. | Browser accessibility/security suite, then theme contract and offline lifecycle. |
| Service API sketch compatibility | Actual routes: feedback GET/POST, vote POST, metadata/status PATCH; config GET/PUT per environment, OPTIONS. | Campaign/survey/roadmap/changelog/webhook routes absent; `/flags` sketch is not exposed. Admin operation descriptors do not supply these routes. | Publish an explicit API mapping and implement missing product endpoints; avoid claiming descriptors as handlers. |
| Packaging / TS browser+Node / Python runtime | `verify-config-package.mjs` installs actual SDK/service/shared/Watch tarballs, exercises ESM/CJS exposure runtime and strict declarations. Fresh Python wheel extras and core-only install verified. Actual Chrome integration uses bundled built SDK. | Published registry releases, all browser engines, minimum Node/edge runtimes and packaged AuthFn provider closure are not proven by these local checks. | Keep reproducible consumer matrix and add declared runtime floors/edge environment before release claims. |
| Testing strategy: unit/integration/E2E/load | Tests cover implemented flags/segments/feedback/config/exposure boundaries, real SQLite and local Chrome. Evidence scripts and limits are listed below. | No complete banner/modal/tooltip, survey submission, screenshot feedback, board vote, flag UI hook E2E; no edge bootstrap/message latency/Watch throughput load evidence. | Use acceptance of each missing vertical slice as completion gate; add load budgets with populated state. |

## Original milestone status

| Original milestone | Status at this snapshot | Exit work still required |
| --- | --- | --- |
| 1. Foundation | Substantial bounded implementation; incomplete | Identity/session persistence policy, complete/parity targeting, owner/tags, durable/operational config and exposure gates above. |
| 2. Messaging + Surveys | Local prototypes; incomplete | Durable campaigns/deliveries/responses, real caps and branching, safe accessible renderer, Watch events and browser submissions. |
| 3. Unified feedback board | In-app backend/voting/status substantially implemented; incomplete | External sources, semantic merge, issue sync, board UI and screenshot/attachment flow. |
| 4. Roadmap + Changelog | Not implemented | Models, APIs, widgets, relations, RSS/webhooks and impressions. |
| 5. Hardening | Selected boundaries implemented; incomplete | Consent/PII/rate limits/moderation, full role provisioning, durable cache/edge deployment, load and provider matrix. ETag/auth/body bounds are not the entire milestone. |
| 6. Nice-to-haves | Not implemented as complete features | Inbox list, localization, AI-assisted dedupe/triage and multi-product support. A toast called inbox-item is not an inbox. |

Native mobile SDKs, a full CRM and billing/entitlements remain the original v1
non-goals; they are not added to the completion checklist.

## Evidence to reuse on resume

- SDK source suites: `typescript/src/__tests__` and `python/tests`; they exercise
  implemented behavior, not absent product features.
- Service `test:native`: real HTTP/SQLite submission/replay, board/votes,
  metadata/filter migration and signed-config races/reopen. `test:authfn` is the
  separately scoped actual AuthFn source integration; see
  [its durable/package limitations](authfn-feedback-acceptance.md).
- [Config package script](../service/scripts/verify-config-package.mjs): fresh
  installed artifacts and strict declarations, no peer bypass or skipLibCheck.
- [Config browser script](../service/scripts/verify-config-browser.mjs): actual
  Chrome verification/CORS/refresh lifecycle; local hosted page, not public TLS.
- [Exposure acceptance](exposure-acceptance-readiness.md): actual built Watch
  artifact from the identical merged source, Node/Python/Chrome, authenticated
  HTTP, SQLite failure/reopen, timeout/retry/overflow and lost-ack duplication.
  Python in this script uses source; wheel acceptance is recorded separately in
  [exposure implementation evidence](flag-exposure-readiness.md).

No cloud deployment, provider production account, cross-browser matrix, sustained
load or crash/power-loss proof is implied. The next resume should recheck the live
head and prioritize missing behavior, not repeat historical pass totals.
