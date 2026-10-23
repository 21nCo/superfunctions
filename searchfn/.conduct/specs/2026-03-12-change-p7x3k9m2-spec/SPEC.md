# SPEC: Search Query Options — Construct-Time Defaults & Query-Time Overrides

## Metadata

| Key | Value |
|-----|-------|
| Timestamp | 2026-03-12T06:30:00Z |
| agent_name | unknown-agent |
| Model | claude-opus-4-6 |
| Launcher | VS Code |
| Workspace | /Users/serro/Documents/dev/n/superfunctions |
| OS + Shell | Darwin 25.3.0 / zsh |
| Git Branch | next |
| Git Commit | 5fe59b6 (dirty) |
| spec_folder | 2026-03-12-change-p7x3k9m2-spec |
| spec_type | change |
| spec_id | p7x3k9m2 |
| Input Paths | Discussion context (no external docs) |

---

## Overview

Add `prefix` as a first-class query option to the SearchFn adapter contract, introduce construct-time `SearchDefaults` so adapters and clients can declare default search behavior, and ensure the full option set (`fuzzy`, `prefix`, `fieldBoosts`) flows through every layer: adapter-contracts → each adapter → client → server → datafn-provider.

Currently the adapter contract defines `fuzzy` and `fieldBoosts` on `SearchParams`/`SearchAllParams`, but:
- There is no `prefix` option at all.
- The Elasticsearch/OpenSearch adapter ignores `prefix` (doesn't exist) and hardcodes query construction.
- The datafn-provider silently drops `fuzzy` and `fieldBoosts` when calling adapters.
- The client's `SearchClientDefaults` has `fuzzy` but not `prefix` or `fieldBoosts`.
- There is no construct-time default mechanism at the adapter level.

This spec adds the missing pieces so that search behavior follows the pattern: **query param wins → construct-time default → off**.

---

## Glossary

| Term | Definition |
|------|-----------|
| **Prefix matching** | Query term "to" matches indexed term "todo" by matching the beginning of the term. |
| **Fuzzy matching** | Query term "tood" matches "todo" via edit-distance tolerance (Levenshtein, typo tolerance, etc.). |
| **Field boost** | A per-field score multiplier that increases/decreases a field's weight in relevance scoring. |
| **Construct-time default** | A search option value set when an adapter or client is instantiated; used when the query does not specify the option. |
| **Query-time override** | A search option value passed in a specific `search()`/`searchAll()` call; takes precedence over defaults. |
| **Resolution order** | query param → construct-time default → `false`/`undefined` (off). |

---

## Goals

1. Add `prefix?: boolean` to the adapter contract's `SearchParams` and `SearchAllParams`.
2. Add `prefix?: boolean` to `SearchAdapterCapabilities` so adapters can advertise support.
3. Introduce `SearchDefaults` type with `fuzzy`, `prefix`, `fieldBoosts` — usable at both adapter and client construct-time.
4. Each adapter resolves options using the resolution order, then maps to engine-native queries.
5. The datafn-provider MUST forward `fuzzy`, `prefix`, and `fieldBoosts` to the adapter.
6. The searchfn client's `SearchClientDefaults` MUST include `prefix` and `fieldBoosts`.
7. The searchfn server routes already pass `fuzzy` and `fieldBoosts` — they MUST also pass `prefix`.
8. Existing tests MUST continue to pass; new tests MUST cover prefix behavior.

## Non-Goals

- Changing how any adapter indexes data (no analyzer changes, no index-time tokenizer config changes).
- Adding new search modes beyond prefix (e.g., wildcard, regex, ngram substring).
- Breaking the existing `SearchAdapter` interface (all additions are optional fields).
- Modifying the `@searchfn/core` pipeline or BM25 scoring.

---

## Public API

### adapter-contracts additions

```typescript
// SearchParams — add prefix
export interface SearchParams {
  resource: string;
  query: string;
  fields?: string[];
  limit?: number;
  fuzzy?: boolean | number;
  prefix?: boolean;                          // NEW
  fieldBoosts?: Record<string, number>;
  signal?: AbortSignal;
}

// SearchAllParams — add prefix
export interface SearchAllParams {
  query: string;
  resources?: string[];
  fields?: string[];
  limit?: number;
  limitPerResource?: number;
  fuzzy?: boolean | number;
  prefix?: boolean;                          // NEW
  fieldBoosts?: Record<string, number>;
  signal?: AbortSignal;
}

// SearchAdapterCapabilities — add prefix
export interface SearchAdapterCapabilities {
  persistent?: boolean;
  searchAll?: boolean;
  fuzzy?: boolean;
  prefix?: boolean;                          // NEW
  fieldBoosts?: boolean;
  maxBatchSize?: number;
}

// SearchDefaults — NEW type for construct-time defaults
export interface SearchDefaults {
  fuzzy?: boolean | number;
  prefix?: boolean;
  fieldBoosts?: Record<string, number>;
}

// SearchAdapterConfig — add defaults
export interface SearchAdapterConfig {
  pipeline?: import("@searchfn/core").PipelineOptions;
  defaults?: SearchDefaults;                 // NEW
}
```

### Per-adapter construct-time options

Each adapter that accepts construct-time options MUST accept `defaults?: SearchDefaults` in its options type. The adapter MUST resolve each query option as: `params.<option> ?? this.defaults.<option> ?? <off>`.

### Client additions

```typescript
export interface SearchClientDefaults {
  limit?: number;
  limitPerResource?: number;
  fuzzy?: boolean | number;
  prefix?: boolean;                          // NEW
  fieldBoosts?: Record<string, number>;      // NEW
}
```

### Server additions

The server search routes MUST read `body.prefix` from the request and pass it to the adapter.

### DataFn-provider additions

`createSearchProvider` MUST forward `fuzzy`, `prefix`, and `fieldBoosts` from the incoming params to the adapter's `search()` and `searchAll()` calls.

---

## Semantics

### Option resolution

For every search call, each option is resolved as:

```
effective_value = query_param ?? adapter_default ?? off
```

Where `off` means:
- `fuzzy`: `undefined` (no fuzziness)
- `prefix`: `false` (no prefix matching)
- `fieldBoosts`: `undefined` (uniform weighting)

### Adapter-specific prefix implementation

| Adapter | `prefix: true` behavior |
|---------|------------------------|
| **Memory** | Include prefix-flagged tokens in query results (currently filtered out in `buildQueryTokens`). |
| **IndexedDB** | Same as Memory (shares pipeline engine). |
| **Postgres** | Append `:*` prefix operator to each lexeme in the tsquery (same mechanism already used when `fuzzy: true`). |
| **Elasticsearch/OpenSearch** | Add a `multi_match` with `type: "phrase_prefix"` as a `bool.should` clause alongside the existing `multi_match`. |
| **Meilisearch** | No-op (Meilisearch handles prefix matching natively; always on). Set `capabilities.prefix = true`. |

### Interaction between prefix and fuzzy

`prefix` and `fuzzy` are independent options. When both are `true`:
- Memory/IndexedDB: apply both Levenshtein expansion AND prefix token inclusion.
- Postgres: append `:*` to lexemes (covers both prefix and fuzzy for this engine).
- Elasticsearch/OpenSearch: emit three `should` clauses: exact `multi_match`, `phrase_prefix`, and `multi_match` with `fuzziness: "AUTO"`.
- Meilisearch: enable typo tolerance (fuzzy) + prefix is always on.

---

## Invariants

1. **Backward compatibility**: All new fields are optional. Existing code that does not pass `prefix` or `defaults` MUST continue to work identically.
2. **Resolution order is deterministic**: query param always wins over construct default.
3. **Unsupported options are silently ignored**: If an adapter does not support `prefix`, passing `prefix: true` MUST NOT cause an error — it is simply ignored.
4. **Capabilities reflect truth**: An adapter's `capabilities.prefix` MUST be `true` only if the adapter meaningfully implements prefix matching.

---

## Security

No new security considerations. All existing validation (query length, limit bounds, resource name validation) remains unchanged.

---

## Limits/Caps

No changes to existing limits.

---

## Observability

- Adapters with a `logger` option SHOULD log when prefix/fuzzy defaults are applied (debug level).
- The Elasticsearch adapter's existing logger integration MUST continue to work.

---

## Compatibility / Versioning

- This is a **backward-compatible, additive change** to all packages.
- All new fields are optional — no semver major bump required.
- Recommended version bumps: patch for contracts, adapters, client, server, datafn-provider.

---

## Undefined / Explicitly Deferred

- Index-time analyzer configuration for Elasticsearch/OpenSearch (e.g., custom tokenizers, edge-ngram analyzers) — out of scope.
- `suggest` mode (FlexSearch-style phrase suggestion fallback) — out of scope.
- Numeric fuzzy distance (`fuzzy: 2`) support varies by adapter — no change to current behavior.
