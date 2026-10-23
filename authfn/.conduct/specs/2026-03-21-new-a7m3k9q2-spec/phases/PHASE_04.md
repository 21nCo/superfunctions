# Phase goal

Implement the social OAuth plugin for Google, Apple, and GitHub on top of the shared OAuth packages.

# In scope / Out of scope

- In scope: start/callback/disconnect routes, local account linking, browser redirect completion, runtime provider resolution
- Out of scope: 2FA, multi-region mismatch routing beyond runtime provider config integration

# Deliverables

- `authfn/core/src/plugins/social-oauth.ts`
- `authfn/core/src/core/oauth-accounts.ts`
- `authfn/core/src/__tests__/social-google.test.ts`
- `authfn/core/src/__tests__/social-apple.test.ts`
- `authfn/core/src/__tests__/social-github.test.ts`
- `authfn/client/src/__tests__/client-social.test.ts`
- `authfn/python/authfn/plugins/social_oauth.py`
- `authfn/python/tests/test_social_oauth.py`

# Requirements covered

- `SOC-001`
- `SOC-002`

# Implementation tasks

1. Add local OAuth account schema and indexes.
2. Wire shared OAuth start/callback/disconnect services into authfn plugin routes.
3. Implement account linking and session issuance behavior.
4. Implement redirect vs JSON callback completion rules.
5. Mirror behavior in Python.

# Verification steps

- Run `npm test --workspace @authfn/core -- social`
- Run `python -m pytest authfn/python/tests/test_social_oauth.py`
- Manual fixture flows for Google, Apple, GitHub start/callback
- Expected outcome: supported providers succeed, state replay fails, disallowed return URLs fail.

# Stop condition

Report provider runtime config contract, linking rules, and callback completion modes.
