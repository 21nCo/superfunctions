---
title: Two-factor (TOTP) plugin
description: RFC 6238 TOTP with recovery codes, time-window tolerance, and pluggable encryption.
---

# Two-factor plugin

`authFnTwoFactorPlugin` adds TOTP-based two-factor authentication on top of any primary sign-in method (password, OTP, OAuth). Once a user enrolls and confirms, every subsequent sign-in returns `AUTHFN_2FA_REQUIRED` first; the user provides a code from their authenticator app, and only then does the kernel issue a session.

```ts
import { authfn, authFnPlugins } from 'authfn';
import { authFnTwoFactorPlugin } from '@authfn/two-factor';

const authApp = authfn({
  plugins: authFnPlugins(authFnTwoFactorPlugin()),
});

authApp.createServer({
  database,
  pluginRuntime: {
    twoFactor: {
      issuer: 'AcmeApp',
      digits: 6,
      periodSeconds: 30,
      window: 1,
      recoveryCodeCount: 10,
      encryptionKeyResolver: async () => loadKeyFromVault(),
    },
  },
});
```

## Configuration

All of these options are `pluginRuntime.twoFactor` fields. The factory takes only optional schema overrides.

| Option | Default | Notes |
| --- | --- | --- |
| `issuer` | `'authfn'` | The "issuer" string in the otpauth URI. Shown in authenticator apps. |
| `digits` | `6` | TOTP digits. |
| `periodSeconds` | `30` | TOTP period. |
| `window` | `1` | Skew tolerance — codes from the previous, current, and next window are accepted. |
| `challengeTtlSeconds` | `300` (5 min) | Lifetime of a challenge after primary sign-in. |
| `recoveryCodeCount` | `10` | Number of recovery codes generated at enrollment. |
| `maxFailedAttempts` | `10` | TOTP checks in a run for one enrollment, across challenges and the confirm, challenge and disable routes, before it is locked. A correct code ends the run. Whole number from 1 to 1000. |
| `lockoutSeconds` | `900` (15 min) | How long a locked enrollment refuses TOTP codes with `AUTHFN_RATE_LIMITED`. Whole number from 1 to 31536000 (one year). Both limits are checked when the server starts; a bad value fails with `AUTHFN_CONFIG_INVALID`. |
| `encryptionKeyRef` | `'default'` | Identifier passed to your `encryptionKeyResolver`. |
| `encryptionKeyResolver` | required for production | Returns a `Buffer` used to encrypt the TOTP secret at rest. |

The TOTP secret is encrypted at rest using AES-256-GCM with the key returned by `encryptionKeyResolver`. **Do not** hardcode keys; load them from a KMS, Vault, AWS Secrets Manager, or equivalent. Decrypt always uses the currently configured `encryptionKeyRef`; there is no public re-encrypt helper. See [Recipes → Rotating 2FA encryption](../recipes/rotate-2fa-encryption).

## Routes

| Method | Path | Operation ID | Notes |
| --- | --- | --- | --- |
| `POST` | `/auth/2fa/enroll` | `enrollTwoFactor` | Generate a TOTP secret + recovery codes for the current user. |
| `POST` | `/auth/2fa/confirm` | `confirmTwoFactor` | Confirm enrollment by submitting a valid TOTP code. |
| `POST` | `/auth/2fa/challenge` | `completeTwoFactorChallenge` | Complete the pending challenge from a primary sign-in. |
| `POST` | `/auth/2fa/disable` | `disableTwoFactor` | Disable 2FA. Requires a valid TOTP or recovery code. |

## Schema

| Table | Purpose |
| --- | --- |
| `authfn_two_factor_enrollments` | `{ id, userId, secretEncrypted, lastUsedCounter, failedAttemptCount, lockedUntil, confirmedAt, createdAt, updatedAt }`. `failedAttemptCount` and `lockedUntil` were added for the failed-attempt limit, and the AuthFn schema version is now 3: generate and apply a migration before deploying this version, or every code check fails on the missing columns. |
| `authfn_two_factor_recovery_codes` | `{ id, enrollmentId, codeHash, usedAt, createdAt }` — one row per code. |
| `authfn_two_factor_challenges` | `{ id, userId, primaryMethod, expiresAt, consumedAt, createdAt, updatedAt }` — one row per pending challenge. |

## Enrollment flow

```mermaid
sequenceDiagram
  participant User
  participant Client
  participant Kernel

  Client->>Kernel: POST /2fa/enroll
  Kernel-->>Client: { otpauthUri, recoveryCodes, secret? }
  User->>App: scan QR code in authenticator
  Client->>Kernel: POST /2fa/confirm { code: '123456' }
  Kernel-->>Client: { confirmedAt }
```

