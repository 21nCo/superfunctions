# CompFn contract and package acceptance — 2026-10-15

Scope: original February 5 SPEC/REQUIREMENTS and phase definitions under `.conduct/specs/2026-02-05-new-cp2m5k9x-spec`, current README, core/CLI/admin packages. No Python implementation exists; SPEC explicitly defers it. Evidence here is local process/database/package acceptance, not deployment or certification.

## Core contracts

- CRUD control/framework definitions, immutable evidence ingestion and artifact references, checks, readiness policy and JSON auditor exports have dedicated tests. Incoming shared database adapters are wrapped internally with CompFn's schema. No consumer `adapterSchema` is required.
- Reference validation now preserves storage errors instead of describing unavailable controls as missing. Scoped exports likewise propagate unavailable control storage, while allowing actually deleted historical controls to remain referenced in evidence/mapping. Explicit framework readiness lookups propagate errors.
- Circular/BigInt evidence payloads return validation envelopes. Malformed adapter results return adapter errors. Schema validation cannot report success when an adapter returns `valid:false` with an empty errors list.
- AuthFn/SecFn requested methods are isolated: a missing or unrecognized selected method produces unknown evidence, never a successful different policy. Regression coverage runs these through checks and readiness.
- Core list responses have a 1000-record bound, return an explicit error on overflow, and apply tag filters first. This implements SPEC's allowed oversized-list error. Export/readiness propagate the error instead of silently producing incomplete reports.
- Readiness deliberately follows SPEC's pass-within-window rule, not latest-result-only semantics. Historical later failures do not erase an earlier in-window pass. The deployment selects appropriate controls/policy.

## Bundle

The exported `compfn/bundles/soc2-type2.json` is now included in tarballs. Its 43 controls have explicit bundle-local references, including the five names whose slugs did not match requirement references. Tests load the actual JSON, assert all 17 requirements map to generated IDs, and repeat the load. Every load creates an independent framework and controls; the original public API did not promise idempotent upserts. Legacy name-slug references remain accepted, and `useStableControlIds` remains accepted but unnecessary. Duplicate/invalid local references fail before writes. Database failures during a load can leave already-created controls; no transaction guarantee is claimed.

## Persistent CLI

`cli-persistent.test.ts` uses real better-sqlite3 and the shared Drizzle adapter, with host-owned migrations in the adapter initializer. Six independent Node processes cover init, seeding controls/framework/checks, CLI attest, CLI run-checks, CLI export, and a failed CLI attest. Assertions cover persisted tags/requirements/customConfig/evidence payload, valid JSON stdout, nonzero failure status, and initializer/close pairs on every process. It does not substitute a direct API call for the CLI attest. Additional CLI tests cover ephemeral JSON memory config, paths containing spaces, missing checks, unsupported JSON database config, malformed config, and file export.

## Explicit deployment responsibilities and deferred scope

- `schedule`/`trigger` are stored metadata. Hosts invoke checks.run from cron/event orchestration; phase04 defines manual invocation and adapter execution, not a background scheduling engine. Custom checks use a configured adapter; customConfig alone does not execute arbitrary scripts.
- Included AuthFn/SecFn clients are host bridge interfaces. Their method names are not actual public SDK methods in the current authfn/secfn trees. Phase07 explicitly excludes a real SDK dependency and permits configured/mock clients. Documentation now states this boundary; direct real-service integration is not demonstrated.
- Retention is explicitly deployment-owned in SPEC; core exposes no evidence update/delete. File uploads store artifact references; object-storage access controls are deployment-owned. Namespace requires shared adapter configuration or separate databases; the CompFn option alone is not a tenant isolation guarantee.
- Python, dashboard UI, PDF/HTML reports, native adapters for the six additional superfunctions, and live deployments are not represented as completed. Phase07 explicitly defers those additional adapters, and SPEC explicitly makes Python/UI/PDF optional.

## Packed runtime baseline

Persistent script: `compfn/scripts/packed-consumer.mjs`. It packs seven local packages, installs them into an isolated consumer, verifies the real SOC2 JSON export, ESM/SSR-safe imports, and Node16/NodeNext TypeScript consumers including dynamic imports from CJS. Both CompFn packages are ESM; no synchronous CJS export is claimed.

