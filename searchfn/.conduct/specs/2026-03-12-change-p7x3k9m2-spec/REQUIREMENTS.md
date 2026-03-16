# REQUIREMENTS

## Table of Contents

| ID | Priority | Summary |
|----|----------|---------|
| CTR-001 | P0 | Add `prefix` to SearchParams |
| CTR-002 | P0 | Add `prefix` to SearchAllParams |
| CTR-003 | P0 | Add `prefix` to SearchAdapterCapabilities |
| CTR-004 | P0 | Add SearchDefaults type |
| CTR-005 | P0 | Add defaults to SearchAdapterConfig |
| ADP-001 | P0 | Elasticsearch adapter: support prefix matching |
| ADP-002 | P0 | Elasticsearch adapter: accept SearchDefaults |
| ADP-003 | P0 | Elasticsearch adapter: resolve options with resolution order |
| ADP-004 | P0 | OpenSearch adapter: inherit prefix support |
| ADP-005 | P1 | Memory adapter: support prefix matching |
| ADP-006 | P1 | Memory adapter: accept SearchDefaults |
| ADP-007 | P1 | IndexedDB adapter: support prefix matching |
| ADP-008 | P1 | IndexedDB adapter: accept SearchDefaults |
| ADP-009 | P1 | Postgres adapter: support prefix matching |
| ADP-010 | P1 | Postgres adapter: accept SearchDefaults |
| ADP-011 | P1 | Meilisearch adapter: advertise prefix capability |
| ADP-012 | P1 | Meilisearch adapter: accept SearchDefaults |
| CLT-001 | P0 | Client SearchClientDefaults: add prefix and fieldBoosts |
| CLT-002 | P0 | Client: resolve prefix using defaults |
| SRV-001 | P0 | Server search route: pass prefix |
| SRV-002 | P0 | Server searchAll route: pass prefix |
| DFP-001 | P0 | DataFn-provider: forward fuzzy, prefix, fieldBoosts |

---

## CTR-001 — Add `prefix` to SearchParams

- **Priority**: P0
- **Statement**: The `SearchParams` interface in `@searchfn/adapter-contracts` MUST include an optional `prefix?: boolean` field.
- **Rationale**: Prefix matching is a fundamental search feature that is currently missing from the contract.
- **Acceptance criteria**:
  - `SearchParams` type includes `prefix?: boolean`
  - Field is optional (existing code compiles without changes)
  - TypeScript compilation succeeds across all dependent packages
- **Test vectors**: TV-CTR-001, TV-CTR-002
- **Notes**: No default value in the type — resolution is handled by adapters/client.

---

## CTR-002 — Add `prefix` to SearchAllParams

- **Priority**: P0
- **Statement**: The `SearchAllParams` interface in `@searchfn/adapter-contracts` MUST include an optional `prefix?: boolean` field.
- **Rationale**: Same as CTR-001, for cross-resource search.
- **Acceptance criteria**:
  - `SearchAllParams` type includes `prefix?: boolean`
  - Field is optional
- **Test vectors**: TV-CTR-003, TV-CTR-004
- **Notes**: None.

---

## CTR-003 — Add `prefix` to SearchAdapterCapabilities

- **Priority**: P0
- **Statement**: The `SearchAdapterCapabilities` interface MUST include an optional `prefix?: boolean` field.
- **Rationale**: Callers need to check if an adapter supports prefix matching.
- **Acceptance criteria**:
  - `SearchAdapterCapabilities` type includes `prefix?: boolean`
  - Each adapter sets this correctly in its `capabilities` object
- **Test vectors**: TV-CAP-001
- **Notes**: None.

---

## CTR-004 — Add SearchDefaults type

- **Priority**: P0
- **Statement**: `@searchfn/adapter-contracts` MUST export a `SearchDefaults` interface with optional `fuzzy?: boolean | number`, `prefix?: boolean`, and `fieldBoosts?: Record<string, number>`.
- **Rationale**: Provides a shared type for construct-time default search behavior across adapters and clients.
- **Acceptance criteria**:
  - `SearchDefaults` is exported from `@searchfn/adapter-contracts`
  - Type has all three fields, all optional
- **Test vectors**: N/A (type-only)
- **Notes**: None.

---

## CTR-005 — Add defaults to SearchAdapterConfig

- **Priority**: P0
- **Statement**: The `SearchAdapterConfig` interface MUST include an optional `defaults?: SearchDefaults` field.
- **Rationale**: Adapters that accept `SearchAdapterConfig` (Memory, IndexedDB) can use this for construct-time defaults.
- **Acceptance criteria**:
  - `SearchAdapterConfig` type includes `defaults?: SearchDefaults`
- **Test vectors**: N/A (type-only)
- **Notes**: None.

---

## ADP-001 — Elasticsearch adapter: support prefix matching

