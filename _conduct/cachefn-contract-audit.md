# CacheFn current-contract audit

Scope: current `cachefn` package READMEs, original V0 design, TypeScript/Python
public APIs, examples and the CacheFn admin adapter. Repository sources are the
authority. Dependency remediation is tracked separately. This audit does not
claim deployment or production readiness from local evidence.

## Implemented contract and intentional roadmap

| Promise | Current implementation / evidence | Assessment |
| --- | --- | --- |
| Memory CRUD, TTL, LRU, tags, patterns, batch methods, counters/events | TS `src/core/cache.ts`, `src/storage/memory-storage.ts`; Python equivalents | Implemented public APIs; focused existing regression suites cover expiration/invalidation/concurrency. |
| Browser persistence | TS `src/storage/indexeddb-storage.ts`; namespace transaction tests | Implemented IndexedDB backend; browser-version coverage is a separate acceptance question. |
| Async/sync memoization | TS `src/memoization/memoize.ts`; Python equivalent | Implemented TTL, capacity, cache control, stats and pending-work protection; documented per-instance/event-loop limits apply. |
| HTTP bindings | `typescript/src/middleware/*`, `HTTP_CACHING.md` | Actual Express/Fastify/Hono acceptance covers representation/privacy and preconditions. Compression tested for the documented Express configuration only. |
| Schema-based TypeScript inference | README type-safe cache example, `src/index.ts` factory | Confirmed defect: factory originally returned union-valued `CacheFn<Schema[keyof Schema]>`. Assigned remediation introduces a schema view and compiler fixtures; source/type-fixture checks and declaration build pass. |
| Admin keys/stats/write/delete/tag/clear | `admin/src/index.ts` | Real bound cache service; no value-read operation. Security boundary is shared dispatcher, not direct adapter invocation. See below. |
| Automatic localStorage fallback and adaptive memory monitoring | Original V0 sections 7 and in-scope list; absent current `StorageType`/config | Original design requirements not implemented. Root README explicitly identifies V0 as original design and SDK READMEs as implemented API. These remain unimplemented original-design items, not evidence of current runtime support. Track explicitly rather than count them as delivered. |
| Filesystem/DB/distributed backends, compression storage, warming, LFU, CLI | V0 out-of-scope and Python unchecked roadmap | Explicit future scope; not required to fabricate these features for current package readiness. |
| Python FastAPI/Flask middleware and DB adapters | Python README unchecked roadmap | Explicit future scope. Python implementation is memory-only. |

## Confirmed actionable items

1. **Schema inference, P2, fixed and verified.** The in-memory
   TypeScript compiler probe using `{'user:*': User; 'post:*': Post}` rejected
   `user.name` as a union access and accepted both
   `set('user:123', {title: 'wrong'})` and unknown-key writes. This violated the
   current README, not merely the roadmap. The new schema view retains ordinary
   `CacheFn<T>` behavior, constrains known key patterns, and checks value/fetcher
   types. Compiler fixtures now pass, including exact keys, multiple wildcards, tuple reads, rejected mismatched writes/fetchers and unknown keys.
2. **Browser support/performance claims exceed evidence — corrected.** TypeScript README
   advertises Chrome 24+, Firefox 16+, Safari 10+ and sub-millisecond / 1–10ms
   access. The package targets ES2021 and uses native async functions, Map/Set,
   optional chaining, BigInt and other modern built-ins. The stated old-browser
   floors are incompatible with emitted code, and no benchmark evidence in this
   audit proves latency promises. Replace floors with tested runtimes/explicit
   feature requirements; label performance numbers as targets until measured.
3. **Python quick-start NameError and metadata drift — corrected.** The cache-aside README
   snippet references `user_id` inside `main()` without defining it. Its status
   says version 0.1.0 and both SDKs complete, while pyproject is 0.0.1 and root
   README says readiness work continues. It says zero dependencies despite the
   required `pydantic>=2.5.0`; distinguish no external cache service from package
   dependencies. These are public documentation defects, not missing engines.
