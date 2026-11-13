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

const app = authfn({
  scopes: { memotron: ['read', 'write'] },
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
      loginRequired: ({ returnTo }) => Response.redirect(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`, 302),
      consent: (input) => renderConsentPage(input)
    }
  }
});
```

## Rules

- Access tokens live 1 hour. Refresh tokens live 30 days and rotate on every use. Presenting a rotated refresh token again revokes the whole grant.
- An authorization code works once, for one minute. Presenting a used code again revokes the grant and every token issued from it.
- The authorization request must send `resource`, which must exactly match a configured resource. `scope` must name scopes that resource offers; without `scope` the client asks for all of them.
- Redirect URIs match exactly, except that an `http://127.0.0.1` or `http://[::1]` redirect URI may use any port.
- A `trusted` client asks for consent once per resource; later requests within the consented scopes skip the page. Any other client asks every time.
- Tokens stop working when their grant is revoked or their user is deleted or disabled (`metadata.disabled`).

## Host responsibilities

**Metadata path.** RFC 8414 clients look for `/.well-known/oauth-authorization-server` at the issuer's origin. Route that path to `{basePath}/.well-known/oauth-authorization-server`. The issuer is the AuthFn environment's `issuer` (the request origin by default).

**Consent page.** `consent` receives the user, client, resource, scopes, the validated `params` and a `decisionUrl`. The page POSTs `{ ...params, decision: 'approve' | 'deny' }` as JSON to `decisionUrl` with the session cookie and the `x-authfn-csrf` header, then sends the browser to `data.redirectTo`.

**Resource servers.** A remote resource server calls the introspection endpoint with `Authorization: Bearer <introspectionSecret>`. Only access tokens issued for that resource are reported active. A resource server in the same process can call `verifyOAuthAccessToken`:

```ts
import { requireScopes } from 'authfn';
import { verifyOAuthAccessToken } from '@authfn/oauth-provider';

const token = await verifyOAuthAccessToken({ database }, bearer, { resource: 'https://memotron.example.com/mcp' });
requireScopes(token, 'memotron:read');
```

`revokeOAuthGrant({ database }, grantId, { userId })` revokes a grant, for example when a user disconnects an app.

Account deletion in `authfn` does not yet delete this plugin's rows. Tokens of a deleted user stop working, but the rows remain.
