# Phase Completion Report

- Timestamp: `2026-03-22T10:04:53Z`
- Agent: `unknown-agent`
- Model: `Codex (GPT-5)`
- Launcher: `Codex Desktop`
- Workspace: `/Users/serro/Documents/dev/n/superfunctions`
- OS/Shell: `Darwin ArBook.local 25.3.0 arm64` / `/bin/zsh`
- Git branch: `heads/next`
- Git commit: `b69090aaa83f0515924aa9b11df3b1fcd4de3a1a`
- Git dirty status: `dirty`

## Phase

`PHASE_06`

## Status

`PASS`

## Requirements Summary

- Requirements delivered:
  - `REGION-001`
  - `PLUG-001`

### `REGION-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - `POST /auth/regions/lookup` now returns deterministic routing guidance from `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/multi-region.ts` and `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/regions.ts`, including `identifier`, `regionId`, `authority`, `continueLocally`, and `redirectTo`.
  - Runtime resolution now varies issuer/base URL/cookie policy/provider config by request through `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/runtime.ts`, which merges the base runtime resolver with region-aware overrides from `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/regions.ts`.
  - Region mismatch is surfaced as the canonical `AUTHFN_REGION_MISMATCH` error with redirect metadata from `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/errors.ts`, triggered generically through the multi-region plugin’s `beforeSessionIssue` hook in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/multi-region.ts`.
  - Post-user-create directory registration is supported by the bundled plugin’s `afterUserCreate` hook and `registerUserRegion(...)` in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/regions.ts`, which persists `region_profiles` locally and optionally calls an external directory registration callback.
  - Region-aware cookie and OAuth overrides are visible through `GET /auth/runtime`, which returns the resolved runtime authority, cookie names/policy, and sanitized provider overrides without leaking secrets.
- Test status:
  - `npm test --workspace @authfn/core -- multi-region` -> `PASS` (`/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/__tests__/multi-region.test.ts`, `2/2` tests passed)
  - `python3 -m pytest authfn/python/tests/test_multi_region.py` -> `PASS` (`/Users/serro/Documents/dev/n/superfunctions/authfn/python/tests/test_multi_region.py`, `2/2` tests passed)
  - Manual flow (`node --input-type=module <<'EOF' ... EOF`) -> `PASS`
    - `signUpStatus = 200`
    - `signUpRegionId = "eu-west-1"`
    - `lookupStatus = 200`
    - `mismatchStatus = 409`
    - `mismatchBody.error.code = "AUTHFN_REGION_MISMATCH"`
    - `mismatchBody.error.details.redirectTo = "https://eu.account.example.com"`
    - session cookies issued on the correct authority were `__Secure-authfn-eu.session` and `authfn-eu.csrf`

### `PLUG-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - Built-in multi-region capability is now a regular bundled plugin implemented in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/multi-region.ts`, created and registered through the same `AuthFnPlugin` interface used by custom plugins.
  - `before*` hook failures abort operations with structured errors:
    - `beforeUserCreate` failures still return `AUTHFN_PLUGIN_ABORTED`, now preserving structured `AuthFnError` subclasses where needed via wrapper updates in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/passwords.ts`, `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/sessions.ts`, `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/verifications.ts`, and `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/social-oauth.ts`.
    - The phase test proves custom plugin failure ordering and abort behavior.
  - `after*` hook failures remain fail-open and do not roll back committed state, proven by the `afterUserCreate` ordering/fail-open scenario in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/__tests__/multi-region.test.ts`, where the user and region profile remain committed even when a later audit plugin throws.
  - Plugin execution order follows registration order, proven by the explicit hook order assertions in the same test file:
    - `customBefore` before `abortingPlugin`
    - `multiRegion` before `afterAudit`
- Test status:
  - `npm test --workspace @authfn/core -- multi-region` -> `PASS`
    - hook-order and fail-closed/fail-open coverage is in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/__tests__/multi-region.test.ts`

## Deliverables Summary

- Files added:
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/multi-region.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/runtime.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/regions.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/__tests__/multi-region.test.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/plugins/multi_region.py`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/tests/test_multi_region.py`
- Files modified:
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/cookies.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/errors.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/passwords.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/sessions.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/verifications.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugin-runner.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugin-types.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/email-password.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/social-oauth.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/types.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/__init__.py`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/plugins/__init__.py`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/types.py`
- Files deleted/replaced:
  - None.

