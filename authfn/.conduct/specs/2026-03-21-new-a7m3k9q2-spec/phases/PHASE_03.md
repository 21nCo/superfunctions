# Phase goal

Implement the email OTP plugin and challenge delivery interfaces.

# In scope / Out of scope

- In scope: OTP send/verify for `verify-email`, `sign-in`, and `reset-password`; reset-password completion; delivery hooks
- Out of scope: social OAuth, API keys, 2FA, multi-region routing

# Deliverables

- `authfn/core/src/plugins/email-otp.ts`
- `authfn/core/src/core/verifications.ts`
- `authfn/core/src/core/delivery.ts`
- `authfn/core/src/__tests__/otp.test.ts`
- `authfn/client/src/__tests__/client-otp.test.ts`
- `authfn/python/authfn/plugins/email_otp.py`
- `authfn/python/tests/test_otp.py`

# Requirements covered

- `OTP-001`
- `OTP-002`

# Implementation tasks

1. Add OTP challenge schema and indexes.
2. Implement challenge creation, send orchestration, verification, and single-use semantics.
3. Implement password reset completion tied to a valid reset-purpose challenge.
4. Expose client methods for send/verify/reset.
5. Mirror the same flows in Python.

# Verification steps

- Run `npm test --workspace @authfn/core -- otp`
- Run `python -m pytest authfn/python/tests/test_otp.py`
- Manual flow: send verify-email code, verify it, resend, expire, replay
- Expected outcome: purpose mismatches and replay attempts fail with canonical errors.

# Stop condition

Report OTP table layout, challenge lifecycle states, and delivery interface shape.
