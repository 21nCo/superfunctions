# PlugFn Code Duplication Audit

## Metadata

| Field | Value |
| --- | --- |
| Date | 2026-05-19 |
| Audit ID | k9m4x2p7 |
| Command | audit |
| Model | GPT-5 (Codex) |
| Launcher | Codex Desktop |
| Agent | unknown-agent |
| Repository branch | next |
| Repository commit | 19a2a92f |
| Scope | `plugfn/`, plus reuse boundaries in `packages/`, `clifn/core/`, and Python adapter packages |
| Artifact | `.conduct/audits/2026-05-19-k9m4x2p7-full-audit.md` |

## Scope And Inputs

This audit inspected duplication within PlugFn and duplication against shared Superfunctions packages intended for reuse, especially:

- `plugfn/typescript/`
- `plugfn/providers/`
- `plugfn/client/`
- `plugfn/cli/`
- `plugfn/python/`
- `packages/http/`
- `packages/db/`
- `packages/python-fastapi/`
- `packages/python-flask/`
- `clifn/core/`

Static clone scan:

```sh
npx jscpd plugfn --min-lines 8 --min-tokens 60 --reporters console,json --output .tmp/jscpd/plugfn
```

Result summary:

| Language | Files | Lines | Clone groups | Duplicated lines | Line duplication |
| --- | ---: | ---: | ---: | ---: | ---: |
| TypeScript | 151 | 27035 | 62 | 1139 | 4.21% |
| Python | 37 | 5843 | 22 | 466 | 7.98% |
| JavaScript | 2 | 283 | 0 | 0 | 0.00% |
| Total | 190 | 33161 | 84 | 1605 | 4.84% |

## Executive Summary

PlugFn is not catastrophically duplicated by raw percentage, but the duplication is concentrated in exactly the areas that will hurt production hardening: framework adapters, provider signature/webhook plumbing, sync/watch provider patterns, CLI runtime/config/output, storage CRUD wrappers, client/server response envelopes, and test harness setup.

The most urgent reuse misses are:

- PlugFn CLI reimplements config loading, output formatting, diagnostics, and API-client-like runtime plumbing that `@clifn/core` already exposes.
- Python FastAPI and Flask PlugFn adapters duplicate nearly half their code and bypass the shared `packages/python-fastapi` and `packages/python-flask` route-adapter model.
- Provider HMAC webhook verification is copied across GitHub, Linear, ClickUp, and Gmail despite an existing `plugfn/typescript/src/utils/crypto.ts` helper and the need for provider-authoring utilities.
- PlugFn database storage uses `@superfunctions/db`, but then hand-rolls a large domain CRUD layer without taking advantage of shared schema/codec/namespace helpers where they fit.
- The browser client duplicates runtime owner types and the server response envelope contract; it currently has no generated/shared protocol type boundary.

## Findings

### P1 - PlugFn CLI duplicates `@clifn/core` primitives instead of reusing them

Evidence:

- `plugfn/cli/package.json` depends on `commander`, `chalk`, `jiti`, `ora`, and `inquirer`, but not `@clifn/core`.
- `plugfn/cli/src/utils/load-config-file.ts:1` implements TypeScript config loading with `jiti`.
- `plugfn/cli/src/commands/test.ts:118` defines local diagnostic error classes and report shapes.
- `plugfn/cli/src/commands/test.ts:451` resolves `plugfn.config.*` files manually.
- `plugfn/cli/src/commands/runtime.ts:125` writes JSON/human output manually.
- `clifn/core/src/config-loader.ts:17` already exposes config loader errors, candidates, validation, `.json` support, remote path blocking, and TypeScript loading.
- `clifn/core/src/output.ts:1` exposes `createOutput`-style output modes, JSON normalization, color, tables, spinners.
- `clifn/core/src/diagnostics.ts:1` exposes diagnostic redaction, sorting, and formatting.
- `clifn/core/src/client.ts:1` exposes fetch client primitives with retries and structured HTTP errors.

Impact:

This duplicates CLI foundation code in a package that should be consumer-facing and production hardened. It increases drift in config loading semantics, diagnostics redaction, output modes, error codes, retry behavior, and testability across Superfunctions CLIs.

Recommendation:

Make `@plugfn/cli` depend on `@clifn/core` and migrate in this order:

