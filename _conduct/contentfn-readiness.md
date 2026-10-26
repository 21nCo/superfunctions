# ContentFn readiness (in progress)

Base: shared prerequisite 02deb6acad1aa978118943effbe28aa76af3608c; source imported from local next. Original normative requirements retained under `_conduct/contentfn-original/`; public SPEC.md omits historical metadata. No Python sources or Python promise: original scope explicitly TypeScript Node/browser.

Confirmed blockers and work:
- Core/schema validation deferred nested objects/arrays and declarative validation; helper extraction and full validation delegated to sibling worker, wiring into transaction before writes in progress.
- Caller system fields overwrote generated identity. Corrected precedence; patch system/prototype fields blocked.
- Storage mutation delete/create was non-atomic, revision check raced. Transactions added to document/dataset/schema/revision mutation entrypoints; patch CAS update. Need concurrent publish/schema tests, rollback/real SQLite acceptance.
- Dataset deletion left all documents/history/assets/events. Expanded deletion; name-reuse regression added.
- HTTP bespoke router buffered unbounded bytes, checked UTF16 length, passed undefined authorization context; direct API skipped authorization. Replaced with shared HTTP router + canonical invocation, forContext, streaming Node compatibility bridge. Need tests/build.
- HTTP publish bypassed webhook/realtime wrapper; create/patch had no events. Durable event/queue writes added within transaction, dispatcher broadcasts postcommit. Need regression verifying actual HTTP mutation and subscription; restore/delete specifics, actor handling, webhook retries/concurrency/timeouts/logging still to audit.
- Search phase14 absent, match evaluator returned truthy error. Enabled deterministic Unicode-token match + clear disabled error, stable codepoint order, limits regressions. SearchFn reference indexing docs needed.
- Browser/Node client types-only. Runtime typed client outstanding.
- Scheduled publishing explicitly promised in SPEC goal2; implementation outstanding.
- Assets custom storage only; shared storage adapter integration, upload limits/metadata, backend ownership need audit.
- Import/export, history cursor, reference expansion limits, migration integration, CLI full acceptance outstanding.
- Shared DB Drizzle SQLite intentionally lacks async transactions; validate Kysely SQLite for supported transactional path. No fallback to non-atomic mutations.
- Shared HTTP0.3.1 router export copied identically to Browse; root will reconcile overlap. Node server floor20.19 for sync CJS→ESM dependency boundary.

Validation pending. npm install --ignore-scripts started with log /tmp/sf-content-install.log; no production readiness claim yet. Core and admin packed consumer audits must be separate, with local sharedadmin0.1.5/MCP0.0.6 tarballs (unpublished prerequisite). No push/publish.

## 2026-10-16 current checkpoint (11:30 IST)

Shared DB prerequisite committed locally as dabaf5123; root extracted it into its
own prerequisite tree and owns all further DB edits. Root follow-up87236396a was
cherry-picked here as35dbb04a0 (JSON predicates/Kysely counts). Shared DB216tests,
packed Vitest3.2.7/4.1.11 namespace26tests each pass. Awaiting root additive public
`@superfunctions/db/schema` subpath, needed because published observability0.0.1
contains top-level await and prevents synchronous CJS loading of the full DB index.
Content source now imports planned schema subpath; do not run gates until export lands.

Content versions all0.2.0 approved by root, registry confirmed core/client/server0.0.2,
CLI0.0.3,admin404. Current latest completed tests before latest source additions:
server175, core21, client3, CLI7, admin1. Admin/MCP chain built. Conditional import/
require declarations fixed. Core/client/CLI retain18.18 minimum; server20.19 minimum
must be validated with exact-runtime tarball tests. CLI current tests use fixtureHTTP,
real packagedserver+CLI acceptance still pending.

Current packed consumers `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/contentfn-packed-2rpnasi_`:
core/admin production audits both0, strict NodeNext .mts/.cts types pass. Actual
Node20.19 CJS failed at DB->observabilityTLA, not Content itself; root fixing public
synchronous schema boundary. Retained runtime.mjs under consumer/core for rerun after
rebuild/repack. Uses realHTTP Contentserver/client + packedCLI. npm10 crashes Arborist
optional peer resolution; npm11.21 installs cleanly withoutforce.

Implemented additional obligations: asset.created events/queue; configurable webhook
maxAttempts/timeouts; dataset-scoped deliveries query; scheduled publication realtime
notifications; backward-compatible schema changes by default and explicit migration
acknowledgment; selected projections now expand excluded source references correctly;
new revision snapshots for deletion/unpublication; event webhook document type inferred
from immutable revision; optional input validation; idempotency cleanup on datasetdelete;
realSQLite idempotency restart regression added. Latest additions require full rerun.

