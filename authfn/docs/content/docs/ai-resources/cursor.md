---
title: Cursor
description: Point Cursor at AuthFn's generated context with a project rule.
---

# Cursor

## Project rule

Add a rule at `.cursor/rules/authfn.mdc` that points Cursor at the generated context:

```text
---
description: authfn — self-hosted authentication
---

When working with @authfn/*, fetch context from https://authfn.com/docs/llms-full.txt as needed.
Reference docs: https://authfn.com/docs
```

## Project-specific tweaks

Inside `.cursor/rules/authfn.mdc`, add anything specific to your stack:

```markdown
This project uses `authfn` with the `@authfn/password` and `@authfn/email-otp` plugins.
The kernel is mounted in `apps/api/src/auth.ts`.
The client lives in `packages/sdk/src/auth.ts`.

When generating sign-in / sign-up code, use the `client.*` helpers from `packages/sdk/src/auth.ts`.
```

## Tips

- Keep rules short. Longer = more cost per turn.
- Mention your **mount path** explicitly. authfn doesn't care if it's `/auth` or `/api/auth`, but the assistant might guess wrong.
- Mention which plugins are enabled. The assistant won't suggest `signInWithPassword` if it knows you only have OTP.

## Related

- [llms.txt](./llms-txt)