1. Replace `loadConfigFile` and `findConfigPath` with `loadConfig({ candidates: ['plugfn.config.ts', ...], exportNames: ['plug', 'default'], validate })`.
2. Replace ad hoc `writeOutput` and `formatHuman` with `createOutput`.
3. Replace local diagnostic report formatting with `createDiagnostic`, `formatDiagnosticsText`, and JSON report helpers.
4. Use `createApiClient` only for PlugFn hosted/API commands that call HTTP endpoints; keep injected runtime diagnostics separate.

### P1 - Python FastAPI and Flask adapters duplicate framework-neutral PlugFn route logic

Evidence:

- jscpd reports `plugfn/python/plugfn/adapters/fastapi.py` at 48.20% duplication and `plugfn/python/plugfn/adapters/flask.py` at 46.06%.
- Large clone pairs include:
  - `fastapi.py:272-311` and `flask.py:298-337`
  - `fastapi.py:318-352` and `flask.py:337-371`
  - `fastapi.py:194-224` and `flask.py:215-245`
- Both files define their own `AdapterSecurityError`, auth provider invocation, principal normalization, identity matching, scope normalization, webhook secret lookup, success envelope, and error envelope.
- Shared adapter packages already exist:
  - `packages/python-fastapi/superfunctions_fastapi/adapter.py`
  - `packages/python-flask/superfunctions_flask/adapter.py`

Impact:

Security and authorization fixes must be patched twice. This is particularly risky because these adapters enforce identity matching and webhook handling. It also prevents PlugFn Python from following the same shared HTTP adapter path as other Superfunctions packages.

Recommendation:

Create a framework-neutral Python PlugFn route/core module, for example `plugfn/python/plugfn/adapters/_routes.py`, that returns route handlers or a small dispatch table. Then make FastAPI and Flask files thin binding layers. Prefer integrating through `superfunctions_fastapi.create_router` and `superfunctions_flask.create_blueprint` where feasible, or make PlugFn generate `superfunctions.http.Route` objects and mount them through the shared adapters.

### P1 - Provider webhook HMAC verification is copied across first-party providers

Evidence:

- `plugfn/providers/src/github/index.ts:498-524`
- `plugfn/providers/src/linear/index.ts:521-547`
- `plugfn/providers/src/clickup/index.ts:225-251`
- `plugfn/providers/src/gmail/index.ts:462-489`
- All repeat: empty signature/secret guard, raw body guard, `sha256=` prefix stripping, `createHmac('sha256', secret)`, buffer length check, and `timingSafeEqual`.
- `plugfn/typescript/src/utils/crypto.ts:83` already defines a generic `verifyHmacSignature`, though it compares strings without prefix/raw-body ergonomics and does not guard length before `timingSafeEqual`.

Impact:

Webhook verification is security-sensitive. Copied implementations create a high chance that one provider gets a bug fix while another remains vulnerable or incompatible. This also makes future provider expansion noisier than needed.

Recommendation:

Add a provider-authoring helper in `@plugfn/providers`, for example `shared/signature.ts`:

- `verifyRawBodyHmac({ rawBody, signature, secret, algorithm, prefix })`
- constant-time comparison with length check
- signature normalization for provider prefixes
- typed `WebhookVerificationContext` input

Then migrate GitHub, Linear, ClickUp, Gmail, and Stripe to the helper. Consider deprecating or replacing `plugfn/typescript/src/utils/crypto.ts:83` with the safer helper to avoid two competing HMAC APIs.

### P1 - Client/server response envelope and error typing are duplicated without a shared protocol contract

Evidence:

- Server envelope helpers live in `plugfn/typescript/src/router/http-router.ts:1221`, `:1229`, and `:1247`.
- Server deterministic error shape is local to `plugfn/typescript/src/router/http-router.ts:32`.
- Browser client repeats the envelope and error shape in `plugfn/client/src/index.ts:50` and `:216`.
- `plugfn/client/src/types.ts:1-13` duplicates `PlugFnOwnerKind` and `PlugFnConnectionOwner` from `plugfn/typescript/src/types/runtime.ts:1-13`.

Impact:

This is an API contract drift risk. A server-side envelope or owner type change can silently break the client package because there is no shared source of truth. The duplication is small by lines, but high leverage because it is the public integration API.

Recommendation:

Introduce a shared protocol type boundary:

- Option A: export browser-safe protocol types from `plugfn` without pulling Node-only code.
- Option B: add a tiny `@plugfn/protocol` or `plugfn/client` generated type build from core declarations.

