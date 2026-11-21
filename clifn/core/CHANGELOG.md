# Changelog

## 0.2.0

- Added the consumer compatibility baseline (CLI-11): `tests/consumer-contract.table.ts` lists every `@clifn/core` import that `@extfn/cli`, `@plugfn/cli`, `@mailfn/cli`, `@devfn/cli` and `@devfn/config` use; `consumer-contract.test.ts` checks each runtime symbol's kind from the built subpath, `consumer-contract.test-d.ts` checks the types and option shapes those consumers rely on, and `consumer-scan.test.ts` fails when a consumer imports a symbol or subpath the table does not list.
- Declared `engines.node` `>=20`. The runtime `ini` dependency moves from `^5.0.0` to `^4.1.3`, whose engines admit every Node 20 release; `ini` 5.0.0 only narrowed the engines range to `^18.17.0 || >=20.5.0` and ships the same code.
- Added a `typecheck` script; `test` now runs once (`vitest run`) and includes the type-level contract tests.
- No export, default or output changed.

## 0.1.0

- Added a Conduct v0.3 compatibility note documenting stable public subpath imports.
- Confirmed public import guidance for `credentials`, `config`, `client`, `ui`, `stdio`, and `prompt`.
