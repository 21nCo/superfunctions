# @secfn/keys

An ES256 signing key ring for Node and Cloudflare Workers. It signs compact JWS, verifies them, and publishes a
JWK Set, with staged key rotation. It uses only WebCrypto (`crypto.subtle`), so it has no `node:` imports and no
runtime dependencies.

```ts
import { createSigningKeyRing, createWebCryptoSigner } from '@secfn/keys';

const ring = createSigningKeyRing({
  keys: [
    { kid: '2026-10', alg: 'ES256', status: 'verify-only', signer: await createWebCryptoSigner({ privateJwk: previousJwk }) },
    { kid: '2026-11', alg: 'ES256', status: 'active', signer: await createWebCryptoSigner({ pkcs8: env.SIGNING_KEY_PEM }) },
  ],
});

const token = await ring.sign({ typ: 'JWT' }, { sub: 'user-1', exp: 1_900_000_000 });
const { kid, header, payload } = await ring.verify(token); // payload is the signed bytes
const jwks = ring.jwks(); // serve at /.well-known/jwks.json
```

## Key statuses

| Status        | Signs | Verifies | In `jwks()` |
| ------------- | ----- | -------- | ----------- |
| `active`      | yes   | yes      | yes         |
| `verify-only` | no    | yes      | yes         |
| `retired`     | no    | no (`retired-kid`) | no |

Rotate in stages: publish the new key as `verify-only`, wait for caches of the JWKS to expire, make it `active` and
the old key `verify-only`, then mark the old key `retired` once every token it signed has expired. A `retired` entry
needs no signer.

`createSigningKeyRing` throws a `KeyRingError` at construction when the key set is not exactly one `active` key,
lists a `kid` twice, declares an algorithm other than ES256, has an `active` or `verify-only` entry without a
signer, or has a signer whose own `kid` (from its JWK or the `kid` option) differs from the entry's.

## Signing and verification

- `sign(header, payload)` always writes `alg: "ES256"` and the active `kid` into the protected header. A header
  that gives another `alg` or `kid`, or a `crit` parameter, is rejected. The payload is bytes, a UTF-8 string, or a
  JSON value serialized with `JSON.stringify`.
- `verify(jws)` accepts only the compact serialization with strict unpadded base64url, `alg: "ES256"`, a `kid` of an
  `active` or `verify-only` key, no `crit` parameter, and a 64-byte (r || s) signature. It returns
  `{ kid, header, payload }` or throws a `KeyRingError` whose `code` says why. It does not check JWT claims such as
  `exp`, `nbf`, `aud` or `iss`; callers that sign JWTs check those after `verify`.

## Signers

`createWebCryptoSigner({ privateJwk })` or `createWebCryptoSigner({ pkcs8, kid? })` imports a P-256 private key
(a JWK, PKCS #8 DER bytes, or a PEM string labelled `PRIVATE KEY`) as a non-extractable `CryptoKey` and
checks that it matches its public coordinates. Convert SEC1 `EC PRIVATE KEY` PEM files to PKCS #8 first, for example
with `openssl pkcs8 -topk8 -nocrypt`.

Any object implementing `Es256Signer` (`alg`, `publicJwk`, optional `kid`, and `sign(bytes)` returning a 64-byte
r || s signature) can be used as a signer.

## Key material

No method returns private key material, and no error message includes it: `KeyRingError` messages are fixed text
plus, at most, a `kid`, and underlying WebCrypto errors are not attached. A signer's `publicJwk` that carries a `d`
(or any other private) member is rejected, so a private key passed by mistake cannot reach `jwks()`.

Out of scope for this package: callers that already hold the private key, side-channel timing, a KMS-backed signer
and envelope encryption.
