# SearchFn Adapter Canonical Source Policy

## Decision

- Canonical implementation path: `searchfn/adapter-*` packages.
- Compatibility path: `searchfn/adapters`.

## Rationale

- Split adapter packages are the published units (`@searchfn/adapter-memory`, `@searchfn/adapter-indexeddb`, `@searchfn/adapter-postgres`, etc.).
- Keeping full implementations in both `searchfn/adapters` and `searchfn/adapter-*` created high duplication and drift risk.
- Canonicalizing to split packages keeps ownership and test responsibility in one location.

## Rules

1. `searchfn/adapter-*` contains implementation and conformance tests.
2. `searchfn/adapters/src` is compatibility-only and must use re-exports/thin wrappers.
3. New adapter features are added only to canonical packages.
4. Legacy compatibility layer must not add independent adapter business logic.

## Compatibility Strategy

- `searchfn/adapters/src/index.ts` continues to export the historical surface.
- Individual files in `searchfn/adapters/src/*` delegate to `@searchfn/adapter-*` packages.
- Deprecated/compat-only tests in `searchfn/adapters/__tests__` are removed to prevent dual maintenance.

## Guardrails

- Duplication checks run via `npm run check:duplication`.
- SearchFn single-source checks fail if non-canonical implementation files reappear.

## Log-context redaction

`@searchfn/adapter-contracts` owns `redactSensitive` and `redactSensitiveString`. PostgreSQL, Meilisearch, Elasticsearch (including OpenSearch), and the historical `redactSearchFnLogContext` compatibility export delegate to this implementation. Security regression tests live in `adapter-contracts/__tests__`, alongside backend tests that exercise error and logger call sites. Redaction covers secret-bearing keys, credential URLs, error messages/stacks/causes, and nested objects with circular-reference handling; unrelated connection timeout settings remain visible. This is structured log sanitization, not a guarantee that arbitrary free-form text contains no secrets.
