# @authfn/oidc-issuer

A framework-neutral OpenID Connect issuer for workload identity: it serves the discovery document and the JWK Set as
`Request → Response` handlers and mints short-lived ES256 ID tokens with an [`@secfn/keys`](../../secfn/keys) key
ring. It uses WebCrypto only and runs on Node 20+ and Cloudflare Workers.

It does not implement authorization-code or user-login flows, so the discovery document has no
`authorization_endpoint` or `token_endpoint`: relying parties use it to find `jwks_uri` and verify tokens.

```ts
import { createSigningKeyRing, createWebCryptoSigner } from '@secfn/keys';
import { createOidcIssuer } from '@authfn/oidc-issuer';

const keyRing = createSigningKeyRing({
  keys: [{ kid: 'key-2', alg: 'ES256', status: 'active', signer: await createWebCryptoSigner({ privateJwk }) }],
});

const oidc = createOidcIssuer({ issuer: 'https://id.example.com', keyRing, defaultTtl: 300 });

// Mount the handlers at oidc.discoveryUrl and oidc.jwksUri in any framework.
export default {
  fetch(request: Request) {
    const { pathname } = new URL(request.url);
    if (pathname === '/.well-known/openid-configuration') return oidc.discoveryHandler(request);
    if (pathname === '/.well-known/jwks.json') return oidc.jwksHandler(request);
    return new Response('Not found', { status: 404 });
  },
};

const idToken = await oidc.mintIdToken({ sub: 'workload-1', aud: 'https://api.example.com', ttl: 600, claims: { tenant: 'tenant-1' } });
```

## Options

| Option | Meaning |
| --- | --- |
| `issuer` | Absolute `https` URL with no query, fragment or user info, in canonical form (lowercase host, no default port, no dot segments). Published as `issuer` and signed as `iss` exactly as given. |
| `keyRing` | A `SigningKeyRing` (or any object with `activeKid`, `sign` and `jwks`). Read once: to rotate, build a new ring and a new issuer. The ring's JWKS must publish the active kid. |
| `defaultTtl` | Lifetime in whole seconds of a token minted without `ttl`; 1 to 3600, default 300. |
| `jwksUri` | Published `jwks_uri`; an absolute `https` URL with no fragment. Defaults to `<issuer>/.well-known/jwks.json`. |
| `claimsSupported` | Custom claim names listed in `claims_supported` after `iss`, `sub`, `aud`, `iat`, `nbf`, `exp` and `jti`. `azp` is refused, since the issuer never emits it. |
| `now` | Clock in milliseconds since the epoch; defaults to `Date.now`. |

## Contract

- The discovery document has `issuer`, `jwks_uri`, `response_types_supported: ["id_token"]`,
  `subject_types_supported: ["public"]`, `id_token_signing_alg_values_supported: ["ES256"]` and `claims_supported`.
  Its URL is `<issuer>/.well-known/openid-configuration` (`oidc.discoveryUrl`).
- The JWKS lists only the public members (`kty`, `crv`, `x`, `y`, `kid`, `alg`, `use`) of the ring's active and
  verify-only keys. A retired key is not published, so a token it signed no longer verifies.
- Both handlers answer `GET` and `HEAD` with `200`, `Content-Type: application/json` and
  `Cache-Control: public, max-age=300`, and every other method with `405`, `Allow: GET, HEAD` and
  `Cache-Control: no-store`. They do not route by path.
- `mintIdToken({ sub, aud, ttl, claims })` signs `iss`, `sub`, `aud`, `iat`, `nbf` (equal to `iat`), `exp` and a random
  UUID `jti`, plus `claims`, with the active key (`typ: "JWT"`). `claims` cannot name any of those seven claims, and
  the lifetime is at most one hour.
- `claims` cannot set `azp` either (`reserved-claim`): relying parties such as AWS STS match `azp` in place of `aud`,
  so caller data must not choose the effective audience. The issuer never emits `azp`.

Every failure is an `OidcIssuerError` with a stable `code`: `invalid-options`, `invalid-subject`, `invalid-audience`,
`invalid-ttl`, `invalid-claims` or `reserved-claim`. A failure inside the key ring while signing (for example a
token over the ring's size limit) rejects with the ring's `KeyRingError`.

## Release order

This package depends on `@secfn/keys` `0.1.0` (SFNS-108, release slug `secfn-keys`). Publish `@secfn/keys@0.1.0` and
confirm that `npm view @secfn/keys@0.1.0 version` prints `0.1.0` before pushing the `authfn-oidc-issuer` tag: the
publish workflow installs the package outside the workspace and fails until that version is on npm. Both releases are
owner-run.

## Tests

`npm test` runs the suite on Node and then a workerd lane (`vitest.workerd.config.ts`, no `nodejs_compat`). Keys are
generated per run.
