# `@mcpfn/auth`

OAuth integration for MCP clients, resource servers, and hosted authorization
systems. Protocol mechanics remain in the official MCP SDK.

```ts
import { createOAuthResourceServerHandler } from "@mcpfn/auth";

const mcp = await server.createWebStandardHandler({ enableJsonResponse: true });
const fetch = createOAuthResourceServerHandler(mcp, {
  resource: "https://api.example.com/mcp",
  authorizationServers: ["https://login.example.com"],
  scopesSupported: ["mcp:read"],
  requiredScopes: ["mcp:read"],
  verifier,
});
```

The verifier's `AuthInfo` must carry an `expiresAt` in the future and a
`resource` equal to the configured resource. Tokens without `expiresAt` are
refused unless `allowTokensWithoutExpiry: true` is set.

Enterprise-managed authorization helpers advertise the stable ID-JAG grant profile in authorization-server metadata and build the request metadata used by supporting clients.

## Client provider

`createMcpFnOAuthClientProvider()` implements the official
`OAuthClientProvider`. It validates the requested redirect against registered
metadata before opening a browser, correlates callback state, stores PKCE and
tokens in memory unless an encrypted store is supplied, classifies token
exchange/refresh/revocation diagnostics, and redacts credentials.
Stored tokens and client information keep the `issuer` the MCP SDK records,
so refresh tokens and client secrets are only presented to that authorization
server during OAuth. The access token itself is sent to the MCP server the
provider is used with, so give each MCP resource its own credential store (or
encrypted-store namespace). Tokens saved without an
`issuer` (by an earlier version) are returned without their refresh token, so
the client authorizes again when the access token expires, and confidential
client information (with a `client_secret`) saved without an `issuer` is not
returned, so the client registers again; neither secret is presented to
whichever authorization server an MCP server names. Store pre-registered
confidential clients with their `issuer`. Callback `state` is checked by this provider's
`validateAuthorizationState()`; a plain SDK provider without that method gets
PKCE protection only.

```ts
const provider = createMcpFnOAuthClientProvider({
  redirectUrl: "http://127.0.0.1/callback",
  clientMetadata: {
    redirect_uris: ["http://127.0.0.1/callback"],
    response_types: ["code"],
    grant_types: ["authorization_code", "refresh_token"],
  },
  openAuthorization: (url) => browser.open(url),
});
```

Pass it to `streamableHttpTarget`. Complete interactive authorization with
`client.completeAuthorization({ code, state })`; a missing or mismatched state
fails before token exchange. Dynamic loopback ports are accepted only when the
registered URI omits the port. Other redirect URIs require exact equality.

Native private-use redirects use RFC 8252's reverse-domain scheme policy by
default, accepting values such as `com.example.app:/oauth/callback`. Hosts can
set `redirectPolicy.privateUseSchemePolicy: "disabled"` to reject all native
schemes, or opt into `"compatible"` for well-formed non-web schemes used by
native clients and name those schemes explicitly, for example
`compatiblePrivateUseSchemes: ["cursor"]` for
`cursor://anysphere.cursor-mcp/oauth/callback`. Compatibility mode still rejects
web, network, launcher, and dangerous schemes, non-loopback HTTP, credentials,
fragments, wildcards, and malformed or opaque callbacks. Authorization always
requires exact matching; dynamic-port matching remains restricted to loopback
HTTP. Successful dynamic
registrations expose compatibility scheme names and counts through the hosted
authorization diagnostics hook so hosts can audit use without recording callback
queries.

The deprecated `allowPrivateUseSchemes` boolean remains accepted for 0.0.3
callers: `false` maps to `disabled` and `true` maps to `rfc8252`. When neither
field is provided, 0.0.4 defaults to `rfc8252`.

## Hosted compatibility

