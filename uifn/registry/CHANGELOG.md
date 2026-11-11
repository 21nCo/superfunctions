# Changelog

## 0.0.2

- Breaking: the bundled catalog is verified only with the schema-v2 signature envelope. The verifier recomputes the catalog SHA-256 and the signed input `UTF8("uifn-registry-v2\0") || SHA-256(catalog-bytes)` itself, and rejects schema v1, another domain, key id or algorithm, a digest mismatch and malformed envelopes with `UIFN_REGISTRY_SIGNATURE_INVALID` and a `reason`.
- The trust root is the AWS KMS release-signing key, key id `a72cc93c0e85e7af79cf582c`. The catalog signature is produced by the release-signing workflow; the local private-key signer is removed. Lock files written by 0.0.1 record the old key id, so `uifn diff` reports their entries as `catalog-mismatch`.

## 0.0.1

- Initial release, verified with the schema-v1 signature of the interim local key `af26384964522699ef39dd80`.
