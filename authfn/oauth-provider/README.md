# @authfn/oauth-provider

OAuth 2.1 authorization server for AuthFn. It serves:

- `GET {basePath}/.well-known/oauth-authorization-server`: metadata (RFC 8414)
- `GET {basePath}/oauth/authorize`: authorization code with PKCE `S256` only
- `POST {basePath}/oauth/authorize`: the consent decision
- `POST {basePath}/oauth/token`: code exchange; refresh with rotation and reuse detection
- `POST {basePath}/oauth/revoke`: revocation (RFC 7009)
- `POST {basePath}/oauth/introspect`: introspection (RFC 7662)

Every token is bound to one resource (RFC 8707) and carries the scopes the user granted, using the AuthFn scope registry.

```ts
import { authfn } from 'authfn';
import { authFnOAuthProviderPlugin } from '@authfn/oauth-provider';

const scopes = { memotron: ['read', 'write'] } as const;

const app = authfn({
  scopes,
  plugins: [authFnOAuthProviderPlugin()]
});

const auth = app.createServer({
  database,
  pluginRuntime: {
    oauthProvider: {
      clients: [{ clientId: 'rhombus', name: 'Rhombus', trusted: true, redirectUris: ['https://rhombus.example.com/cb'] }],
      resources: [{
        resource: 'https://memotron.example.com/mcp',
        scopes: ['memotron:read', 'memotron:write'],
        introspectionSecret: env.MEMOTRON_INTROSPECTION_SECRET
      }],
      loginRequired: ({ request, returnTo }) =>
        Response.redirect(new URL(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`, request.url).toString(), 302),
      consent: (input) => renderConsentPage(input)
    }
  }
});
```

## Rules

- Access tokens live 1 hour. Refresh tokens live 30 days and rotate on every use. Presenting a rotated refresh token again revokes the whole grant.
- An authorization code works once, for one minute. When the client it was issued to presents a used code again, with the matching `redirect_uri` and `code_verifier`, the grant and every token issued from it are revoked. Anyone else presenting a used code gets `invalid_grant` and the grant is untouched.
- The authorization request must send `resource`, which must exactly match a configured resource. `scope` must name scopes that resource offers; without `scope` the client asks for all of them.
- Redirect URIs match exactly, except that an `http://127.0.0.1` or `http://[::1]` redirect URI may use any port.
- A `trusted` client asks for consent once per resource; later requests within the consented scopes skip the page. Any other client asks every time.
- Tokens stop working when their grant is revoked or their user is deleted or disabled (`metadata.disabled`).

## Host responsibilities

**Metadata path.** RFC 8414 clients look for `/.well-known/oauth-authorization-server` at the issuer's origin, followed by the issuer's path when it has one (RFC 8414 3.1): for the issuer `https://auth.example.com/tenant` that is `https://auth.example.com/.well-known/oauth-authorization-server/tenant`. Route that path to `{basePath}/.well-known/oauth-authorization-server`. The issuer is the AuthFn environment's `issuer` (the request origin by default).

**Consent page.** `consent` receives the user, client, resource, scopes, the validated `params` and a `decisionUrl`. The page POSTs `{ ...params, decision: 'approve' | 'deny' }` as JSON to `decisionUrl` with the session cookie and the `x-authfn-csrf` header, then sends the browser to `data.redirectTo`.

**Resource servers.** A remote resource server calls the introspection endpoint with `Authorization: Bearer <introspectionSecret>`. Only access tokens issued for that resource are reported active. A resource server in the same process can call `verifyOAuthAccessToken`:

```ts
import { requireScopes } from 'authfn';
import { verifyOAuthAccessToken } from '@authfn/oauth-provider';

// Use the same database and namespace as the AuthFn server (`namespace` defaults to 'authfn').
const store = { database, namespace: 'authfn' };
const token = await verifyOAuthAccessToken(store, bearer, { resource: 'https://memotron.example.com/mcp' });
requireScopes(token, 'memotron:read', { registry: scopes });
```

**Disconnecting an app.** `disconnectOAuthClient(store, { userId, clientId, resource })` removes the user's consent for that client and resource, so even a trusted client shows the consent page again, and revokes every grant the user gave that client for that resource: each authorization creates its own grant, so a client signed in on two devices holds two. Every code, access token and refresh token under those grants stops working. `revokeOAuthGrant(store, grantId, { userId })` does the same for the client and resource of one grant, for example the `grantId` that `verifyOAuthAccessToken` returns.

Account deletion in `authfn` does not yet delete this plugin's rows. Tokens of a deleted user stop working, but the rows remain.
