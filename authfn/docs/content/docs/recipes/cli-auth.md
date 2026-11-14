---
title: CLI authentication
description: Issue an API key from your web UI and use it from a command-line tool.
---

# CLI authentication

## Goal

Let users authenticate a CLI tool against your authfn-backed service. The standard pattern is API keys: the user creates one in your web UI, copies the secret, and exports it as an env var.

## Plugins

- `authFnApiKeyPlugin`, with a scope registry on `authfn()`:

```ts
const authApp = authfn({
  scopes: { projects: ['read', 'write'] },
  plugins: authFnPlugins(authFnApiKeyPlugin()),
});
```

## Web flow

```ts
const created = await client.createApiKey({ name: 'CLI', scopes: ['projects:read', 'projects:write'] });
showOnce(created.data.secret);   // "sk_live_..." — display once, copy to clipboard
```

## CLI usage

```bash
export ACME_API_KEY=sk_live_...
acme list-projects
```

```ts
// in the CLI:
const apiKey = process.env.ACME_API_KEY;
const response = await fetch('https://api.acme.com/projects', {
  headers: { Authorization: `Bearer ${apiKey}` },
});
```

## Server-side authentication

Your protected endpoint authenticates via `auth.provider` and calls `requireScopes` to return HTTP 403 before loading protected data. Here `auth` is your AuthFn server and `app` is your application's HTTP router:

```ts
import { AuthFnError, requireScopes, type AuthFnSession } from 'authfn';

app.get('/projects', async (c) => {
  let session: AuthFnSession | null;
  try {
    session = await auth.provider.authenticate(c.req.raw);
    requireScopes(session, 'projects:read');
  } catch (error) {
    if (error instanceof AuthFnError && (error.status === 401 || error.status === 403)) {
      return c.json({ error: error.status === 401 ? 'unauthorized' : 'forbidden' }, error.status);
    }
    throw error;
  }
  // session.actorId === the key owner's user id (the key id for an unowned key)
  // session.credential?.id === api key id (undefined for a signed-in browser session)
  // session.scopes === ['projects:read', 'projects:write']
  return c.json({ projects: [] }); // Replace with your application's project data.
});
```

Missing, invalid, expired, or revoked credentials receive HTTP 401. The catch only handles AuthFn's 401 and 403 errors from authentication and the scope check; unexpected provider failures and failures while loading project data remain host application errors. Keys lacking `projects:read` (or `projects:*`, or `*`) receive HTTP 403; a signed-in browser session carries `['*']` and passes.

## Per-key scopes

Each key carries scopes from the registry. A key may hold a registered scope, `<owner>:*` for every action of one owner, or `*` for every registered scope; creating a key with any other scope fails with HTTP 400. See [Plugins → API keys → Scopes](../plugins/api-keys#scopes).

## Refreshing keys

To rotate, the user creates a new key, swaps it in their CLI env, then revokes the old one.

## Related

- [Plugins → API keys](../plugins/api-keys)
- [Concepts → Sessions](../core-concepts/sessions)
