# @authfn/oauth-provider

OAuth 2.1 authorization server for AuthFn. It serves:

- `GET {basePath}/.well-known/oauth-authorization-server`: metadata (RFC 8414)
- `GET {basePath}/oauth/authorize`: authorization code with PKCE `S256` only
- `POST {basePath}/oauth/authorize`: the consent decision
- `POST {basePath}/oauth/token`: code exchange; refresh with rotation and reuse detection
- `POST {basePath}/oauth/revoke`: revocation (RFC 7009)
- `POST {basePath}/oauth/introspect`: introspection (RFC 7662)
- `POST {basePath}/oauth/register`: dynamic client registration (RFC 7591), when `registration.dynamic` is on

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
- Redirect URIs match exactly, except that an `http://127.0.0.1` or `http://[::1]` redirect URI may use any port. A registered redirect URI uses `https`, `http` to one of those loopback IPs, or a native app's private-use scheme in reverse domain form such as `com.example.app:/oauth/cb` (RFC 8252 7.1). It must be written in visible ASCII (a non-ASCII host in punycode, anything else percent-encoded), and an `https` or `http` URI must begin with its origin as `scheme://host[:port]` (no `https:host`, backslashes or userinfo), since it is sent as is in the `Location` header. Any other URI, including `http://localhost`, `javascript:`, `data:`, `file:`, `ws:` and a scheme without a dot, is a configuration error. The response is the redirect URI byte for byte followed by the form-encoded response parameters, so a registered query is never rewritten; it must not use `code`, `state`, `iss`, `error`, `error_description` or `error_uri`.
- Client authentication failures are `invalid_client`: 401 with a `Basic` challenge when the client sent an `Authorization` header, otherwise 400. A public or `client_secret_post` client that sends any `Authorization` header fails.
- A `trusted` client asks for consent once per resource; later requests within the consented scopes skip the page. Any other client asks every time.
- Tokens stop working when their grant is revoked or their user is deleted or disabled (`metadata.disabled`).
- A code or refresh token is spent by a conditional write that also stores a claim ID, and the request that reads its own claim ID back wins; adapter row counts are not used. The new access and refresh tokens are stored first, each recording that claim ID, and a token is valid only while the code or refresh token it was issued for stores the same claim ID. So the claim is the single commit point and nothing is ever undone: a failure before it leaves the credential unspent and the stored tokens inert, and the loser of a concurrent exchange gets nothing usable. If the claim write fails, its read-back still decides, since the write may have committed. After the claim commits, the exchange checks the grant and user again: a disconnect, a revocation or a disabled or deleted user that took effect before the commit gets `invalid_grant`, never tokens; one that takes effect later revokes the tokens delivered. Only when the response is lost after the claim commits (including a lost write acknowledgement whose read-back also fails) is the credential spent without the client holding the tokens; presenting it again is a replay that revokes the grant, so the user authorizes again. Because validity reads the code or parent refresh token row, keep code rows and rotated refresh token rows while a token issued from them can still be valid (up to 30 days after their own refresh token was issued); deleting them makes those tokens inactive.

## Client registration

MCP hosts and other public clients can register themselves. Both ways are off until `pluginRuntime.oauthProvider.registration` turns them on:

```ts
registration: {
  dynamic: true,           // RFC 7591 at {basePath}/oauth/register
  metadataDocuments: true, // an https client_id URL serving the client's metadata
  rateLimit: { perIp: 20, global: 200, windowSeconds: 3600 }, // the defaults
  resolveClientIp: (request) => request.headers.get('cf-connecting-ip') ?? undefined,
  fetch: egressRestrictedFetch // optional; defaults to the global fetch
}
```