Latest baseline consumer: `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/compfn-packed-consumer-xT8UMx`.
- Node18.18.0,20.20.2,22.23.3 packed import/bundle probes pass after replacing global crypto with explicit node:crypto imports.
- Production support is Node20+ because the shared administration/runtime dependency graph declares that floor. Node18 is informational only.
- Drizzle0.45.4 consumer resolves the old0.35 SQL identifier advisory; native SQLite acceptance passes with the upgraded ORM.
- Runtime-only audit still has five high package entries caused by baseline shared MCP0.0.5 → SDK1.29.0 and fast-uri3.1.5. These are real runtime findings, not root-workspace development-tool noise. A separately owned shared-runtime patch is required before the final security gate. Initial baseline additionally used vulnerable Drizzle0.35; that consumer-only pin has been corrected.

Admin pagination/redaction/real dispatcher acceptance is owned by the parent agent and will be added after handoff. Core final typecheck and 112 tests passed. Strict packed consumer declarations also pass without skipLibCheck. Final integrated builds and patched-runtime audit remain to be recorded.

## Requirement coverage index

| Original requirements | Evidence |
| --- | --- |
| CTRL-001/002, FW-001/002 | controls/frameworks/evidence unit tests; failure-envelopes storage-reference regressions; persistent SQLite mappings |
| EVID-001/002/003, LIMIT-001 | evidence type/immutability/payload tests; invalid JSON payload regressions; export caps; explicit list overflow regression |
| CHECK-001/002 | checks suite; persistent CLI run and export; unavailable method and malformed adapter regressions |
| READY-001 | readiness suite and provider suite; unsupported checks cannot become compliant; framework storage errors propagate |
| EXPORT-001 | export suite, CLI stdout/file export, scoped storage error regressions |
| API-001/002 | schema ownership and real Drizzle CLI fixture; schema rejection regression; canonical error tests |
| OBS-001 | observability test captures success/failure ingestion, check and export events; payload and adapter exception secret markers absent from logs |
| ADAPT-001/002/003 | adapter/check tests; strict method isolation; phase07's configured-client scope documented |
| BUNDLE-001 | real shipped43-control/17-requirement JSON load twice; installed tarball JSON path + load |
| COMPAT-001 | schema version1 plus original SPEC compatibility rules; public README now states additive versus breaking changes |
| HTTP-001 | shared Web Request router tests, body cap and envelope tests; host authorization remains deployment-owned |
| CLI-001 | real subprocess/native SQLite sequence and failure/JSON-output tests |
| PROVIDER-001 | provider suite and readiness/evidence-due documentation |


## Final admin integration — 2026-10-16

The branch is stacked on shared-runtime prerequisite `02deb6acad1aa978118943effbe28aa76af3608c`, with @superfunctions/admin0.1.5 and MCP0.0.6. Product dependency lock regeneration uses workspace versions, not machine-local tarballs.

Admin now has signed keyset pagination, full-scope/query/resource binding, 15-minute expiration, instance-local default secrets and optional shared replica secrets of at least32bytes. Real dispatcher tests cover65rows across default50record pages; search/filter/sort; tampering/query/scope/expiry rejection; malformed sorting; core predicate pushdown against1001rows; unauthorized mutation denial; audited idempotent mutation replay; evidence/report value+secret redaction; and optional-field JSON transport. Reports are sensitive resources. Admin JSON output normalization fixes the strict dispatcher rejection of valid report objects with undefined optional properties. Documentation states live pagination and the1000record core collection bound.

Admin minimum runtime is20; the Node18 combined core/admin probe is informational and may fail once the paginator uses standard global WebCrypto. Core UUID generation itself works on18. The final packed script gates the supported20/22runtimes and audit status.


Final gates: clean scoped npm ci installed488packages successfully; native better-sqlite3 rebuild passed;7dependency/product builds and10Turbo build/type/test tasks passed. The original core Vitest config also discovered nested admin tests:118passing in core command included8admin tests, which ran again in the admin command. Core discovery is now explicitly restricted to its src tests; final unique expected total110core+8admin.

Final packed consumer `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/compfn-packed-consumer-ipT3uk`: strict Node16/NodeNext declarations pass, supported Node20.20.2/22.23.3 runtime imports and shipped SOC2load pass, runtime-only audit0vulnerabilities across137production dependencies. Informational Node18probe fails in admin WebCrypto as documented outside the supported floor. No machine-local file resolutions exist in the committed workspace lockfile.
