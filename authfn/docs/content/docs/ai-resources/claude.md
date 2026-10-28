---
title: Claude
description: Use AuthFn's generated context with Claude Desktop and Claude Code.
---

# Claude

## One-off conversations

Paste the context URL at the start of a prompt:

```text
Reference docs: https://authfn.com/docs/llms-full.txt

Now help me…
```

Claude can fetch the file when web access is available; otherwise download it and attach it.

## Claude Code

Claude Code reads a project-level `CLAUDE.md`. Describe your stack and point at the context file:

```markdown
# Project

This is a SvelteKit app using:
- `authfn` for the auth kernel (mounted at /auth)
- `@authfn/password` and `@authfn/email-otp` for sign-in methods
- `@authfn/client` + `@authfn/svelte` for the browser
- Postgres + Drizzle for the database

For how `@authfn/*` works, read https://authfn.com/docs/llms.txt and fetch the linked pages you need.
```

## Related

- [llms.txt](./llms-txt)
