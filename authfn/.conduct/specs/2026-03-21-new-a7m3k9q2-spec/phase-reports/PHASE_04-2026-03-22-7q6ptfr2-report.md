# Phase Completion Report

- Timestamp: `2026-03-22T09:05:25Z`
- Agent: `unknown-agent`
- Model: `Codex (GPT-5)`
- Launcher: `Codex Desktop`
- Workspace: `/Users/serro/Documents/dev/n/superfunctions`
- OS + Shell: `Darwin ArBook.local 25.3.0 Darwin Kernel Version 25.3.0: Wed Jan 28 20:51:28 PST 2026; root:xnu-12377.91.3~2/RELEASE_ARM64_T6041 arm64` + `zsh`
- Git branch: `heads/next`
- Git commit: `b69090aaa83f0515924aa9b11df3b1fcd4de3a1a`
- Git dirty: `yes`
- Phase: `PHASE_04`
- Status: `PASS`

## Requirements Summary

- Requirements delivered: `SOC-001`, `SOC-002`

### SOC-001

- Status: `PASS`
- Acceptance criteria evidence:
- Start flow returns a validated authorization URL:
  - `npm test --workspace @authfn/core -- social` passed `src/__tests__/social-google.test.ts`, `src/__tests__/social-apple.test.ts`, and `src/__tests__/social-github.test.ts`.
  - `python3 -m pytest authfn/python/tests/test_social_oauth.py` passed `test_social_oauth_plugin_schema_and_routes` and provider start-flow coverage in `test_google_start_callback_replay_and_redirect_hook`, `test_apple_runtime_secret_resolution_and_missing_claims`, and `test_github_links_verified_user_json_mode_and_sanitizes_failures`.
- Callback flow verifies state and provider configuration via shared packages:
  - TypeScript already used the shared OAuth stack in `authfn/core/src/plugins/social-oauth.ts`.
  - Python plugin now normalizes runtime config into `AuthFnRuntimeResolution`, uses shared `consume_state_or_throw`, `assert_callback_state_matches`, `OAuthSecretResolverContext`, `normalize_oauth_error_body`, and `secret_resolution_failed_error` in `authfn/python/authfn/plugins/social_oauth.py`.
  - Manual fixture run confirmed Apple runtime client secret resolution and Google replay handling.
- Successful callback links a local OAuth account and issues a session:
  - TypeScript evidence: `src/__tests__/social-google.test.ts` verifies linked `oauth_accounts` record and callback cookie issuance; `src/__tests__/social-github.test.ts` verifies JSON completion with session methods `['oauth-github']`.
  - Python evidence: `authfn/python/tests/test_social_oauth.py` verifies local `oauth_accounts` and `oauth_tokens` persistence for Google, Apple, and GitHub callback success.
- Unsupported providers are rejected with canonical errors:
  - `python3 -m pytest authfn/python/tests/test_social_oauth.py` passed `test_disallowed_redirect_and_unsupported_provider_raise_canonical_errors`, asserting `AUTHFN_OAUTH_PROVIDER_UNSUPPORTED`.
- Test status:
  - `authfn/core/src/__tests__/social-google.test.ts`: passed
  - `authfn/core/src/__tests__/social-apple.test.ts`: passed
  - `authfn/core/src/__tests__/social-github.test.ts`: passed
  - `authfn/python/tests/test_social_oauth.py`: `5 passed`

### SOC-002

- Status: `PASS`
- Acceptance criteria evidence:
- Callback completion supports JSON and redirect outcomes:
  - `src/__tests__/social-google.test.ts` and `src/__tests__/social-apple.test.ts` passed redirect completion coverage.
  - `src/__tests__/social-github.test.ts` passed JSON completion coverage.
  - `authfn/python/tests/test_social_oauth.py` passed redirect coverage for Google and Apple plus JSON coverage for GitHub.
