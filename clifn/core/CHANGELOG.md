# Changelog

## 0.2.0

- Added the consumer compatibility baseline (CLI-11): `tests/consumer-contract.table.ts` lists every `@clifn/core` import that `@extfn/cli`, `@plugfn/cli`, `@mailfn/cli`, `@devfn/cli` and `@devfn/config` use; `consumer-contract.test.ts` checks each runtime symbol's kind from the built subpath, `consumer-contract.test-d.ts` checks the types and option shapes those consumers rely on, and `consumer-scan.test.ts` fails when a consumer imports a symbol or subpath the table does not list.
- Declared `engines.node` `>=20`.
- Added a `typecheck` script; `test` now runs once (`vitest run`) and includes the type-level contract tests.
- No export, default or output changed.

## 0.1.0

- Added a Conduct v0.3 compatibility note documenting stable public subpath imports.
- Confirmed public import guidance for `credentials`, `config`, `client`, `ui`, `stdio`, and `prompt`.