- Only public clients are accepted: `token_endpoint_auth_method` must be `none` (or absent), and metadata carrying `client_secret` is refused with `invalid_client_metadata`. `grant_types` must include `authorization_code` and may add `refresh_token`; `response_types` may only be `code`. Other metadata is ignored.
- `redirect_uris` lists 1 to 10 URIs, each `https` or `http://127.0.0.1[:port]` (the port may vary at authorization), under the same rules as configured redirect URIs; anything else, including `http://localhost`, `http://[::1]` and native app schemes, is `invalid_redirect_uri`. An authorization request whose `redirect_uri` is not registered is refused without a redirect.
- A registered client is never `trusted`: it asks for consent on every authorization. Its name on the consent page is its `client_name`, or its `client_id` without one. RFC 7592 client management is not offered, and registered clients keep working after `dynamic` is turned off, which only stops new registrations.
- **Client ID Metadata Documents.** A `client_id` that is an `https` URL is resolved by fetching it. The URL must have a path and no query, fragment or credentials, be written in normalized form, be at most 255 characters, and name a public DNS host: IP literals, single-label names and `localhost`, `.local`, `.internal`, `.localdomain` and `.home.arpa` names are refused without a request. The fetch does not follow redirects, must answer `200` within 5 seconds (body included) and at most 64 KB, and the document must name that exact URL as its `client_id` and pass the registration rules above. Otherwise the client is unknown. A document is reused for 5 minutes per process. A public host name can still resolve to a private address, so pass a `fetch` that restricts egress when the server can reach internal services.
- **Rate limit.** Registrations and metadata document fetches are limited separately, per client IP and overall, in fixed windows stored in the database, so every instance shares them. Over the limit the answer is `429` `temporarily_unavailable` with `Retry-After`. Without `resolveClientIp` (or AuthFn's `rateLimit.resolveClientIp`) only the overall limit applies. Concurrent requests never exceed a limit; at its edge they may all be refused, and refused requests do not use it up.

## Host responsibilities

**Metadata path.** RFC 8414 clients look for `/.well-known/oauth-authorization-server` at the issuer's origin, followed by the issuer's path when it has one (RFC 8414 3.1): for the issuer `https://auth.example.com/tenant` that is `https://auth.example.com/.well-known/oauth-authorization-server/tenant`. Route that path to `{basePath}/.well-known/oauth-authorization-server`. The issuer is the AuthFn environment's `issuer` (the request origin by default).

**Consent page.** `consent` receives the user, client, resource, scopes, the validated `params` and a `decisionUrl`. The page POSTs `{ ...params, decision: 'approve' | 'deny' }` as JSON to `decisionUrl` with the session cookie and the `x-authfn-csrf` header, then sends the browser to `data.redirectTo`.

**Resource servers.** A remote resource server calls the introspection endpoint with `Authorization: Bearer <introspectionSecret>`; the secret must be an RFC 6750 `b64token` (letters, digits and `-._~+/`, optionally ending in `=`). Only access tokens issued for that resource are reported active. The response leaves out the optional `iss`, because tokens do not record the issuer they were issued under. A resource server in the same process can call `verifyOAuthAccessToken`:

```ts
import { requireScopes } from 'authfn';
import { verifyOAuthAccessToken } from '@authfn/oauth-provider';

// Use the same database and namespace as the AuthFn server (`namespace` defaults to 'authfn').
const store = { database, namespace: 'authfn' };
const token = await verifyOAuthAccessToken(store, bearer, { resource: 'https://memotron.example.com/mcp' });
requireScopes(token, 'memotron:read', { registry: scopes });
```

**Disconnecting an app.** `disconnectOAuthClient(store, { userId, clientId, resource })` removes the user's consent for that client and resource, so even a trusted client shows the consent page again, and revokes every grant the user gave that client for that resource: each authorization creates its own grant, so a client signed in on two devices holds two. Every code, access token and refresh token under those grants stops working. `revokeOAuthGrant(store, grantId, { userId })` does the same for the client and resource of one grant, for example the `grantId` that `verifyOAuthAccessToken` returns. A disconnect first writes a new disconnect generation for the user, client and resource: a row found by the triple (concurrent first disconnects may add a second), holding a value never used before. An authorization reads the generation before it reads or records consent, and records and reads consent for that generation only, so an approval begun before a disconnect never authorizes anything after it. It reads the generation again after it creates its grant; when it changed, it revokes that grant and deletes the consent it recorded. So an authorization in progress while the app is disconnected issues no usable code and leaves no consent: the silent path of a trusted client shows the consent page and an approval redirects with `access_denied`. Each approval stores a consent row with the union of the approvals it read, then deletes the rows it read, so the remembered scopes are the union of the rows, concurrent approvals do not overwrite each other, and a user, client and resource keep one row apart from approvals that ran concurrently.

Account deletion in `authfn` does not yet delete this plugin's rows. Tokens of a deleted user stop working, but the rows remain.
