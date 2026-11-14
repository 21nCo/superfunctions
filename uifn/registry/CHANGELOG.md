# Changelog

## 0.0.3

- Regenerated the source catalog so each component records `@uifn/react` 0.0.4, `@uifn/svelte` 0.0.4 and `@uifn/solid` 0.0.2 as its runtime adapter. The catalog signature is produced again by the release-signing workflow for the new catalog bytes.
- `uifn init` presets pin `@uifn/react` 0.0.4, `@uifn/svelte` 0.0.4, `@uifn/solid` 0.0.2 and `@uifn/components-{react,svelte,solid}` 0.0.2, matching the catalog. Source installs reject a project whose adapter pin differs from the catalog. The Svelte preset still pinned `@uifn/svelte` 0.0.1 while the catalog recorded 0.0.3.

## 0.0.2

- Breaking: the bundled catalog is verified only with the schema-v2 signature envelope. The verifier recomputes the catalog SHA-256 and the signed input `UTF8("uifn-registry-v2\0") || SHA-256(catalog-bytes)` itself, and rejects schema v1, another domain, key id or algorithm, a digest mismatch and malformed envelopes with `UIFN_REGISTRY_SIGNATURE_INVALID` and a `reason`. A Proxy envelope (rejected before any trap runs), an accessor or extra field, and a non-canonical Base64 signature are malformed.
- The trust root is the AWS KMS release-signing key, key id `a72cc93c0e85e7af79cf582c`. The catalog signature is produced by the release-signing workflow; the local private-key signer is removed. Lock files written by 0.0.1 record the old key id, so `uifn diff` reports their entries as `catalog-mismatch`.

## 0.0.1

- Initial release, verified with the schema-v1 signature of the interim local key `af26384964522699ef39dd80`.
