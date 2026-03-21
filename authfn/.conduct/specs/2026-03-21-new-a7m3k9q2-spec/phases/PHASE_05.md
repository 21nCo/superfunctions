# Phase goal

Implement the API key and 2FA bundled plugins.

# In scope / Out of scope

- In scope: API key management/authentication, 2FA enrollment/challenge/recovery, session method state
- Out of scope: multi-region routing

# Deliverables

- `authfn/core/src/plugins/api-keys.ts`
- `authfn/core/src/plugins/two-factor.ts`
- `authfn/core/src/core/api-keys.ts`
- `authfn/core/src/core/two-factor.ts`
- `authfn/core/src/__tests__/api-keys.test.ts`
- `authfn/core/src/__tests__/two-factor.test.ts`
- `authfn/python/authfn/plugins/api_keys.py`
- `authfn/python/authfn/plugins/two_factor.py`
- `authfn/python/tests/test_api_keys.py`
- `authfn/python/tests/test_two_factor.py`

# Requirements covered

- `API-001`
- `TFA-001`

# Implementation tasks

1. Move current API-key logic into the plugin architecture and hash secrets at rest.
2. Implement TOTP enrollment, confirmation, challenge, disable, and recovery code storage.
3. Extend session/auth provider semantics to include satisfied auth methods.
4. Mirror plugin behavior in Python.

# Verification steps

- Run `npm test --workspace @authfn/core -- api-keys two-factor`
- Run `python -m pytest authfn/python/tests/test_api_keys.py authfn/python/tests/test_two_factor.py`
- Manual flow: create key, authenticate, revoke key, enable 2FA, satisfy challenge, use recovery code
- Expected outcome: revoked keys fail immediately; 2FA challenge gates session completion.

# Stop condition

Report API-key secret handling, 2FA recovery-code semantics, and method-state representation on sessions.
