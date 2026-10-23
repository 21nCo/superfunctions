# Phase Completion Report

- Timestamp: `2026-03-22T09:30:20Z`
- Agent: `unknown-agent`
- Model: `Codex (GPT-5)`
- Launcher: `Codex Desktop`
- Workspace: `/Users/serro/Documents/dev/n/superfunctions`
- OS/Shell: `Darwin ArBook.local 25.3.0 arm64` / `/bin/zsh`
- Git branch: `heads/next`
- Git commit: `b69090aaa83f0515924aa9b11df3b1fcd4de3a1a`
- Git dirty status: `dirty`

## Phase

`PHASE_05`

## Status

`PASS`

## Requirements Summary

- Requirements delivered:
  - `API-001`
  - `TFA-001`

### `API-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - API key secret is returned exactly once at creation by `POST /auth/api-keys` in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/api-keys.ts`, which returns `{ keyId, secret, secretReturnedOnce: true }` and never persists plaintext secret material.
  - Stored secret material is hashed in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/api-keys.ts` and `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/plugins/api_keys.py`, where secret lookup is done through hashed secret comparison and list responses are sanitized.
  - Revoked keys stop authenticating immediately through the shared auth provider path in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/sessions.ts` and `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/api-keys.ts`, which now raises `AUTHFN_API_KEY_REVOKED` for revoked bearer keys.
  - API keys are listable without secret disclosure via `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/api-keys.ts` and `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/plugins/api_keys.py`; both return sanitized records without plaintext secret values.
  - Session/auth-provider semantics are now explicit: successful bearer API-key auth returns a session with `type: "api-key"` and `methods: ["api-key"]`, proven in both TypeScript and Python tests.
- Test status:
  - `npm test --workspace @authfn/core -- api-keys two-factor` -> `PASS` (`/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/__tests__/api-keys.test.ts`, `1/1` API-key test passed)
  - `python3 -m pytest authfn/python/tests/test_api_keys.py authfn/python/tests/test_two_factor.py authfn/python/tests/test_schema.py` -> `PASS` (`/Users/serro/Documents/dev/n/superfunctions/authfn/python/tests/test_api_keys.py`, `2/2` API-key tests passed)
  - Manual flow (`python3 <<'EOF' ... EOF`) -> `PASS`
    - `apiKeyReturnedOnce = True`
    - `apiKeyStoredHashed = True`
    - `apiKeyListLeaksSecret = False`
    - `apiKeyAuthMethods = ["api-key"]`
    - `revokedCode = "AUTHFN_API_KEY_REVOKED"`

### `TFA-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - Enrolling 2FA produces a secret and recovery codes in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/two-factor.ts`, `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/two-factor.ts`, and `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/plugins/two_factor.py`. Secrets are encrypted at rest and recovery codes are stored hashed.
  - Confirming 2FA requires a valid TOTP code. Invalid confirmation and challenge codes raise `AUTHFN_2FA_INVALID_CODE` from `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/errors.ts` and `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/types.py`.
  - When 2FA is enabled, primary sign-in now produces `AUTHFN_2FA_REQUIRED` instead of a completed session until the challenge is satisfied. This gating is wired into password, OTP, and social sign-in flows through `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/email-password.ts`, `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/email-otp.ts`, and `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/social-oauth.ts`.
  - Recovery codes are single-use through the hashed recovery-code store and challenge-consumption logic in `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/two-factor.ts` and `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/plugins/two_factor.py`. Reuse yields `AUTHFN_2FA_INVALID_CODE`.
  - Session method state is now explicit:
    - a gated primary sign-in does not issue cookies yet,
    - a completed 2FA challenge issues a session with `methods: ["password", "two-factor"]`,
    - disabling 2FA returns primary sign-in to `methods: ["password"]`.
- Test status:
  - `npm test --workspace @authfn/core -- api-keys two-factor` -> `PASS` (`/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/__tests__/two-factor.test.ts`, `2/2` tests passed)
  - `python3 -m pytest authfn/python/tests/test_api_keys.py authfn/python/tests/test_two_factor.py authfn/python/tests/test_schema.py` -> `PASS` (`/Users/serro/Documents/dev/n/superfunctions/authfn/python/tests/test_two_factor.py`, `2/2` tests passed)
  - Manual flow (`python3 <<'EOF' ... EOF`) -> `PASS`
    - `recoveryCodesIssued = 3`
    - `sessionMethodsAfterChallenge = ["password", "two-factor"]`
    - `usedRecoveryCode = True`
    - `recoveryReuseCode = "AUTHFN_2FA_INVALID_CODE"`

## Deliverables Summary

