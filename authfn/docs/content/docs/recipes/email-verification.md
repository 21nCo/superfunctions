---
title: Email verification
description: Verify a user's email after sign-up. Copy-paste recipe.
---

# Email verification

## Goal

Confirm that a newly signed-up user controls the email address they gave you. Until they verify, mark `emailVerifiedAt: null`. Optionally, gate parts of the app behind verification.

## Plugins

- `authFnEmailOtpPlugin` (purpose: `'verify-email'`).

## Server flow

```ts
// 1. After sign-up:
await client.sendOtp({ email, purpose: 'verify-email' });
// 2. User receives email, enters code in your UI. requireAccountHolder makes
//    this the signed-in user's own verification: if their session expired,
//    the request is refused (AUTHFN_UNAUTHENTICATED) with the code left
//    unused; ask them to sign in again and resubmit.
await client.verifyOtp({ email, code, purpose: 'verify-email', requireAccountHolder: true });
// 3. authfn marks emailVerifiedAt = now.
```

Without `requireAccountHolder`, a code entered without the account's own session counts as someone proving the mailbox first, and removes everything set up on the account before (see [Password → Unverified accounts](../plugins/password#unverified-accounts)).

The kernel sets `authfn_users.emailVerifiedAt` on a successful `verify-email` OTP. Read it from `getAccountDetails()`:

```ts
const account = await client.getAccountDetails();
if (account.ok) {
  const verified = account.data.user.emailVerifiedAt !== null;
}
```

## Gating routes by verification

Gate your application routes from your own code (below), so an unverified user can still sign in with their password and then submit the code with `requireAccountHolder`.

You can also refuse password sign-in until the email is verified:

```ts
authFnPasswordPlugin({ requireEmailVerifiedForSignIn: true })
```

With that setting, a user whose session expires before they verify cannot sign in with their password to get a new session for the guarded request. There are two ways back, and both are a first proof of the mailbox, so both claim the account (removing API keys, second factors, linked accounts and anything else set up before):

- an email-code sign-in, which also removes the password. Adding a new one from that session needs `accountLinking.passwordForAuthenticatedUser`; without it, that request is refused with `AUTHFN_CONFLICT`, and a password reset (where configured) sets a new password instead;
- a password reset, which installs the new password and keeps it, so they then sign in with it.

To gate in your application code:

```ts
const session = await auth.provider.authenticate(request);
if (!account.user.emailVerifiedAt) {
  return redirect('/verify-email');
}
```

## Related

- [Plugins → Email OTP](../plugins/email-otp)
- [Plugins → Password](../plugins/password)
