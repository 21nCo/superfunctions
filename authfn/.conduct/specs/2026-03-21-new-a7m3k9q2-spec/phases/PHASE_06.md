# Phase goal

Implement the bundled multi-region plugin and request-aware runtime resolution.

# In scope / Out of scope

- In scope: region lookup route, runtime resolver integration, region mismatch behavior, directory registration hooks, region-aware cookie/provider overrides
- Out of scope: migration/cutover from existing regional systems

# Deliverables

- `authfn/core/src/plugins/multi-region.ts`
- `authfn/core/src/core/runtime.ts`
- `authfn/core/src/core/regions.ts`
- `authfn/core/src/__tests__/multi-region.test.ts`
- `authfn/python/authfn/plugins/multi_region.py`
- `authfn/python/tests/test_multi_region.py`

# Requirements covered

- `REGION-001`
- `PLUG-001`

# Implementation tasks

1. Add region profile schema contribution and resolver interfaces.
2. Implement `/auth/regions/lookup` and `/auth/runtime`.
3. Add hook points for user-create registration and region mismatch short-circuiting.
4. Implement request-aware cookie and OAuth runtime override behavior.
5. Mirror behavior in Python.

# Verification steps

- Run `npm test --workspace @authfn/core -- multi-region`
- Run `python -m pytest authfn/python/tests/test_multi_region.py`
- Manual flow: lookup user by email, sign in on wrong authority, follow redirect metadata
- Expected outcome: lookup is deterministic; mismatch surfaces `AUTHFN_REGION_MISMATCH` with redirect details.

# Stop condition

Report region lookup payload, runtime resolver interface, and host/cookie/provider override behavior.