- Redirect targets are allowlisted:
  - `src/__tests__/social-google.test.ts` passed disallowed `returnTo` validation with `AUTHFN_REDIRECT_URI_DISALLOWED`.
  - `authfn/python/tests/test_social_oauth.py` passed `test_disallowed_redirect_and_unsupported_provider_raise_canonical_errors`.
  - Manual fixture run returned `AUTHFN_REDIRECT_URI_DISALLOWED` for `https://evil.example.com/callback`.
- Plugin hooks can transform final redirect decisions:
  - `src/__tests__/social-google.test.ts` passed `afterOAuthCallback` redirect mutation.
  - `authfn/python/tests/test_social_oauth.py` passed `test_google_start_callback_replay_and_redirect_hook` after runtime hook-context coercion was fixed.
- State replay or redirect mismatch produces canonical errors:
  - `src/__tests__/social-google.test.ts` passed replay handling with `AUTHFN_OAUTH_STATE_REPLAYED`.
  - `authfn/python/tests/test_social_oauth.py` passed replay handling with `AUTHFN_OAUTH_STATE_REPLAYED`.
- Test status:
  - `authfn/core/src/__tests__/social-google.test.ts`: passed
  - `authfn/client/src/__tests__/client-social.test.ts`: passed
  - `authfn/python/tests/test_social_oauth.py`: `5 passed`

## Deliverables Summary

- Files changed/added:
- `authfn/python/authfn/plugins/social_oauth.py`
- `authfn/python/tests/test_social_oauth.py`
- `authfn/python/authfn/__init__.py`
- `authfn/python/authfn/plugins/__init__.py`
- `authfn/python/tests/test_schema.py`
- Files deleted/modified:
- No files deleted.

## Verification Summary

- Phase verification steps executed:
- `npm test --workspace @authfn/core -- social` -> PASS
- `python3 -m pytest authfn/python/tests/test_social_oauth.py` -> PASS
- Manual fixture flows for Google, Apple, GitHub start/callback -> PASS
- Expected outcomes observed:
- Google callback -> `303` redirect to `https://app.example.com/post-auth`
- Google replay -> `AUTHFN_OAUTH_STATE_REPLAYED`
- Apple callback -> `303` redirect to `https://app.example.com/apple-post-auth`
- Apple runtime secret resolution -> generated client secret was posted to the token endpoint
- GitHub callback -> `200` JSON `{ linked: true, provider: "github" }`
- Disallowed return URL -> `AUTHFN_REDIRECT_URI_DISALLOWED`
- Additional supporting verification:
- `npm test --workspace @authfn/client -- client-social` -> PASS
- `python3 -m pytest authfn/python/tests/test_schema.py` -> PASS
- Test execution results:
- `@authfn/core` social suite: `3 files`, `6 tests` passed
- `@authfn/client` social suite: `1 file`, `1 test` passed
- Python social suite: `5 tests` passed
- Python schema suite: `3 tests` passed

## Notes

- Provider runtime config contract now works in Python for both default and request-resolved paths because `SocialOAuthService` coerces runtime values into `AuthFnRuntimeResolution` before invoking hooks.
- Local linking rules are: existing provider account wins, otherwise verified-email linking is allowed only when `link_by_verified_email` is enabled and the existing local user is already verified; otherwise a conflicting email raises a validation failure.
- Callback completion modes are `redirect` and `json`; redirect mode revalidates the final target after hook mutation.
- Python `afterOAuthCallback` is now truly fail-open and still allows in-place redirect mutation, matching the TypeScript semantics required by `SOC-002`.
- `authfn/python/tests/test_schema.py` was updated because the social plugin now contributes the shared OAuth state and token tables in addition to `oauth_accounts`.
- This phase ran against already-built shared OAuth package artifacts; no additional shared-package code changes were required during PHASE_04.
- The phase file asked for `python -m pytest authfn/python/tests/test_social_oauth.py`, but this environment only has `python3` on `PATH`, so `python3 -m pytest ...` was used instead.
- No new TODOs or deferred work were introduced.

## Ready For Next Phase?

- Yes. Social OAuth coverage for Google, Apple, and GitHub is implemented and verified across TypeScript and Python, with canonical redirect/replay behavior and hook semantics in place.

## Blockers

- None.