Remaining: final original-spec audit, package/browser SSE runtime acceptance, strict
minimum18.18 client/core and20.19 server, latest-source packedconsumer/CLI, sharedstorage
asset acceptance, concurrency deliverylease policy/test, complete migrationDDL guidance,
README consistency, artifact exclusions and dependency/prerequisite lock validation.
No Content commit yet; no push. Root owns PR creation and shared prereq integration.

## Delivery checkpoint

Content source committed367b6ee93 (179 server tests); only artifacts remained untracked.
Final packed consumer `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/contentfn-packed-zt_1xkxi`
passes exactNode20.19 server ESM+CJS, realHTTP CRUD/export, builtCLI, admin runtime and
strict .mts/.cts types; core/admin production audits0. Exact18.18 core/client/CLI from
previous identical runtime tarballs passed. NativeChrome final browser check passed.
Shared localstorage actual bytes/failedmapping cleanup passed. HTTPprerequisite separate
d42b1b9e5. No artifacts/generatedfiles committed.

Late metadata audit (uncommitted follow-up): inherited initFunctioncontentFn advertised
on four packages but no such export exists and registry keys collide. Added realserver
registration createContentfnServer, removed bogus purecore/client/CLI metadata, added
physicalgetSchema for sharedCLI, test180 passes. Realsharedgenerator/discovery acceptance
passes SQLite/PostgreSQL/Prisma/Kysely. MySQL keybounds unresolved scope decision with
parent (original document IDs have no explicit maximum; avoid silently narrowing).

### Final schema contract follow-up (2026-10-16)
- Corrected shared CLI discovery: only @contentfn/server advertises its real createContentfnServer initializer and exported getSchema; physical schema version2.
- All physical models now contain literal id for Prisma generation. SHA-256 tuple keys preserve public document IDs while bounding index key size. Revisions include perspective in both key and import existence lookup.
- getSchema and server accept matching jsonStorage native/json-text configuration; default remains explicit text codec. Native mode tested with120KiB UTF-8 content and long public IDs. MySQL arbitrary unindexed strings need LONGTEXT in application migrations; shared CLI currently emits TEXT. No live PostgreSQL/MySQL database acceptance claimed.
- Real shared generator exercised SQLite/PostgreSQL/MySQL Drizzle + Prisma + Kysely; Prisma6.19.0 validate accepted generated PostgreSQL schema. CLI source test is in _conduct/content-schema-generator-check.ts, validation log /tmp/sf-content-prisma-validate.log.
- Schema upgrade CAS now includes observed version+schemaHash; controlled READ COMMITTED interleaving regression verifies stale v2 cannot overwrite committedv3. This is a controlled adapter race, not a live PostgreSQL concurrency result.
- Server182tests passed before adding native JSON large-document regression; focused3schema-discovery tests then passed. Final suite/build/consumer/browser must be rerun once realtime query subscriptions land.

### Final integrated follow-up validation
- Prior uncommitted metadata note is superseded: bounded physical identities preserve public IDs; native JSON configuration and documented MySQL LONGTEXT migration requirements are implemented.
- 189 server tests and 4 client tests pass, including six query subscription tests and the client protocol test. Server/client strict typechecks and ESM/CJS/declaration builds pass.
- Native Chrome acceptance now covers query.snapshot plus deletion-driven query.updated, alongside CRUD, presence/change, and cancellation. Connection count returns to zero. /tmp/sf-content-browser.log.
- Packed final consumer: /var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/contentfn-packed-2rhhf1_7. Core exactNode20.19 ESM/CJS/HTTP/CLI/query subscription/getSchema and strict NodeNext .mts/.cts checks passed; admin exactNode20.19 contract passed. Independent production audits report zero vulnerabilities for core and admin. ExactNode18.18 core/client ESM/CJS and CLI version passed in separate node18 consumer.
- Packed install artifact script initially collided with my prematurely created admin fixture directory; core install was complete, admin package manifest/install/audit resumed separately without changing product sources or dependency selection.
- Query subscriptions use canonical query authorization each refresh, serialized/coalesced invalidation and bounded frames; dataset deletion, revoked permissions and oversized snapshots emit an error and close. Intermediate states may be coalesced; no persisted replay cursor.
- Remaining environment scope: native SQLite and browser are exercised; no live PostgreSQL/MySQL service was provisioned. Shared CLI-generated MySQL TEXT templates must be widened to LONGTEXT for arbitrary large unindexed strings; native JSON requires an adapter/driver that encodes it. Existing installations require the documented physical-ID/schema migration. No deployment or publication performed.