At minimum, move envelope and deterministic error types into a shared `src/types/http.ts` module and import them in server and client builds.

### P2 - PlugFn database adapter uses `@superfunctions/db` but reimplements repetitive CRUD mapping

Evidence:

- `plugfn/typescript/src/storage/adapters/database.ts:16-85` defines model mapping twice: object values and a parallel required-name union/list.
- `plugfn/typescript/src/storage/adapters/database.ts:87-133` defines a broad storage interface with repetitive CRUD methods.
- `plugfn/typescript/src/storage/adapters/database.ts:205-618` repeats create/find/list/update/delete/upsert method bodies around `database.create`, `database.findOne`, `database.findMany`, `database.update`, `database.delete`, and `database.upsert`.
- `plugfn/typescript/src/storage/adapters/database.ts:620-643` defines local `cloneRecord` and `toWhereClauses`.
- `packages/db/src/index.ts:83-93` exports `SchemaTracker`, runtime validation, schema normalization, date codecs, and `wrapWithSchema`.

Impact:

This is not a pure copy-paste bug, because domain storage methods need domain names. But the current adapter creates a large surface area for inconsistent ordering, conflict targets, filter semantics, cloning behavior, schema transforms, and namespace isolation.

Recommendation:

Keep domain-specific storage methods, but extract reusable local model repository helpers:

- `modelRepo<T>(database, model)` with `create`, `getById`, `updateById`, `deleteById`, `listByFilters`.
- derive `PLUGFN_REQUIRED_MODEL_NAMES` from `DEFAULT_PLUGFN_STORAGE_MODELS` instead of maintaining a parallel list.
- use `wrapWithSchema` and `validateRecordAgainstSchema` for date/schema conversion instead of manual clone/JSON fallbacks where possible.
- document when PlugFn must layer domain semantics above `@superfunctions/db` rather than adding them to shared DB.

### P2 - Mail provider sync/watch logic duplicates provider lifecycle patterns

Evidence:

- jscpd reports notable duplication in mail provider and tests:
  - `plugfn/providers/src/imap-smtp/index.ts` at 21.16%
  - `plugfn/providers/src/icloud/index.ts` at 24.88%
  - `plugfn/providers/src/yahoo/index.ts` at 13.81%
  - `plugfn/providers/src/managed-mail/index.ts` at 15.67%
  - `plugfn/providers/src/gmail/index.ts` at 12.91%
  - `plugfn/providers/src/outlook/index.ts` at 16.56%
- Gmail and Outlook sync/subscription files repeat policy registry defaults, checkpoint store interfaces, message store interfaces, max-message clamping, provider policy errors, retry/rate-limit wiring, and memory stores.
- `plugfn/typescript/src/mail/index.ts` exists but currently only reexports backup/policy/normalization modules.

Impact:

New mail providers will likely copy the same sync, checkpoint, watch, and policy scaffolding. This undercuts the goal of PlugFn as a scalable provider platform.

Recommendation:

Add provider-authoring utilities for mail:

- `createMailSyncRunner`
- shared checkpoint/result types
- shared memory message/checkpoint stores for tests
- shared policy assertion helpers
- shared subscription/watch lifecycle helpers where provider semantics allow it

Keep provider-specific API calls and normalization provider-local.

### P2 - Python HTTP client repeats request method bodies

Evidence:

- jscpd reports `plugfn/python/plugfn/http/http_client.py` at 35.69% duplication.
- `get`, `post`, `put`, `patch`, and `delete` each rebuild URL, auth headers, basic auth, `httpx.AsyncClient`, response status handling, and empty-body JSON behavior.

Impact:

Behavior is likely to drift across HTTP verbs. For production integrations, retry, timeout, empty body, JSON decode, and error handling need to be consistent.

Recommendation:

Refactor to a single `_request(method, path, *, params, data, json, headers, **kwargs)` helper and have verb methods delegate to it. If shared Python HTTP client utilities exist later in `superfunctions`, move this there.

### P2 - Test harness duplication is high and hides runtime behavior drift

Evidence:

- Largest clone groups:
  - `plugfn/typescript/tests/workflow-idempotency.test.ts:146-259` and `workflow-lifecycle.test.ts:88-201` duplicate 114 lines.
  - `workflow-durability.test.ts:145-249` and `workflow-lifecycle.test.ts:84-188` duplicate 105 lines.
  - `connection-oauth.test.ts:99-151` and `oauth-integration.test.ts:155-207` duplicate 53 lines.
  - `python/tests/test_fastapi_auth.py:9-58` and `test_flask_auth.py:8-57` duplicate 50 lines.