4. **Example exposure needs a local-only/auth boundary — corrected.**
   `typescript/examples/express-api.ts:136–153` exposes stats, clear and arbitrary
   tag invalidation without authorization, then calls `app.listen(port)` with
   no loopback host. It is a simulated-database demo, so this is not proof of an
   exploitable production service, but copying/running it exposes destructive
   demo endpoints on all interfaces. Bind the runnable demo to loopback and
   document that real deployments must use authenticated admin dispatch.
5. **Browser example treats cached content as HTML — corrected.**
   `typescript/examples/browser-app.html:86` appends log strings via innerHTML;
   get-data logs stringify persisted values. Current button-generated values
   are inert, so no remote attacker input path is established here. Use
   textContent/append text nodes to keep the example safe when adapted to real
   cached user data. This is a concrete unsafe sink, not a claimed remote exploit.

## Admin boundary assessment

- The domain service checks `environmentId` on every operation and checks
  `scope.namespace` when an explicit namespace is bound. Clear additionally
  checks the requested namespace identifier. The cache object itself remains
  namespace scoped; service methods do not accept arbitrary storage namespaces.
- Key list/get only return names and existence. Statistics explicitly select
  known numeric fields. Set declares `value` redaction. Clear/delete declare
  confirmation and required audit metadata. Cursors include scope, operation,
  query pattern and validated offsets.
- `packages/admin/src/adapter.ts` is intentionally a domain invocation adapter:
  direct `execute` does **not** enforce permissions, schema validation,
  confirmation or audit. `packages/admin/src/dispatcher.ts:195–242` supplies all
  those gates before invoking handlers, including immutable validated input,
  scope minimum, default/custom policy, confirmation verifier and audit sink.
  Direct adapter calls are therefore not a network authorization boundary. The
  new admin README documents registration, trusted context, durable infrastructure
  and this distinction without presenting a bypass as a mounting example.
- Original CacheFn tests call adapters directly and prove environment denial,
  omission of values and query-bound pagination. New `admin/src/__tests__/dispatcher.test.ts`
  registers the real CacheFn capability with the shared dispatcher and proves
  denied actor/input rejection, absent confirmation/audit failure, namespace and
  environment denial, successful redacted audited writes and confirmed clear.
  All 8 tests across both admin suites pass. This closes the package-specific
  dispatcher acceptance gap; deployment wiring remains a host responsibility.
- No concrete cross-environment/namespace access or cached-value disclosure was
  identified in the inspected domain-service paths. Optional namespace binding
  means an environment-wide binding; it is not evidence of namespace isolation
  unless configured. Deployment wiring must bind the intended cache instance.

## Validation performed for this audit

- Read current TypeScript/Python READMEs, core/public type declarations,
  memoization/HTTP implementation, all admin source/tests, shared adapter and
  dispatcher gates, and runnable example source.
- Ran an in-memory TypeScript program against the actual source to establish
  the schema defect without adding source artifacts.
- Earlier follow-up acceptance in this same worktree passed all 28 middleware
  tests and TypeScript checks, including real gzip hits and failed preconditions.
- Full original V0 claims (95% coverage, latency targets, all historical browser
  floors, automatic fallback, adaptive memory) have not been established and
  must not be claimed complete. Current SDK runtime scope is narrower than that
  original design, explicitly stated by the root README.

## Remediation verification

The assigned schema functionality is implemented and compiler-verified; legacy
CacheFn<T> and untyped factory behavior remains covered by fixtures. Core build
(including ESM/CJS declarations) succeeds. The public docs now state ES2021 feature
requirements and unmeasured latency goals, Python version/dependency scope is
correct, the cache-aside snippet defines its user ID, the Express demo binds to
127.0.0.1, and browser logging uses text nodes. Admin acceptance is 8/8 passing.
These repairs close the actionable current-contract discrepancies above; they do
not imply original V0 automatic fallback/adaptive-memory features were delivered.
