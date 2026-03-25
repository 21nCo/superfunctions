# Metadata

- Timestamp: `2026-03-22T14:45:13Z`
- agent_name: `unknown-agent`
- model: `Codex (GPT-5)`
- launcher: `Codex Desktop`
- workspace/project path: `/Users/serro/Documents/dev/n/superfunctions/authfn`
- OS + shell: `Darwin 25.3.0 arm64` / `/bin/zsh`
- repo metadata:
  - repo root: `/Users/serro/Documents/dev/n/superfunctions`
  - branch: `heads/next`
  - commit: `b69090aaa83f0515924aa9b11df3b1fcd4de3a1a`
  - dirty: `yes`
- intent/notes paths audited:
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/.conduct/tracker.csv` (row `2026-03-21-new-a7m3k9q2-spec`: "Build authfn into a full multi-runtime authentication platform that can replace Better Auth in 21n and nucleus")
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/.conduct/specs/2026-03-21-new-a7m3k9q2-spec/INTENT_AUDIT.md`
- spec bundle paths audited:
  - root: `/Users/serro/Documents/dev/n/superfunctions/authfn/.conduct/specs/2026-03-21-new-a7m3k9q2-spec`
  - authoritative files:
    - `SPEC.md`
    - `REQUIREMENTS.md`
    - `TEST_VECTORS.md`
    - `PLAN.md`
    - `INTENT_AUDIT.md`
    - `phases/PHASE_00.md`
    - `phases/PHASE_01.md`
    - `phases/PHASE_02.md`
    - `phases/PHASE_03.md`
    - `phases/PHASE_04.md`
    - `phases/PHASE_05.md`
    - `phases/PHASE_06.md`
    - `phases/PHASE_07.md`
    - `phases/PHASE_08.md`
  - supplementary context only, not used for pass/fail:
    - `logs.csv`
    - `phase-reports/*`
- codebase scope audited:
  - root: `/Users/serro/Documents/dev/n/superfunctions/authfn`
  - audited source/test surfaces:
    - `core/src`, `core/tests`
    - `client/src`
    - `svelte/src`
    - `python/authfn`
    - `python/tests`
    - package metadata/readmes where relevant
  - excluded from pass/fail:
    - generated/build artifacts under `dist/`
    - `.venv/`
    - `.pytest_cache/`
    - spec execution artifacts under `phase-reports/`
- commands executed during audit:
  - `find`, `rg`, `sed`, `nl`, `wc`
  - `git status`, `git rev-parse`
  - `npm test --workspace @authfn/core`
  - `npm test --workspace @authfn/client`
  - `npm test --workspace @authfn/svelte`
  - `npm run build --workspace @authfn/core`
  - `npm run build --workspace @authfn/client`
  - `python3 -m pytest /Users/serro/Documents/dev/n/superfunctions/authfn/python/tests`
  - `date -u`, `uname`

# Audit scope

This was a full read-only audit of the current `authfn` working tree against:

1. the locally available intent sources (`tracker.csv` task description plus the bundle's validated `INTENT_AUDIT.md`), and
2. the full provided spec bundle (`SPEC`, `REQUIREMENTS`, `TEST_VECTORS`, `PLAN`, `phases`).

No separate `authfn/.conduct/intent/...` tree or additional local intent notes were present. I therefore treated the tracker row plus `INTENT_AUDIT.md` as the authoritative local intent inventory and validated that inventory against the rest of the bundle rather than assuming it was complete.

# Inputs audited (intent + spec bundles)

## Intent inputs

1. `/Users/serro/Documents/dev/n/superfunctions/authfn/.conduct/tracker.csv`
2. `/Users/serro/Documents/dev/n/superfunctions/authfn/.conduct/specs/2026-03-21-new-a7m3k9q2-spec/INTENT_AUDIT.md`

## Spec bundle

- Root: `/Users/serro/Documents/dev/n/superfunctions/authfn/.conduct/specs/2026-03-21-new-a7m3k9q2-spec`
- Files audited for pass/fail:
  - `SPEC.md`
  - `REQUIREMENTS.md`
  - `TEST_VECTORS.md`
  - `PLAN.md`
  - `INTENT_AUDIT.md`
  - `phases/PHASE_00.md` through `phases/PHASE_08.md`

## Implementation evidence reviewed

- TypeScript packages:
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/client`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/svelte`
- Python package:
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python`
- Legacy package reviewed for compatibility/drift context:
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/ts-sdk`

# High-level findings

1. `DATA-001`, `SOC-001`, and `PY-001` are not satisfied in Python because the Python social OAuth implementation reimplements state/token handling instead of using the shared flow/token-vault stack, and it writes raw token JSON into `oauth_tokens.encrypted_payload` rather than encrypting it at rest. This is the most serious security/compliance gap.
2. `OBS-001` fails across runtimes. TypeScript envelopes and events do include request IDs, but the fallback request ID is regenerated on every call, so events are not reliably linked to the envelope for the same request. Python lacks a general observability configuration/event sink for core auth flows entirely.
3. `OTP-002`, `PLUG-001`, and `REGION-001` are only partially met because both runtimes invoke `beforeChallengeSend`/`afterChallengeSend` with empty hook context, so request-aware throttling/region-aware behavior cannot be implemented through the documented hook contract.
4. `REGION-001` is also only partially met because social-user creation bypasses composed plugin `afterUserCreate` behavior in TypeScript and bypasses region registration hooks/helpers in Python, so multi-region profile/directory registration is not guaranteed for new social sign-ins.
5. The canonical error/limits surface is incomplete. `AUTHFN_EMAIL_NOT_VERIFIED` and `AUTHFN_RATE_LIMITED` are specified but not implemented as usable runtime errors; provider rate limiting is mapped to `AUTHFN_INTERNAL_ERROR`; and the default 2FA recovery-code batch size is `8` in both runtimes instead of the specified default `10`. API key name-length capping is also not enforced.
6. The spec itself is internally coherent: I found no direct conflicts across `SPEC`, `REQUIREMENTS`, `TEST_VECTORS`, `PLAN`, and `phases`. The main drift is between the implementation/spec and a stale verification test: `authfn/core/tests/schema.test.ts` still expects a pre-shared-OAuth/pre-`two_factor_challenges` table list, so Phase DoD is not met even though the expanded schema is the correct spec behavior.

# Intent Inventory

1. The spec/implementation must be thorough enough to replace Better Auth in `21n` and `nucleus`.
2. Legacy `nucleus` auth is out of scope; only the Better Auth replacement surface matters.
3. Google, Apple, and GitHub OAuth sign-in are required.
4. Email-password sign-in is required.
5. OTP flows are required.
6. Shared OAuth primitives must be reused rather than reimplemented.
7. `superfunctions/http` must be used for endpoints.
8. `superfunctions/db` and `@superfunctions/cli`-style schema semantics must be used.
9. Plugins/hooks must be the extensibility model.
10. 2FA is required and should remain plugin-first.
11. Multi-region support must be first-class and may be implemented as a plugin if clean.
12. Python support is required from the start.
13. The design should optimize for clean `authfn` architecture rather than compatibility shims.
14. New package boundaries are allowed if they improve architecture.
15. Migration/cutover paths are explicitly deferred.
16. Delivery integrations must be provider-agnostic; future `sendfn` integration is acceptable but not required now.

# Intent → Spec coverage matrix

| Intent # | Intent item | Spec mapping | Requirement IDs | Test vectors | Intent→spec status | Implementation status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Replace Better Auth in `21n`/`nucleus` | `SPEC.md` Overview, Goals, Public API, Semantics | `ARCH-001`, `CORE-001`, `HTTP-001`, `SESS-001`, `PASS-001`, `OTP-001`, `SOC-001`, `TFA-001`, `REGION-001`, `CLIENT-001`, `PY-001` | `TV-AF-001`, `002`, `004`, `006`, `010`, `011`, `014` | PASS | PARTIAL |
| 2 | Ignore legacy `nucleus` auth | `SPEC.md` Non-goals, Undefined | `ARCH-001` | N/A | PASS | PASS |
| 3 | Google/Apple/GitHub OAuth | `SPEC.md` Goals, Public API, Social semantics | `SOC-001`, `SOC-002` | `TV-AF-006`, `007`, `008` | PASS | PARTIAL |
| 4 | Email-password sign-in | `SPEC.md` Goals, Public API, Password semantics | `PASS-001` | `TV-AF-002`, `003`, `005` | PASS | PASS |
| 5 | OTP flows | `SPEC.md` Goals, Public API, OTP model/semantics | `OTP-001`, `OTP-002` | `TV-AF-004`, `005`, `012` | PASS | PASS |
| 6 | Reuse shared OAuth primitives | `SPEC.md` Overview, OAuth model, Invariants | `CORE-001`, `SOC-001` | `TV-AF-006`, `007`, `008` | PASS | PARTIAL |
| 7 | Use `superfunctions/http` | `SPEC.md` Overview, Public API, Semantics | `CORE-001`, `HTTP-001` | `TV-AF-001`, `002` | PASS | PASS |
| 8 | Use `superfunctions/db` and CLI schema semantics | `SPEC.md` Overview, Data formats/protocol, Semantics | `CORE-001`, `DATA-001` | `TV-AF-001`, `009` | PASS | PARTIAL |
| 9 | Plugins/hooks approach | `SPEC.md` Public API, Hook semantics, Invariants | `CORE-002`, `PLUG-001`, `OTP-002`, `REGION-001` | `TV-AF-001`, `012` | PASS | PARTIAL |
| 10 | 2FA required and plugin-first | `SPEC.md` Goals, Public API, 2FA semantics | `TFA-001` | `TV-AF-010` | PASS | PASS |
| 11 | Multi-region first-class/plugin | `SPEC.md` Goals, Public API, Multi-region model/semantics | `REGION-001` | `TV-AF-011`, `012` | PASS | PARTIAL |
| 12 | Python from the start | `SPEC.md` Overview, Public API, Python parity semantics | `ARCH-001`, `PY-001` | `TV-AF-014` | PASS | PARTIAL |
| 13 | Favor clean `authfn` design | `SPEC.md` Goals, Public API | `ARCH-001`, `CLIENT-001` | `TV-AF-001`, `013` | PASS | PARTIAL |
| 14 | New package boundaries allowed | `SPEC.md` Package layout | `ARCH-001` | `TV-AF-001` | PASS | PASS |
| 15 | No migration paths in this spec | `SPEC.md` Non-goals, Undefined | `ARCH-001` | N/A | PASS | PASS |
| 16 | Provider-agnostic delivery interfaces | `SPEC.md` Goals, OTP model, OTP semantics | `OTP-001`, `OTP-002` | `TV-AF-004`, `005` | PASS | PASS |

Intent coverage summary:

- Intent items covered in spec: `16 / 16`
- `SPEC MISSING`: `0`
- `SPEC CONFLICT`: `0`

# Requirement coverage summary

## Counts by spec bundle

| Spec bundle | PASS | PARTIAL | FAIL | UNVERIFIED |
| --- | ---: | ---: | ---: | ---: |
| `2026-03-21-new-a7m3k9q2-spec` | 11 | 5 | 3 | 0 |

## Verification summary

- `npm test --workspace @authfn/core`: failed in `authfn/core/tests/schema.test.ts` because the expectation omits shared OAuth tables and `two_factor_challenges`, while the implementation matches the newer spec shape.
- `npm test --workspace @authfn/client`: passed.
- `npm test --workspace @authfn/svelte`: passed.
- `python3 -m pytest /Users/serro/Documents/dev/n/superfunctions/authfn/python/tests`: passed.
- `npm run build --workspace @authfn/core`: passed.
- `npm run build --workspace @authfn/client`: passed.

# Requirement-by-requirement results

| ID | Status | Evidence | Verification | Notes |
| --- | --- | --- | --- | --- |
| `ARCH-001` | PARTIAL | `authfn/core/package.json`, `authfn/client/package.json`, `authfn/svelte/package.json`, `authfn/python/authfn.py` | TS builds pass; Python tests pass | Package split exists, but Python instance surface diverges from the specified `auth.router` contract and still exposes legacy API-key helpers/fallback. |
| `CORE-001` | PASS | `authfn/core/src/index.ts`, `authfn/core/src/http/router.ts`, `authfn/core/src/schema.ts` | core build passes; most core tests pass | TypeScript core uses shared HTTP/DB/Auth abstractions and does not invent a second router/DB layer. |
| `CORE-002` | PASS | `authfn/core/src/schema.ts`, `authfn/core/src/plugin-runner.ts`, `authfn/core/tests/schema.test.ts` | route determinism tests pass; one schema expectation is stale | Deterministic composition is implemented; the failing test is an outdated expected table list, not runtime nondeterminism. |
| `HTTP-001` | PASS | `authfn/core/src/http/router.ts`, plugin route files, `authfn/python/authfn/http.py` | client/core/python tests pass | All required routes exist; envelopes are canonical; CSRF and allowlisted redirect behavior are implemented. |
| `DATA-001` | FAIL | `authfn/core/src/schema.ts`, `authfn/core/src/plugins/social-oauth.ts`, `authfn/python/authfn/plugins/social_oauth.py` | static audit + tests | Python duplicates shared OAuth storage shapes and persists raw OAuth token JSON in `encrypted_payload`, violating shared-schema reuse and secret-at-rest requirements. |
| `SESS-001` | PASS | `authfn/core/src/core/cookies.ts`, `authfn/core/src/core/sessions.ts`, `authfn/python/authfn/http.py` | sessions/cookies tests pass in TS; Python sessions tests pass | Browser-session issuance, listing, revocation, cookie policy, and CSRF behavior are present. |
| `PASS-001` | PASS | `authfn/core/src/core/passwords.ts`, `authfn/core/src/plugins/email-password.ts`, `authfn/python/authfn/http.py` | TS password tests + client tests pass; Python password tests pass | Password sign-up/sign-in/reset flows exist and hashes are adaptive. |
| `OTP-001` | PASS | `authfn/core/src/core/verifications.ts`, `authfn/core/src/plugins/email-otp.ts`, `authfn/python/authfn/plugins/email_otp.py` | TS OTP tests pass; Python OTP tests pass | Required OTP purposes, hashed challenges, single-use semantics, and provider-agnostic delivery are implemented. |
| `OTP-002` | PARTIAL | `authfn/core/src/core/verifications.ts`, `authfn/python/authfn/plugins/email_otp.py` | TS/Python OTP tests pass but do not cover context propagation | Hooks exist and are fail-open/fail-closed in the right direction, but both runtimes pass empty hook context, which blocks request-aware throttling/region-aware customization. |
| `SOC-001` | PARTIAL | TS: `authfn/core/src/plugins/social-oauth.ts`; Python: `authfn/python/authfn/plugins/social_oauth.py` | TS social tests pass; Python social tests pass | TypeScript correctly reuses shared OAuth packages. Python reimplements the flow/token/state layer and therefore does not satisfy the shared-primitives requirement. |
| `SOC-002` | PASS | `authfn/core/src/plugins/social-oauth.ts`, `authfn/python/authfn/http.py`, `authfn/python/authfn/plugins/social_oauth.py` | TS social tests pass; Python social tests pass | JSON and redirect callback outcomes, allowlisted return targets, and callback hooks are present. |
| `API-001` | PASS | `authfn/core/src/core/api-keys.ts`, `authfn/core/src/plugins/api-keys.ts`, `authfn/python/authfn/plugins/api_keys.py` | TS API-key tests pass; Python API-key tests pass | Plugin flows hash secrets at rest, return secret once, list without disclosure, and revoke immediately. |
| `TFA-001` | PASS | `authfn/core/src/core/two-factor.ts`, `authfn/core/src/plugins/two-factor.ts`, `authfn/python/authfn/plugins/two_factor.py` | TS two-factor tests pass; Python two-factor tests pass | Enrollment/confirm/challenge/disable/recovery flows work and recovery codes are single-use. |
| `REGION-001` | PARTIAL | `authfn/core/src/plugins/multi-region.ts`, `authfn/core/src/plugins/social-oauth.ts`, `authfn/python/authfn/http.py`, `authfn/python/authfn/plugins/social_oauth.py` | TS multi-region tests pass; Python multi-region tests pass | Password-created users register region data, but social-created users bypass the multi-region post-user-create path in both runtimes. |
| `PLUG-001` | PARTIAL | TS: `authfn/core/src/plugin-runner.ts`; Python: `authfn/python/authfn/http.py` | TS hook-order behavior tested; Python tests do not verify plugin hooks | TypeScript honors plugin ordering/semantics. Python route execution special-cases plugin names and does not execute bundled plugins through a regular plugin/hook runtime. |
| `CLIENT-001` | PASS | `authfn/client/src/index.ts`, `authfn/client/src/http-client.ts`, `authfn/svelte/src/session-store.ts` | client and svelte tests pass | Typed browser client and thin Svelte adapter are present and aligned to authfn semantics. |
| `PY-001` | FAIL | `authfn/python/authfn/authfn.py`, `authfn/python/authfn/types.py`, `authfn/python/authfn/plugins/social_oauth.py`, `authfn/python/authfn/http.py` | Python tests pass, but static audit shows parity gaps | Python lacks full parity: no `auth.router` property, no general observability sink, incomplete canonical error surface, non-shared social OAuth implementation, and plugin/runtime drift. |
| `OAS-001` | PASS | `authfn/core/src/openapi.ts`, `authfn/python/authfn/http.py`, openapi tests | TS openapi tests pass; Python openapi tests pass | OpenAPI generation is wired through shared packages rather than bespoke generation. |
| `OBS-001` | FAIL | `authfn/core/src/http/envelopes.ts`, `authfn/core/src/core/observability.ts`, `authfn/python/authfn/types.py`, `authfn/python/authfn/plugins/email_otp.py` | static audit | TypeScript event/envelope request IDs are not stably linked when no `x-request-id` header is provided, and Python has no general structured observability sink for core auth flows. |

## Per-requirement notes

### `ARCH-001`

- TypeScript package boundaries match the spec and the legacy `ts-sdk` package has been demoted to `@authfn/legacy-ts-sdk` with only `legacy:*` scripts.
- Python does not expose the specified `auth.router` instance property: `AuthFn` stores `self.routes` and `get_routes()` instead of a `router` field, and `AuthFnProvider` still falls back to legacy `apiKeys`-table behavior (`authfn/python/authfn/authfn.py:40-108`, `131-157`).

### `CORE-001`

- `createAuthFn` wires `createAuthFnRouter`, `getSchema`, and an `@superfunctions/auth` provider without introducing a second router/database abstraction (`authfn/core/src/index.ts`).
- The core TypeScript build passes. The failing core test is a stale schema expectation, not a core-architecture regression.

### `CORE-002`

- `getSchema()` sorts field/index order and throws deterministic `AUTHFN_CONFLICT` errors for duplicate tables/column mappings (`authfn/core/src/schema.ts`).
- Route output is stable across runs (`authfn/core/tests/schema.test.ts:91-97`).

### `HTTP-001`

- All route groups required by `SPEC.md` exist in TypeScript and Python.
- Unsafe cookie-session routes enforce CSRF in both runtimes; redirect-mode social callbacks enforce allowlisted return targets.

### `DATA-001`

- TypeScript schema composition includes the required core/plugin tables plus shared OAuth tables via `getOAuthStorageTableDefinitions()`.
- Python violates two parts of the requirement:
  - it defines/stores OAuth state/token persistence itself instead of consuming a shared storage contract (`authfn/python/authfn/plugins/social_oauth.py:61-123`, `603+`);
  - it stores raw token JSON inside `encrypted_payload` (`authfn/python/authfn/plugins/social_oauth.py:511-529`).

### `SESS-001`

- Default cookie policy is `Secure` + `SameSite=Lax`, session/CSRF cookies are issued and cleared correctly, listing is deterministic, and revocation is immediate.

### `PASS-001`

- Password hashing uses adaptive algorithms (`scrypt` in TypeScript; `scrypt`/PBKDF2 fallback in Python).
- Password reset integration is OTP-backed in both runtimes.

### `OTP-001`

- OTP send/verify/reset flows are implemented with hashed codes, expiration, single-use semantics, and purpose matching.

### `OTP-002`

- The documented hooks exist, but their context is incomplete:
  - TypeScript invokes `beforeChallengeSend` and `afterChallengeSend` with `{}` instead of request/runtime/config context (`authfn/core/src/core/verifications.ts:75-79`, `124-131`, `352-363`).
  - Python does the same with an empty `AuthFnHookContext()` (`authfn/python/authfn/plugins/email_otp.py:285-313`).
- This prevents the hook contract from cleanly supporting request-aware throttling and region-aware OTP behavior.

### `SOC-001`

- TypeScript is compliant: it uses shared OAuth flow/state/token/provider-policy packages and only owns local-account/session behavior.
- Python is not: it manually stores/consumes OAuth state, manually exchanges tokens, and manually stores tokens instead of delegating to the shared OAuth flow/token-vault stack.

### `SOC-002`

- Both runtimes support JSON and redirect completion modes and enforce allowlisted redirect targets.
- No spec failure found here, but the Python implementation is still constrained by the broader `PY-001`/`SOC-001` parity issues.

### `API-001`

- API-key plugin behavior matches the requirement in both runtimes.
- The audit still flags a cross-cutting limits gap: neither runtime enforces the specified default maximum API-key name length of 128 UTF-8 bytes.

### `TFA-001`

- Functional behavior is present and tested.
- Cross-cutting limit drift remains: both runtimes default recovery-code batch size to `8`, not the specified `10`.

### `REGION-001`

- Lookup/runtime resolution and mismatch detection are implemented.
- Post-user-create registration is incomplete for social-created users:
  - TypeScript social user creation calls only `config.hooks?.beforeUserCreate`/`afterUserCreate`, bypassing composed plugin hooks including the multi-region plugin (`authfn/core/src/plugins/social-oauth.ts:528-572`).
  - Python only registers multi-region data from the password sign-up helper (`authfn/python/authfn/http.py:1000-1040`, `1182-1192`), while social OAuth creates users directly (`authfn/python/authfn/plugins/social_oauth.py:412-463`).

### `PLUG-001`

- TypeScript plugin ordering and fail-open/fail-closed semantics are correct.
- Python does not execute plugins as first-class runtime objects:
  - route assembly special-cases known plugin names instead of calling the plugin route factory/runtime uniformly (`authfn/python/authfn/http.py:145-155`);
  - bundled plugin factories generally set no runtime hooks, and `plugin.hooks` is not part of route execution.

### `CLIENT-001`

- The browser client and Svelte wrappers satisfy the spec and their tests pass.

### `PY-001`

- Python passes its current tests, but the parity contract is still broken because:
  - `AuthFn` lacks the specified `router` property;
  - `AuthFnConfig` lacks a general observability sink;
  - the canonical error surface is incomplete (`AUTHFN_EMAIL_NOT_VERIFIED` and `AUTHFN_RATE_LIMITED` are missing);
  - social OAuth does not reuse the shared flow/token-vault implementation;
  - bundled plugin execution semantics differ materially from TypeScript.

### `OAS-001`

- OpenAPI generation is shared-package based in TypeScript and Python and is covered by passing tests.

### `OBS-001`

- TypeScript emits structured auth events, but request IDs are not reliably request-linked:
  - `resolveRequestId()` generates a fresh random `req_*` whenever the request lacks `x-request-id` (`authfn/core/src/http/envelopes.ts:4-11`);
  - `eventRequestId()` simply calls `resolveRequestId()` again (`authfn/core/src/core/observability.ts:18-24`).
- Python lacks a general auth observability configuration entirely (`authfn/python/authfn/types.py:144-156`), and only the OTP delivery provider has a private `emit` hook (`authfn/python/authfn/plugins/email_otp.py:275-283`).

# Spec conflicts / spec gaps

## Spec conflicts

No direct conflicts were found across `INTENT_AUDIT.md`, `SPEC.md`, `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`, or `phases/PHASE_00.md` through `PHASE_08.md`.

## Spec gaps / underspecified areas

1. `SPEC.md` lists `AUTHFN_EMAIL_NOT_VERIFIED` and `AUTHFN_RATE_LIMITED` as required error codes, but the bundle provides no dedicated requirement acceptance criteria or test vectors for the concrete flows that should emit them. This makes the trigger conditions under-specified, although the codes are still mandatory because they are explicitly listed.
2. The bundle's phase DoD says no phase is complete unless verification passes, but it does not define how verification assets should be updated when the companion shared OAuth/table spec expands the correct schema surface. The current failing `authfn/core/tests/schema.test.ts` demonstrates this gap: the implementation matches the newer spec shape, but the test still enforces the older table list.

# Cross-cutting audits (security/determinism/limits/errors/compat)

## Security / authz / validation boundaries

- TypeScript session cookies are HTTP-only and secure by default; CSRF is enforced on unsafe cookie-session routes.
- TypeScript session tokens and API-key secrets are hashed at rest; 2FA secrets are encrypted through `AesGcmTokenCipher`.
- Social redirect targets are allowlisted before redirect completion.
- Sensitive event fields are redacted in TypeScript observability payloads.
- Critical failure:
  - Python social OAuth stores raw token JSON in `oauth_tokens.encrypted_payload`, so OAuth access/refresh/id tokens are not protected at rest as the spec requires.

## Determinism invariants

- Schema field/index order is normalized deterministically in TypeScript and Python.
- Route order is deterministic for a fixed plugin order in TypeScript; Python route assembly is also deterministic, albeit special-cased.
- Failure:
  - Request IDs are not deterministic per request when no incoming `x-request-id` header exists, so the same request can produce different IDs in events versus envelopes.

## Limits / caps

- Pass:
  - session max age defaults to 7 days;
  - OTP lifetime defaults to 10 minutes;
  - OTP max attempts default to 5;
  - allowed providers are limited to `google`, `apple`, `github`.
- Fail:
  - recovery-code default count is `8` in both runtimes, not `10` (`authfn/core/src/core/two-factor.ts:27-33`; `authfn/python/authfn/plugins/two_factor.py:101`);
  - API-key name-length capping is not enforced in either runtime (`authfn/core/src/core/api-keys.ts`, `authfn/python/authfn/plugins/api_keys.py:56-88`).

## Error handling + canonical envelopes

- Pass:
  - success/error envelopes are canonical in both runtimes.
- Fail / partial:
  - `AUTHFN_EMAIL_NOT_VERIFIED` is specified but not implemented as a runtime error in either runtime;
  - `AUTHFN_RATE_LIMITED` is specified but not implemented as a runtime error in either runtime;
  - TypeScript maps `PROVIDER_RATE_LIMITED` to `AUTHFN_INTERNAL_ERROR` instead of `AUTHFN_RATE_LIMITED` (`authfn/core/src/core/errors.ts:349-365`, `414-422`);
  - Python uses extra non-spec legacy codes/surfaces such as `AUTHFN_UNAUTHENTICATED`/`AUTHFN_CONFIG_INVALID` and omits the full required surface.

## Compatibility / versioning / migrations

- The bundle's "no migration paths" intent is respected; I found no migration/cutover implementation in the audited surface.
- The legacy `authfn/ts-sdk` package has been effectively demoted to a private legacy workspace with only `legacy:*` scripts.
- Remaining compatibility drift:
  - Python still exposes legacy API-key-oriented helpers and a legacy `apiKeys` authentication fallback at the top level (`authfn/python/authfn/authfn.py:48-108`, `159-220`);
  - Python package metadata still carries some old single-purpose framing outside the new multi-package platform contract.

# Recommendations

1. Replace the Python social OAuth implementation with the shared Python OAuth flow/state/token-vault stack, and encrypt stored token payloads at rest. This fixes the most serious `DATA-001`/`SOC-001`/`PY-001` violation.
2. Introduce a stable per-request request ID in both runtimes and thread that same value through envelopes, redirects, and emitted events. Add request-ID equality assertions to tests, not just `req_*` shape checks.
3. Route OTP hook execution through the composed hook runtime with full `AuthFnHookContext` (`config`, `request`, `runtime`, `actorId`, `pluginName` where applicable) in both runtimes so `OTP-002` can actually support throttling and region-aware behavior.
4. Ensure social-user creation uses the same composed user-create hook pipeline as password sign-up, including multi-region post-user-create registration/directory sync for new social accounts.
5. Complete the canonical error/limits surface:
   - implement `AUTHFN_EMAIL_NOT_VERIFIED` and `AUTHFN_RATE_LIMITED`;
   - map provider rate-limit failures to `AUTHFN_RATE_LIMITED`;
   - change recovery-code default count to `10`;
   - enforce the 128-byte API-key name cap.
6. Update `authfn/core/tests/schema.test.ts` to match the current shared-OAuth/2FA schema contract so the phase verification gate passes again and future drift is easier to detect.

# Appendix: commands run + environment details

## Commands run

```text
pwd
ls -la /Users/serro/.codex/skills/audit
sed -n ... SKILL.md
find /Users/serro/Documents/dev/n/superfunctions/authfn/.conduct ...
sed -n ... tracker.csv
sed -n ... SPEC.md
sed -n ... REQUIREMENTS.md
sed -n ... TEST_VECTORS.md
sed -n ... PLAN.md
sed -n ... phases/PHASE_00.md ... PHASE_08.md
rg --files /Users/serro/Documents/dev/n/superfunctions/authfn/...
rg -n ... /Users/serro/Documents/dev/n/superfunctions/authfn/...
git -C /Users/serro/Documents/dev/n/superfunctions status --short --branch
git -C /Users/serro/Documents/dev/n/superfunctions rev-parse --abbrev-ref HEAD
git -C /Users/serro/Documents/dev/n/superfunctions rev-parse HEAD
npm test --workspace @authfn/core
npm test --workspace @authfn/client
npm test --workspace @authfn/svelte
npm run build --workspace @authfn/core
npm run build --workspace @authfn/client
python3 -m pytest /Users/serro/Documents/dev/n/superfunctions/authfn/python/tests
date -u
uname -srm
```

## Environment details

- Workspace: `/Users/serro/Documents/dev/n/superfunctions/authfn`
- Repo root: `/Users/serro/Documents/dev/n/superfunctions`
- Branch: `heads/next`
- Commit: `b69090aaa83f0515924aa9b11df3b1fcd4de3a1a`
- Shell: `/bin/zsh`
- OS: `Darwin 25.3.0 arm64`
- Test/build results:
  - `@authfn/core` tests: failed due stale schema expectation
  - `@authfn/client` tests: passed
  - `@authfn/svelte` tests: passed
  - Python tests: passed
  - `@authfn/core` build: passed
  - `@authfn/client` build: passed
