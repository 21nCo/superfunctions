# @authfn/oauth-provider

OAuth 2.1 authorization server for AuthFn. It serves:

- `GET {basePath}/.well-known/oauth-authorization-server`: metadata (RFC 8414)
- `GET {basePath}/oauth/authorize`: authorization code with PKCE `S256` only
- `POST {basePath}/oauth/authorize`: the consent decision
- `POST {basePath}/oauth/token`: code exchange; refresh with rotation and reuse detection; the device code grant (RFC 8628) when `deviceAuthorization` is configured
- `POST {basePath}/oauth/revoke`: revocation (RFC 7009)
- `POST {basePath}/oauth/introspect`: introspection (RFC 7662)
- `POST {basePath}/oauth/register`: dynamic client registration (RFC 7591), when `registration.dynamic` is on
- `POST {basePath}/oauth/device_authorization`, `GET`/`POST {basePath}/oauth/device`: the device authorization grant (RFC 8628) for CLIs, when `deviceAuthorization` is configured

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
- A code, device code or refresh token is spent by a conditional write that also stores a claim ID, and the request that reads its own claim ID back wins; adapter row counts are not used. The new access and refresh tokens are stored first, each recording that claim ID, and a token is valid only while the code or refresh token it was issued for stores the same claim ID. So the claim is the single commit point and nothing is ever undone: a failure before it leaves the credential unspent and the stored tokens inert, and the loser of a concurrent exchange gets nothing usable. If the claim write fails, its read-back still decides, since the write may have committed. After the claim commits, the exchange checks the grant and user again: a disconnect, a revocation or a disabled or deleted user that took effect before the commit gets `invalid_grant`, never tokens; one that takes effect later revokes the tokens delivered. Only when the response is lost after the claim commits (including a lost write acknowledgement whose read-back also fails) is the credential spent without the client holding the tokens; presenting it again is a replay that revokes the grant, so the user authorizes again. Because validity reads the code, device code or parent refresh token row, keep code rows, exchanged device code rows and rotated refresh token rows while a token issued from them can still be valid (up to 30 days after their own refresh token was issued); deleting them makes those tokens inactive. The provider itself deletes a device code row only once no token issued for it can be valid (see Device authorization).

## Client registration

MCP hosts and other public clients can register themselves. Both ways are off until `pluginRuntime.oauthProvider.registration` turns them on:

```ts
registration: {
  dynamic: true,           // RFC 7591 at {basePath}/oauth/register
  metadataDocuments: true, // an https client_id URL serving the client's metadata
  rateLimit: { perIp: 20, global: 200, windowSeconds: 3600 }, // the defaults
  // Only behind Cloudflare, which overwrites cf-connecting-ip; see below.
  resolveClientIp: (request) => request.headers.get('cf-connecting-ip') ?? undefined,
  fetch: egressRestrictedFetch // required with metadataDocuments
}
```

`resolveClientIp` must return an address that your own ingress sets, never a header a caller can send: `cf-connecting-ip` only when every request passes through Cloudflare, which overwrites it, and `x-forwarded-for` only as appended by a proxy you run. Otherwise a caller picks a new "IP" for each request and only the overall limit holds.