`createMcpAuthorizationCompatibilityHandler()` publishes authorization-server
metadata and composes DCR, pre-registration, Client ID Metadata Documents,
authorization-code + PKCE request validation, typed token exchange, serialized
refresh rotation, and revocation endpoints. Metadata is derived from the token
authority callbacks and declared client-auth methods, so unsupported grants or
methods are never advertised. McpFn parses and validates endpoint requests;
the host application's callbacks remain authoritative for login, consent,
durable clients, code issuance, signing, token values, and revocation state.
External Client ID Metadata Documents require an explicit URL allow-policy.
McpFn disables automatic redirects, reapplies that policy at every redirect,
streams responses through a byte cap, and applies a ten-second deadline by
default. `maxBytes`, `timeoutMs`, and `maxRedirects` can tighten those bounds.
A Client ID Metadata Document must contain a `client_id` equal to its URL, be
served with a single `application/json` media type, and use
`token_endpoint_auth_method` `none`. Per the draft, when
`token_endpoint_auth_methods_supported` is present it must be a nonempty list of
strings containing any declared method, and `none` is selected whenever it is
listed; without a list, an omitted method means `none`. Neither field may
name a shared-secret method (`client_secret_basic`, `client_secret_post`,
`client_secret_jwt`). Anything else is refused with `invalid_client_metadata`. Stored self-registered clients have unsafe link fields dropped
before their metadata is used. In registrations and documents, `client_uri`, `logo_uri`,
`tos_uri` and `policy_uri` may be omitted or `null`; any other value must be an
absolute `https://` URL without credentials, or the client is refused with
`invalid_client_metadata`. The `allow` policy sees only the URL: reject
private, loopback and link-local hosts there.

The AuthFn adapter uses a structural provider contract. `@superfunctions/auth`
is an optional peer: installing or importing AuthFn is not required for other
client, resource-server, or hosted authorization features.

`createMcpFnAuthProviderAdapter()` maps a generic `@superfunctions/auth`
session into official MCP `authInfo`, keeping identity, tenant, scopes, and
resources out of model-controlled tool arguments. Bearer credentials are
required. A bearer-specific provider can implement
`authenticateBearer(token, request)` directly; a standard AuthFn
`authenticate(request)` provider is invoked with a credential-isolated request
containing only that exact Bearer token. An AuthProvider's `authorize()` hook
receives the normalized MCP resource URL before trusted context is created.
Without that hook, the principal's `resourceIds` must contain the resource,
compared exactly as an identifier (the configured `resource`, which must be
given in its normalized form, the identifier `createProtectedResourceMetadata`
advertises, such as a lowercase host; any other spelling throws unless the
provider has an `authorize()` hook;
the default mapping copies `resourceIds` from the
session, and a custom `map()` must return them); otherwise the credential is
refused. Expiry is checked again right before the MCP handler runs, and a
non-finite `expiresAt` counts as expired. `allowUnboundCredentials: true` accepts
credentials with no `resourceIds` at all (without setting `authInfo.resource`);
a credential bound to other resources is always refused. Sessions
past their `expiresAt` (or a mapped principal's) are refused. The default
mapping sets `authInfo.clientId` to the session's `metadata.clientId`, or else
`<actorType>:<actorId>`; it never uses the session ID. `auth-diagnose` and
`diagnoseMcpAuthorization()` perform read-only discovery without browser or
credential actions.

### Authorization endpoint errors

Unknown clients and unregistered `redirect_uri` values always get a JSON error
from the authorization server, never a redirect. Once the `redirect_uri`
matches, later validation errors (for example a missing `code_challenge` or
`state`, an unsupported `response_type`, or a disallowed `resource`) are
redirected to that URI with `error`, `error_description`, and `state` (echoed
only when the request supplied a single valid `state`), only for clients whose
`source` is listed in
`authorizationErrors.redirectSources`. The default is
`["pre-registered", "enterprise"]`, the clients whose redirect URIs the operator
provisioned.

Dynamically registered and Client ID Metadata Document clients choose their
own redirect URIs without authentication, so redirecting their errors would
make the issuer an open redirector (RFC 9700 §4.11.2). For them the endpoint
returns an HTTP 400 `text/html` page with `cache-control: no-store`, showing
the HTML-escaped OAuth error code and description, with no link to the
redirect URI and no reflected `state`. `renderMcpAuthorizationErrorPage(error)`
builds that default page.

```ts
createMcpAuthorizationCompatibilityHandler({
  // ...
  authorizationErrors: {
    // Optional: replace the default page for non-redirected errors.
    render: ({ error, client, request }) => renderHostErrorPage(error, client, request),
  },
});
```

Since 0.0.7 this is the default; earlier versions redirected errors for every
client source. To restore that behaviour, pass all four sources:
`authorizationErrors: { redirectSources: ["pre-registered", "enterprise",
"dynamic", "client-metadata-document"] }`.