`recoveryCodes` are returned **once** at enrollment. Show them to the user and tell them to save them. The kernel only stores their hashes.

## Sign-in with 2FA

```mermaid
sequenceDiagram
  participant Client
  participant Kernel

  Client->>Kernel: POST /sign-in/password { email, password }
  Kernel-->>Client: 401 AUTHFN_2FA_REQUIRED { challengeId, expiresAt, primaryMethod: 'password' }
  Client->>Kernel: POST /2fa/challenge { challengeId, code }
  Kernel-->>Client: 200 OK + cookies
```

Within `challengeTtlSeconds`, the user must submit either a TOTP code or a recovery code. Recovery codes are single-use: a successful use marks the row as `usedAt: <now>` with a write that only applies while the code is unused, so two concurrent requests cannot both spend it, and a challenge can be finished only once. Recovery codes are 80 random bits (`XXXXX-XXXXX-XXXXX-XXXXX`), stored as a hash that includes the enrollment id; codes issued by earlier versions keep working.

Every TOTP check counts against the enrollment's `maxFailedAttempts`, whichever challenge or route it comes through, and with or without the HTTP rate limiter. The attempt is counted before the code is compared, so concurrent requests cannot check more codes than the limit. The check that completes a run of `maxFailedAttempts` is still made, then the enrollment is locked for `lockoutSeconds`; a correct code ends the run, unless other checks were counted after it, which keep counting.

Recovery codes are outside this limit and keep working while TOTP is locked: at 80 random bits (40 for codes issued by earlier versions) they cannot be guessed, and this way someone who knows the password cannot lock the owner out of every second factor. Someone who knows the password can still lock TOTP sign-in for `lockoutSeconds` at a time; the owner then signs in with a recovery code.

A recovery code submitted to finish a sign-in challenge is spent only after that request has claimed the challenge, so two requests racing on one challenge spend at most one code. If the code turns out to have been spent elsewhere meanwhile, the challenge is given back.

During a rolling deploy, recovery codes issued by this version are not accepted by servers still on an earlier one; finish the deploy before users enroll. The Python port verifies both hash formats and spends a code only while it is unused.

A TOTP code is recorded as used only after its request has claimed the sign-in challenge, so a request that loses the challenge to another one leaves its code usable. A schema override (`authFnTwoFactorPlugin({ schema })`) written for an earlier version gets the two new columns added with their default names.

## Disabling 2FA

`POST /2fa/disable` requires a fresh TOTP or recovery code in the body. The kernel revokes all of the user's 2FA enrollments and recovery codes in one transaction.

## Challenge replay protection

Each TOTP code is checked against `lastUsedCounter` — codes for windows ≤ that counter are rejected. This prevents replaying the same code twice within its window.

## Recovery code regeneration

After a recovery code is used, you should prompt the user to regenerate the set:

```ts
// Re-enroll keeps the user's secret but issues fresh recovery codes.
await client.enrollTwoFactor({ regenerateRecoveryCodes: true });
```

The recipe in [Recipes → Adding 2FA](../recipes/adding-2fa) walks through both the enrollment and the regeneration flows.

## Errors

| Code | When |
| --- | --- |
| `AUTHFN_2FA_INVALID_CODE` | Submitted code is wrong (TOTP or recovery). |
| `AUTHFN_2FA_REQUIRED` | Sign-in succeeded for the primary method; 2FA challenge needs to complete. |
| `AUTHFN_RATE_LIMITED` | The enrollment is locked after too many wrong codes. `details.resetAt` is when the lock ends. |
| `AUTHFN_NOT_FOUND` | `disable`/`challenge` for a non-enrolled user. |
| `AUTHFN_VALIDATION_ERROR` | Missing fields, malformed code. |

## Events

- `authfn.2fa.enabled` — confirmation succeeded.
- `authfn.2fa.challenged` — challenge issued (carries `primaryMethod`).
- `authfn.session.issued` — session issued post-challenge.

## Encryption rotation

The enrollment row does not store `encryptionKeyRef`. Changing the configured key without replacing stored ciphertext will make existing enrollments fail to decrypt. The supported public path is to have users disable and re-enroll after you cut over. See [Recipes → Rotating 2FA encryption](../recipes/rotate-2fa-encryption).

## Related

- [Plugins → Password](./password) — primary auth method that 2FA builds on.
- [Plugins → Email OTP](./email-otp) — OTP-only sign-up + 2FA is a clean flow.
- [Recipes → Adding 2FA](../recipes/adding-2fa)
- [Examples → account-settings](../examples/account-settings) — 2FA enrollment UI.