- **Priority**: P0
- **Statement**: The `ElasticsearchAdapter` MUST support `prefix: true` by adding a `multi_match` with `type: "phrase_prefix"` as a `bool.should` clause alongside the existing `multi_match` query, in both `search()` and `searchAll()`.
- **Rationale**: This is the primary adapter experiencing the prefix matching gap (user-reported issue).
- **Acceptance criteria**:
  - When `prefix: true`, the ES query body uses `bool.should` with both `multi_match` (default) and `multi_match` with `type: "phrase_prefix"`
  - When `prefix: false` or omitted (and no default), the query remains a single `multi_match` (current behavior)
  - When `prefix: true` AND `fuzzy: true`, three `should` clauses are emitted
  - `capabilities.prefix` is set to `true`
- **Test vectors**: TV-ES-001, TV-ES-002, TV-ES-003, TV-ES-004
- **Notes**: `minimum_should_match: 1` on the `bool` query.

---

## ADP-002 — Elasticsearch adapter: accept SearchDefaults

- **Priority**: P0
- **Statement**: `ElasticsearchAdapterOptions` MUST include an optional `defaults?: SearchDefaults` field. The adapter MUST store these defaults and use them in the resolution order.
- **Rationale**: Allows users to set prefix/fuzzy defaults at adapter construction time.
- **Acceptance criteria**:
  - `ElasticsearchAdapterOptions` includes `defaults?: SearchDefaults`
  - Defaults are stored and used when query params don't specify the option
- **Test vectors**: TV-ES-005
- **Notes**: None.

---

## ADP-003 — Elasticsearch adapter: resolve options with resolution order

- **Priority**: P0
- **Statement**: For every search call, the Elasticsearch adapter MUST resolve `fuzzy`, `prefix`, and `fieldBoosts` using the resolution order: `params.<option> ?? this.defaults.<option> ?? off`.
- **Rationale**: Ensures consistent, predictable behavior.
- **Acceptance criteria**:
  - Query-time `prefix: false` overrides a construct-time `prefix: true`
  - Query-time `prefix: true` works even when no construct-time default is set
  - Omitting both uses `false` (off)
- **Test vectors**: TV-ES-005, TV-ES-006
- **Notes**: None.

---

## ADP-004 — OpenSearch adapter: inherit prefix support

- **Priority**: P0
- **Statement**: The `OpenSearchAdapter` MUST inherit prefix support from the `ElasticsearchAdapter` without additional changes, and `OpenSearchAdapterOptions` MUST include `defaults?: SearchDefaults`.
- **Rationale**: OpenSearch adapter is a thin wrapper; it inherits all behavior.
- **Acceptance criteria**:
  - `OpenSearchAdapterOptions` includes `defaults?: SearchDefaults`
  - `capabilities.prefix` is `true`
  - Prefix matching works identically to Elasticsearch adapter
- **Test vectors**: TV-ES-001 (via inheritance)
- **Notes**: None.

---

## ADP-005 — Memory adapter: support prefix matching

- **Priority**: P1
- **Statement**: The `MemoryAdapter` MUST support `prefix: true` by including prefix-flagged tokens in query results (currently filtered out in `buildQueryTokens`).
- **Rationale**: Consistency across all adapters.
- **Acceptance criteria**:
  - When `prefix: true`, prefix tokens are included in query token matching
  - When `prefix: false` or omitted, behavior is unchanged (tokens filtered out)
  - `capabilities.prefix` is set to `true`
- **Test vectors**: TV-MEM-001, TV-MEM-002
- **Notes**: The core pipeline already generates prefix tokens; this just stops filtering them out.

---

## ADP-006 — Memory adapter: accept SearchDefaults

- **Priority**: P1
- **Statement**: The `MemoryAdapter` MUST read `defaults` from `SearchAdapterConfig` and use them in the resolution order.
- **Rationale**: Memory adapter already accepts `SearchAdapterConfig` which will include `defaults`.
- **Acceptance criteria**:
  - Construct-time `defaults.prefix` is used when query param is omitted
  - Construct-time `defaults.fuzzy` is used when query param is omitted
  - Construct-time `defaults.fieldBoosts` is used when query param is omitted
- **Test vectors**: TV-MEM-003
- **Notes**: None.

---

## ADP-007 — IndexedDB adapter: support prefix matching

- **Priority**: P1
- **Statement**: The `IndexedDbAdapter` MUST support `prefix: true` with the same semantics as the Memory adapter.
- **Rationale**: IndexedDB adapter shares the same pipeline engine as Memory.
- **Acceptance criteria**:
  - Same as ADP-005 but for IndexedDB adapter
  - `capabilities.prefix` is set to `true`
- **Test vectors**: TV-IDB-001
- **Notes**: None.

---

## ADP-008 — IndexedDB adapter: accept SearchDefaults

- **Priority**: P1
- **Statement**: `IndexedDbAdapterOptions` MUST accept `defaults?: SearchDefaults`, and the adapter MUST use them in the resolution order.
- **Rationale**: Consistency.
- **Acceptance criteria**:
  - Same as ADP-006 but for IndexedDB adapter
- **Test vectors**: TV-IDB-002
- **Notes**: None.

---

## ADP-009 — Postgres adapter: support prefix matching