- Only public clients are accepted: `token_endpoint_auth_method` must be `none` (or absent), and metadata carrying `client_secret` is refused with `invalid_client_metadata`. `grant_types`, when supplied, must include `authorization_code` and may add `refresh_token`; `response_types` may only be `code`. Other metadata is ignored.
- `redirect_uris` lists 1 to 10 URIs, each `https` or `http://127.0.0.1[:port]` (the port may vary at authorization), under the same rules as configured redirect URIs; anything else, including `http://localhost`, `http://[::1]` and native app schemes, is `invalid_redirect_uri`. An authorization request whose `redirect_uri` is not registered is refused without a redirect.
- A registered client is never `trusted`: it asks for consent on every authorization. Its name on the consent page is its `client_name`, or its `client_id` without one. RFC 7592 client management is not offered, and registered clients keep working after `dynamic` is turned off, which only stops new registrations.
- **Client ID Metadata Documents.** A `client_id` that is an `https` URL is resolved by fetching it. The URL must have a path and no query, fragment or credentials (not even an empty `?` or `#`), be written in normalized form, be at most 255 characters, and name a public DNS host of valid labels: IP literals, single-label names, empty labels such as `foo..example.com` and `localhost`, `.local`, `.internal`, `.localdomain` and `.home.arpa` names are refused without a request. The fetch does not follow redirects, must answer `200` within 5 seconds (body included) and at most 64 KB, and the document must name that exact URL as its `client_id` and pass the registration rules above. A usable document is stored and shared by every instance. A known client (one that has served a usable document) is refetched at most once per 5 minutes across all instances, so a changed document takes effect within about 10 minutes. These refetches are not rate-limited and do not use up the limit, so flooding only refuses new clients. When the host gives no usable answer (a network error, no complete answer within 5 seconds, a `5xx`, `408` or `429`), a known client keeps its last document. Any other answer that is not a usable UTF-8 JSON document makes the client unknown and drops its stored document. Only the request holding the current refetch claim stores or drops what it fetched; a refetch that stalls past its 5-minute claim, or runs on an instance whose clock is behind, changes nothing and serves the document stored by the newer claim. A public host name can still resolve to a private address, so `metadataDocuments` requires a `fetch` and the server refuses to start without one: pass one that cannot reach private or internal addresses (for example through an egress proxy that refuses them). Where the platform's own `fetch` already cannot reach them, pass that explicitly.
- **Rate limit.** Registrations and first fetches of unknown metadata document clients are limited separately, per client IP and overall, in fixed windows stored in the database, so every instance shares them. Over the limit the answer is `429` `temporarily_unavailable` with `Retry-After`. Without `resolveClientIp` (or AuthFn's `rateLimit.resolveClientIp`) only the overall limit applies. Concurrent requests never exceed a limit; at its edge they may all be refused, and refused requests do not use it up. A registration body must arrive complete within 5 seconds and be at most 64 KB, so a slow upload cannot hold a request open before it is counted.
- **Storage.** Registration uses the tables `oauth_provider_clients`, `oauth_provider_document_clients` and `oauth_provider_registration_events`. A custom plugin `schema` that leaves them out gets them added (one it defines itself is kept), so migrate them even while registration is off.

## Device authorization (CLI login)

A CLI or other device without a browser signs in with the device authorization grant (RFC 8628). It is off until `pluginRuntime.oauthProvider.deviceAuthorization` turns it on:

```ts
deviceAuthorization: {
  verification: (input) => renderDevicePage(input),
  rateLimit: { perUser: 10, global: 1000, windowSeconds: 600 }, // user code lookups; the defaults
  authorizationRateLimit: { perIp: 20, global: 1000, windowSeconds: 600 }, // device authorization requests; the defaults
  resolveClientIp: (request) => request.headers.get('cf-connecting-ip') // only behind Cloudflare; see Client registration
}
```

1. The CLI POSTs `client_id`, `resource` and optionally `scope` (form-encoded) to `{basePath}/oauth/device_authorization`. It gets `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in: 600` and `interval: 5`, and shows the user the code and the URI. Over `authorizationRateLimit` it gets `429` `temporarily_unavailable` with `Retry-After`, and nothing is stored. A body over 8 KB, declared or sent, or one that has not arrived within 5 seconds is an `invalid_request`, before the client is authenticated or the request counted.
2. The user opens `verification_uri` (`{basePath}/oauth/device`). Without a session the page answers through `loginRequired`, with the page URL as `returnTo`. `verification` renders the page. Without a `user_code` query parameter it asks for the code; its form submits `user_code` with GET to `verificationUrl`. With one, `verification` receives the `authorization` it names (client, resource, scopes), or an `error`: `invalid_user_code` (unknown, malformed, already decided, or for a client that is no longer configured), `expired_user_code` or `too_many_attempts` with `retryAfterSeconds`. The page POSTs `{ user_code, decision: 'approve' | 'deny' }` as JSON to `decisionUrl` with the session cookie and the `x-authfn-csrf` header; the response's `data.decision` is `approved` or `denied`. A code that cannot be decided answers `invalid_grant`, and over the rate limit `429` `temporarily_unavailable` with `Retry-After`.
3. Meanwhile the CLI polls the token endpoint with `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code` and its client authentication, and optionally `resource`. After an approval it gets the same response as an authorization code exchange: an access token for the approved scopes and resource and a refresh token that rotates. Otherwise the answer is a `400` with one of:
   - `authorization_pending`: the user has not decided yet.
   - `slow_down`: the poll came within the interval (below).
   - `access_denied`: the user denied the request, or the approved grant was revoked before the exchange (the app was disconnected, also during the approval, or the user was disabled or deleted).
   - `expired_token`: the code is 10 minutes old, decided or not.
   - `invalid_target`: `resource` is not the one requested in step 1; the code is not spent.
   - `invalid_grant`: the code is unknown or was issued to another client, or it was already exchanged (which revokes the grant, below), or the grant was revoked while the exchange ran.

   A poll that loses 16 rounds to concurrent polls of one code, or that cannot tell whether it was stored because 16 or more polls of the code were stored meanwhile, gets `429` `temporarily_unavailable`, never tokens or `slow_down`; in the second case it may already count as the last poll and have added its 5 seconds. Its `Retry-After` is the code's interval as stored after the concurrent polls, counted from the last stored poll time, plus those 5 seconds when they may count, so a poll after it is not too fast.

- User codes are 8 letters from `BCDFGHJKLMNPQRSTVWXZ` (no vowels, nothing that looks like a digit), shown as `XXXX-XXXX`; the page accepts them in any case, with or without the dash and spaces. They and device codes are valid for 10 minutes and stored only as hashes.
- A poll less than `interval` seconds after the previous one gets `slow_down` and adds 5 seconds to that device code's interval, and counts as the previous poll, so a client that keeps polling early keeps being slowed. Each poll gets one answer and is stored once: of concurrent polls of one code at most one is admitted, the others get `slow_down` and each adds its 5 seconds, so the stored interval is 5 plus 5 for each `slow_down` answered (plus 5 for each early poll answered `429` because it could not tell whether it was stored, above). A poll that arrives with an earlier clock reading than the last one is too fast and does not move the last poll time back.
- Every user code lookup by the page or the decision endpoint counts toward the rate limit, found or not: per signed-in user and overall, in fixed windows shared by every instance through the registration event table. 20^8 codes and at most `global` guesses per window keep the chance of hitting someone's pending code small.
- Each code is decided once; of concurrent decisions exactly one is recorded. An approval creates its own grant (so disconnecting the app or revoking the grant ends it like any other) and follows the same disconnect rule as an authorization code approval: it checks the disconnect generation after creating the grant and only then records the decision, so the device cannot exchange the code before that check. An app disconnected while the approval runs gets no usable grant: the decision answers `access_denied` and the request is recorded as denied. Expiry is checked just before and again after the decision is recorded; an approval that crosses it revokes its grant and answers `invalid_grant`, and the device gets `expired_token`. One that crosses it before the write records nothing; one that crosses it after the write spends the code, unless the device already exchanged it. An exchange judges expiry with a clock read after it read the approval, so one that wins shows the approval was recorded in time: the approval stands and the tokens stay valid. An approval interrupted before it records the decision leaves the request pending. The user always sees the approval page, even for a `trusted` client, and the approval is not remembered as consent.
- The device code works once. Presenting it again after the exchange revokes the grant and every token issued under it, as a replayed authorization code does. It is bound to the client it was issued to.
- Only configured clients may use the grant; a self-registered client gets `unauthorized_client`. When the grant is off, its endpoints do not exist and the token endpoint answers `unsupported_grant_type` for it.
- Every device authorization request counts toward `authorizationRateLimit`, per client IP and overall, in the same shared windows as the user code lookups; refused requests store no code and do not use the limit up. The client IP comes from `resolveClientIp`, or AuthFn's `rateLimit.resolveClientIp`; without either only the overall limit applies, and the same rule as for registration applies to where it reads the address.
- **Storage.** The grant uses the table `oauth_provider_device_codes`, which a custom plugin `schema` gets added like the registration tables, so migrate it even while the grant is off. Each admitted device authorization request deletes codes never exchanged 10 minutes after they expired. An exchanged code is kept while tokens issued for it can be valid (30 days after the exchange), since they stay valid only while its row exists, as for authorization code rows; after that it is kept while its grant is unrevoked and holds an unexpired refresh token that was not rotated or revoked, so that replaying it still revokes the grant and the tokens refreshed under it, and deleted once neither holds. Its user code lookups and requests are counted in `oauth_provider_registration_events`.

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