- Files added:
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/api-keys.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/two-factor.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/api-keys.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/two-factor.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/__tests__/api-keys.test.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/__tests__/two-factor.test.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/plugins/api_keys.py`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/plugins/two_factor.py`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/tests/test_api_keys.py`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/tests/test_two_factor.py`
- Files modified:
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/errors.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/sessions.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/index.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugin-types.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/email-password.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/email-otp.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/social-oauth.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/core/src/types.ts`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/__init__.py`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/plugins/__init__.py`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/types.py`
  - `/Users/serro/Documents/dev/n/superfunctions/authfn/python/tests/test_schema.py`
- Files deleted/replaced:
  - None.

## Verification Summary

- Phase verification steps executed:
  - `npm test --workspace @authfn/core -- api-keys two-factor` -> `PASS`
  - `python3 -m pytest authfn/python/tests/test_api_keys.py authfn/python/tests/test_two_factor.py` -> `PASS`
  - Manual flow (`python3 <<'EOF' ... EOF`) -> `PASS`
    - create key -> authenticated with `methods = ["api-key"]`
    - revoke key -> subsequent auth failed with `AUTHFN_API_KEY_REVOKED`
    - enroll + confirm 2FA -> challenge created
    - satisfy challenge -> session methods `["password", "two-factor"]`
    - use recovery code -> success once
    - reuse recovery code -> `AUTHFN_2FA_INVALID_CODE`
  - Expected outcome confirmed:
    - revoked keys fail immediately
    - 2FA challenge gates session completion
- Additional verification executed:
  - `npm run build --workspace @authfn/core` -> `PASS`
  - `python3 -m pytest authfn/python/tests/test_api_keys.py authfn/python/tests/test_two_factor.py authfn/python/tests/test_schema.py` -> `PASS`
  - `rg -n "TODO|FIXME" ...` across PHASE_05 deliverables and related parity/schema tests -> no matches

## Test Execution Results

- `vitest run api-keys two-factor`
  - Test files: `2 passed`
  - Tests: `3 passed`
- `pytest authfn/python/tests/test_api_keys.py authfn/python/tests/test_two_factor.py`
  - Tests: `4 passed`
- `pytest authfn/python/tests/test_api_keys.py authfn/python/tests/test_two_factor.py authfn/python/tests/test_schema.py`
  - Tests: `7 passed`
  - Warnings: existing Pydantic deprecation warnings from shared Python models; no phase-specific failures
- Manual flow summary:
  - `apiKeyReturnedOnce = True`
  - `apiKeyStoredHashed = True`
  - `apiKeyListLeaksSecret = False`
  - `apiKeyAuthMethods = ["api-key"]`
  - `revokedCode = "AUTHFN_API_KEY_REVOKED"`
  - `recoveryCodesIssued = 3`
  - `sessionMethodsAfterChallenge = ["password", "two-factor"]`
  - `usedRecoveryCode = True`
  - `recoveryReuseCode = "AUTHFN_2FA_INVALID_CODE"`

## Notes

- API-key secret handling now follows the phase stop condition exactly: plaintext secret is only returned from the create response, while all persisted secret material is hashed and all list/auth flows use the hash.
- 2FA recovery-code semantics now follow the phase stop condition exactly: recovery codes are generated at enrollment, stored hashed, accepted once, and immediately invalid on reuse.
- Session method-state representation now follows the phase stop condition exactly:
  - API-key auth -> `["api-key"]`
  - primary sign-in + satisfied 2FA -> `["password", "two-factor"]`
  - post-disable password sign-in -> `["password"]`
- The TypeScript 2FA core keeps plugin config in a `WeakMap` keyed by the plugin instance so primary sign-in plugins can discover 2FA configuration without hard-coding direct dependencies.
- The Python parity fix in this phase was to allow confirmation against an existing unconfirmed enrollment; requiring a confirmed enrollment there made confirmation impossible and was corrected in `/Users/serro/Documents/dev/n/superfunctions/authfn/python/authfn/plugins/two_factor.py`.
- `/Users/serro/Documents/dev/n/superfunctions/authfn/python/tests/test_schema.py` was updated so the shared schema contract now includes `two_factor_challenges`, matching the plugin’s real schema contribution.
- The phase file asked for `python -m pytest`, but this environment only has `python3` on `PATH`, so `python3 -m pytest` was used for successful verification.
- An attempted direct Node-based manual runtime probe was not suitable because it crossed into Vitest-only helper state through test-only imports; the required manual verification was completed instead through the real Python service layer with explicit outcome checks.

## Ready For Next Phase?

`Yes` — bundled API keys, 2FA enrollment/challenge/recovery flows, auth-method session state, and Python parity are now all in place for the next authfn phase.

## Blockers

- None.