- **Priority**: P1
- **Statement**: The `PostgresAdapter` MUST support `prefix: true` by appending the `:*` prefix operator to each lexeme in the generated tsquery.
- **Rationale**: Postgres already does this when `fuzzy: true`; prefix should be an independent trigger.
- **Acceptance criteria**:
  - When `prefix: true` (and `fuzzy: false`), the tsquery uses `:*` suffix on lexemes
  - When both `prefix: true` and `fuzzy: true`, same `:*` behavior (no duplication)
  - `capabilities.prefix` is set to `true`
- **Test vectors**: TV-PG-001, TV-PG-002
- **Notes**: Currently prefix and fuzzy map to the same Postgres mechanism.

---

## ADP-010 — Postgres adapter: accept SearchDefaults

- **Priority**: P1
- **Statement**: `PostgresAdapterOptions` MUST accept `defaults?: SearchDefaults`, and the adapter MUST use them in the resolution order.
- **Rationale**: Consistency.
- **Acceptance criteria**:
  - Same resolution order as other adapters
- **Test vectors**: TV-PG-003
- **Notes**: None.

---

## ADP-011 — Meilisearch adapter: advertise prefix capability

- **Priority**: P1
- **Statement**: The `MeilisearchAdapter` MUST set `capabilities.prefix = true` since Meilisearch handles prefix matching natively. The `prefix` param MAY be a no-op.
- **Rationale**: Meilisearch always does prefix matching; the capability should be advertised.
- **Acceptance criteria**:
  - `capabilities.prefix` is `true`
  - Passing `prefix: true` or `prefix: false` does not cause errors
- **Test vectors**: TV-MS-001
- **Notes**: Meilisearch's prefix behavior is built-in and not toggleable.

---

## ADP-012 — Meilisearch adapter: accept SearchDefaults

- **Priority**: P1
- **Statement**: `MeilisearchAdapterOptions` MUST accept `defaults?: SearchDefaults`, and the adapter MUST use them in the resolution order.
- **Rationale**: Consistency.
- **Acceptance criteria**:
  - Same resolution order as other adapters
- **Test vectors**: TV-MS-002
- **Notes**: None.

---

## CLT-001 — Client SearchClientDefaults: add prefix and fieldBoosts

- **Priority**: P0
- **Statement**: `SearchClientDefaults` in `@searchfn/client` MUST include optional `prefix?: boolean` and `fieldBoosts?: Record<string, number>` fields.
- **Rationale**: The client already has `fuzzy` defaults but is missing `prefix` and `fieldBoosts`.
- **Acceptance criteria**:
  - Type includes both new fields
  - Existing code compiles without changes
- **Test vectors**: TV-CLT-001
- **Notes**: None.

---

## CLT-002 — Client: resolve prefix using defaults

- **Priority**: P0
- **Statement**: The `createSearchClient` function MUST resolve `prefix` and `fieldBoosts` using `params.<option> ?? defaults.<option>` before passing to the adapter, consistent with how `fuzzy` is already resolved.
- **Rationale**: Client should apply defaults consistently for all options.
- **Acceptance criteria**:
  - `search()` passes resolved `prefix` and `fieldBoosts` to adapter
  - `searchAll()` passes resolved `prefix` and `fieldBoosts` to adapter
  - Query-time value overrides default
- **Test vectors**: TV-CLT-001, TV-CLT-002
- **Notes**: None.

---

## SRV-001 — Server search route: pass prefix

- **Priority**: P0
- **Statement**: The search route handler MUST read `body.prefix` and pass it to `adapter.search()`.
- **Rationale**: The server already passes fuzzy and fieldBoosts; prefix must be added.
- **Acceptance criteria**:
  - `prefix` is included in the adapter call
  - Invalid `prefix` values (non-boolean) are ignored (cast via `as boolean | undefined`)
- **Test vectors**: TV-SRV-001
- **Notes**: None.

---

## SRV-002 — Server searchAll route: pass prefix

- **Priority**: P0
- **Statement**: The searchAll route handler MUST read `body.prefix` and pass it to `adapter.searchAll()` and the fallback `adapter.search()` calls.
- **Rationale**: Same as SRV-001 for cross-resource search.
- **Acceptance criteria**:
  - `prefix` is included in both the native `searchAll` call and the fallback per-resource `search` calls
- **Test vectors**: TV-SRV-002
- **Notes**: None.

---

## DFP-001 — DataFn-provider: forward fuzzy, prefix, fieldBoosts

- **Priority**: P0
- **Statement**: The `createSearchProvider` function in `@searchfn/datafn-provider` MUST forward `fuzzy`, `prefix`, and `fieldBoosts` from the incoming `params` to the adapter's `search()` and `searchAll()` calls.
- **Rationale**: Currently the provider silently drops `fuzzy` and `fieldBoosts`, making them unusable from DataFn.
- **Acceptance criteria**:
  - `adapter.search()` receives `fuzzy`, `prefix`, `fieldBoosts` from the provider's `search()` params
  - `adapter.searchAll()` receives `fuzzy`, `prefix`, `fieldBoosts` from the provider's `searchAll()` params
  - Existing tests pass
- **Test vectors**: TV-DFP-001, TV-DFP-002
- **Notes**: The provider uses `as any` casts — the forwarding should work through these casts.