## Verification Summary

- Phase verification steps executed:
  - `npm test --workspace @authfn/core -- multi-region` -> `PASS`
  - `python3 -m pytest authfn/python/tests/test_multi_region.py` -> `PASS`
  - Manual flow (`node --input-type=module <<'EOF' ... EOF`) -> `PASS`
    - lookup by email on `us.account.example.com` returned deterministic routing guidance for `eu-west-1`
    - password sign-in on the wrong authority returned `AUTHFN_REGION_MISMATCH`
    - redirect metadata pointed at `https://eu.account.example.com`
  - Expected outcome confirmed:
    - lookup is deterministic
    - mismatch surfaces `AUTHFN_REGION_MISMATCH` with redirect details
- Additional verification executed:
  - `npm run typecheck --workspace @authfn/core` -> `PASS`
  - `npm run build --workspace @authfn/core` -> `PASS`
  - `python3 -m pytest authfn/python/tests/test_schema.py` -> `PASS`
  - `rg -n "TODO|FIXME" ...` across PHASE_06 deliverables and related hook/runtime files -> no matches

## Test Execution Results

- `vitest run multi-region`
  - Test files: `1 passed`
  - Tests: `2 passed`
- `pytest authfn/python/tests/test_multi_region.py`
  - Tests: `2 passed`
- `pytest authfn/python/tests/test_schema.py`
  - Tests: `3 passed`
  - Warnings: existing Pydantic deprecation warnings from shared Python models; no phase-specific failures
- Manual flow summary:
  - `lookupBody.data.regionId = "eu-west-1"`
  - `lookupBody.data.authority = "https://eu.account.example.com"`
  - `lookupBody.data.continueLocally = false`
  - `mismatchBody.error.code = "AUTHFN_REGION_MISMATCH"`
  - `mismatchBody.error.details.redirectTo = "https://eu.account.example.com"`
  - `sessionCookieNames = ["__Secure-authfn-eu.session", "authfn-eu.csrf"]`

## Notes

- Region lookup payload now contains the minimum routing fields needed by the client:
  - `identifier`
  - `userId` when available
  - `regionId`
  - `authority`
  - optional `domain`
  - `continueLocally`
  - optional `redirectTo`
- The runtime resolver interface now has two layers:
  - the base `config.runtime.resolve(request)` contract
  - the multi-region overlay in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/runtime.ts`, which merges region host mapping into `issuer`, `baseUrl`, `regionId`, `cookie`, and `oauth`
- Host/cookie/provider override behavior now works as follows:
  - host -> region match comes from `regions[].hosts`, `authority`, or `domain`
  - region override can change cookie prefix/domain/sameSite
  - region override can change per-provider OAuth runtime config such as `clientId` and `scopes`
  - `GET /auth/runtime` exposes the resolved override state without exposing provider secrets
- The multi-region plugin performs local profile registration in `region_profiles` and can optionally mirror registration to an external directory via `directory.registerUser(...)`.
- Region mismatch is enforced generically in `beforeSessionIssue`, so password, OTP, social callback, and 2FA-completed sign-in flows all inherit the same check before session completion.
- Hook wrappers now preserve structured `AuthFnError` subclasses instead of always rewrapping them as `AUTHFN_PLUGIN_ABORTED`, which is what allows `AUTHFN_REGION_MISMATCH` to surface correctly from a plugin hook.
- The Python plugin/service mirrors the same route names, schema table, runtime override logic, lookup semantics, and region mismatch error codes as the TypeScript implementation.
- The phase file asked for `python -m pytest`, but this environment only has `python3` on `PATH`, so `python3 -m pytest` was used for successful verification.

## Ready For Next Phase?

`Yes` — multi-region lookup, request-aware runtime resolution, mismatch handling, directory registration hooks, and Python parity are now in place for the upcoming client/OpenAPI phase.

## Blockers

- None.