- Top duplicated files include `workflow-lifecycle.test.ts`, `oauth-integration.test.ts`, `connection-oauth.test.ts`, `connection-manager.test.ts`, Python auth adapter tests, and provider mail tests.

Impact:

Tests are allowed to duplicate more than production code, but this amount of duplication makes behavioral changes harder to validate. It also inflates future refactor cost and may cause tests to assert stale behavior in only one copy.

Recommendation:

Create PlugFn test helpers:

- workflow runtime fixture
- OAuth provider/token fixture
- router auth fixture
- provider webhook signature fixture
- Python adapter shared auth fixture
- mail sync/watch fixture stores

Use per-test files only for behavioral deltas.

### P3 - OAuth legacy shim is acceptable duplication with a removal target

Evidence:

- `plugfn/typescript/src/auth/oauth-flow.ts:10-13` explicitly warns that the old path is deprecated and points to `@superfunctions/oauth-flow`.
- `plugfn/typescript/src/core/connection-manager.ts:20-33` uses `@superfunctions/oauth-core`, `@superfunctions/oauth-http`, `@superfunctions/oauth-flow`, `@superfunctions/oauth-storage`, and `@superfunctions/oauth-providers`.

Impact:

This is a temporary compatibility layer rather than an accidental shared-package duplication. It should stay only if the removal target remains enforced.

Recommendation:

Keep the shim only through the stated `plugfn@0.2.0` window. Add release checklist enforcement so new production code does not import `plugfn/typescript/src/auth/oauth-flow.ts`.

## Duplication Matrix

| Area | Severity | Evidence | Recommended owner |
| --- | --- | --- | --- |
| CLI config/output/diagnostics | P1 | Local `jiti`, output, diagnostics in `plugfn/cli`; reusable equivalents in `clifn/core` | `@plugfn/cli` + `@clifn/core` |
| Python framework adapters | P1 | FastAPI 48.20%, Flask 46.06% duplicated | `plugfn/python` + shared Python HTTP adapters |
| Provider HMAC verification | P1 | Same 27-line verifier copied in GitHub/Linear/ClickUp/Gmail | `@plugfn/providers` shared helpers |
| Client/server API protocol | P1 | duplicated envelope/error/owner types | `plugfn` protocol boundary |
| DB storage CRUD mapping | P2 | repetitive model CRUD around `@superfunctions/db` | `plugfn/typescript/src/storage` |
| Mail sync/watch provider patterns | P2 | mail providers/tests show 13-24% duplicate clusters | `@plugfn/providers` mail helpers |
| Python HTTP client methods | P2 | 35.69% duplication in `http_client.py` | `plugfn/python` |
| Test fixtures | P2 | largest clone groups are workflow/OAuth/provider tests | `plugfn` test support |
| OAuth legacy shim | P3 | deprecation wrapper over shared OAuth packages | release cleanup |

## Shared Package Reuse Matrix

| Shared package | Current PlugFn use | Duplication concern | Action |
| --- | --- | --- | --- |
| `@clifn/core` | Not used by `@plugfn/cli` | CLI config/output/diagnostics/client primitives duplicated | Add dependency and migrate CLI foundations |
| `@superfunctions/http` | Used for TypeScript router creation | PlugFn still owns custom envelope/error/body parsing; Python adapters bypass shared route adapters | Share envelope/protocol types; use Python adapter packages for Python mounting |
| `@superfunctions/db` | Used as storage adapter type and runtime DB | PlugFn repeats CRUD repository plumbing and schema/model lists | Extract local repo helper; use schema/codec/validation helpers where applicable |
| `@superfunctions/oauth-*` | Properly used in connection manager | Legacy shim remains | Keep only through compatibility window |
| `packages/python-fastapi` / `packages/python-flask` | Not used by PlugFn Python adapters | PlugFn duplicates mount and response/error logic per framework | Mount shared `superfunctions.http.Route` objects through these adapters |

## Requirements And Results

| Requirement | Result |
| --- | --- |
| Audit duplication within PlugFn | Completed with jscpd and targeted code review |
| Audit duplication against shared Superfunctions packages | Completed for HTTP, DB, Python adapters, OAuth, and CLI core |
| Audit duplication against clifn | Completed against live `clifn/core` package |
| Avoid implementation edits | Satisfied; only audit/log artifacts were written |
| Create audit artifact | Satisfied |
| Append `.conduct/logs.csv` | Satisfied |

## Gaps And Conflicts

- jscpd reports absolute paths in generated JSON; this audit records only repository-relative paths.
- The raw jscpd JSON is under `.tmp/` and should remain a temporary local artifact.
- Test duplication is intentionally lower priority than production duplication, but the workflow/OAuth fixtures are now large enough to slow production hardening.
- `@superfunctions/http` does not currently expose PlugFn's deterministic envelope shape. The right fix may be a PlugFn protocol module rather than forcing a PlugFn-specific response envelope into shared HTTP.
- Some DB repetition is legitimate domain storage. The recommended fix is not to make `@superfunctions/db` know PlugFn, but to introduce a small local repository abstraction and use shared DB codecs/validation.

## Recommended Fix Plan

1. CLI reuse first:
   - Add `@clifn/core` to `plugfn/cli/package.json`.
   - Replace config loading, output, diagnostics, and HTTP-client-like helpers.
   - Keep command behavior and tests stable during migration.

2. Security-sensitive provider helper:
   - Add `plugfn/providers/src/shared/signature.ts`.
   - Migrate GitHub, Linear, ClickUp, Gmail, and Stripe verifiers.
   - Add cross-provider verifier tests for prefix/no-prefix, empty raw body, wrong length, and invalid secret.

3. Python adapter core:
   - Extract shared auth/principal/envelope/webhook-secret helpers.
   - Move route semantics into a framework-neutral layer.
   - Rebuild FastAPI/Flask adapters as thin binders, preferably on `superfunctions_fastapi` and `superfunctions_flask`.

4. Protocol boundary:
   - Move `PlugFnEnvelope`, deterministic error, and owner/client DTO types into a shared browser-safe module.
   - Import those types from server router and browser client.

5. Storage repository cleanup:
   - Derive required model names from defaults.
   - Add a local generic repository helper for repeated CRUD.
   - Evaluate `wrapWithSchema` and runtime validation for PlugFn schema date fields.

6. Mail/provider authoring helpers:
   - Introduce shared mail sync/watch scaffolding.
   - Keep provider-specific API and normalization code provider-local.

7. Test fixture consolidation:
   - Add shared fixtures after production helper extraction so tests verify the new reusable paths.

## Appendix: Commands Run

```sh
git status --short
sed -n '1,220p' audit-skill/SKILL.md
rg -n "plugfn|clifn|@superfunctions/db|@superfunctions/http" memory-registry
npx jscpd plugfn --min-lines 8 --min-tokens 60 --reporters console,json --output .tmp/jscpd/plugfn
rg -n "@clifn/core|createOutput|loadConfig|createApiClient|createDiagnostic|jiti|timingSafeEqual|createHmac|verify.*signature|signature" plugfn/cli plugfn/providers/src plugfn/typescript/src -g '*.ts'
sed -n '1,260p' plugfn/cli/src/utils/load-config-file.ts
sed -n '1,260p' plugfn/cli/src/commands/runtime.ts
sed -n '1,260p' plugfn/cli/src/commands/test.ts
sed -n '1,240p' packages/http/src/errors.ts
sed -n '1,220p' packages/http/src/router.ts
sed -n '1,240p' packages/db/src/index.ts
sed -n '1,220p' packages/db/src/migrations/schema-tracker.ts
sed -n '1,260p' plugfn/typescript/src/router/http-router.ts
sed -n '1,260p' plugfn/typescript/src/storage/adapters/database.ts
sed -n '1,220p' plugfn/typescript/src/mail/index.ts
sed -n '1,260p' plugfn/python/plugfn/adapters/fastapi.py
sed -n '1,260p' plugfn/python/plugfn/adapters/flask.py
sed -n '1,240p' plugfn/python/plugfn/http/http_client.py
find packages -maxdepth 3 -type f
find plugfn -maxdepth 3 -type f -name package.json -o -name pyproject.toml
cat plugfn/cli/package.json plugfn/typescript/package.json plugfn/providers/package.json plugfn/client/package.json plugfn/python/pyproject.toml
node -e "parse jscpd summary"
node -e "parse largest clone pairs"
date -u +%Y-%m-%dT%H:%M:%SZ
git rev-parse --abbrev-ref HEAD
git rev-parse --short HEAD
```
