# INTENT AUDIT

## Intent Inventory

Extracted from the conversation context:

| # | Intent Item |
|---|------------|
| 1 | Add prefix matching as a query-time option (like FlexSearch's forward tokenize) |
| 2 | Prefix and fuzzy MUST be separate options (not conflated) |
| 3 | Construct-time defaults for search options (FlexSearch pattern: defaults at construction, overrides at query time) |
| 4 | Query-time overrides always win over construct-time defaults |
| 5 | Adapters silently ignore unsupported options (no errors) |
| 6 | Capabilities advertise what each adapter supports |
| 7 | No engine-specific leakage in the contract |
| 8 | Elasticsearch adapter uses `phrase_prefix` for prefix matching |
| 9 | DataFn-provider currently drops `fuzzy` and `fieldBoosts` — must be fixed |
| 10 | Memory/IndexedDB adapters: prefix tokens already exist but are filtered out |
| 11 | Postgres adapter: `:*` operator for prefix matching (independent of fuzzy) |
| 12 | Meilisearch: prefix is always on natively — advertise capability |
| 13 | OpenSearch adapter: thin wrapper, inherits from Elasticsearch |
| 14 | Client defaults should include prefix and fieldBoosts (currently only has fuzzy) |
| 15 | Server routes should pass prefix through (already pass fuzzy/fieldBoosts) |
| 16 | No index-time changes required (prefix/fuzzy are query-time features for ES/OS) |

## Coverage Audit

| # | Intent | SPEC.md Section | Requirements | Test Vectors |
|---|--------|----------------|--------------|-------------|
| 1 | Prefix as query-time option | Public API, Semantics | CTR-001, CTR-002 | TV-CTR-001, TV-ES-001 |
| 2 | Prefix and fuzzy are separate | Semantics (Interaction between prefix and fuzzy) | ADP-001, ADP-009 | TV-ES-004, TV-PG-002 |
| 3 | Construct-time defaults | Public API (SearchDefaults), Glossary | CTR-004, CTR-005, ADP-002, ADP-006, ADP-008, ADP-010, ADP-012 | TV-ES-005, TV-MEM-003, TV-IDB-002, TV-PG-003, TV-MS-002 |
| 4 | Query-time overrides win | Semantics (Option resolution), Invariants | ADP-003 | TV-ES-006, TV-CLT-002 |
| 5 | Unsupported options silently ignored | Invariants | (implicit in all adapters) | TV-MS-001 |
| 6 | Capabilities advertise support | Public API (SearchAdapterCapabilities) | CTR-003, ADP-001, ADP-005, ADP-007, ADP-009, ADP-011 | TV-CAP-001, TV-MS-001 |
| 7 | No engine-specific leakage | Non-Goals, Public API | (contract types are engine-agnostic) | TV-CTR-001 |
| 8 | ES uses phrase_prefix | Semantics (Adapter-specific prefix implementation) | ADP-001 | TV-ES-002 |
| 9 | DataFn-provider forwards params | Public API (DataFn-provider additions) | DFP-001 | TV-DFP-001, TV-DFP-002 |
| 10 | Memory/IDB prefix tokens | Semantics (Adapter-specific prefix implementation) | ADP-005, ADP-007 | TV-MEM-001, TV-MEM-002, TV-IDB-001 |
| 11 | Postgres `:*` operator | Semantics (Adapter-specific prefix implementation) | ADP-009 | TV-PG-001, TV-PG-002 |
| 12 | Meilisearch prefix natively on | Semantics (Adapter-specific prefix implementation) | ADP-011 | TV-MS-001 |
| 13 | OpenSearch inherits from ES | N/A (architecture) | ADP-004 | (inherits TV-ES-* via test inheritance) |
| 14 | Client defaults for prefix/fieldBoosts | Public API (Client additions) | CLT-001, CLT-002 | TV-CLT-001, TV-CLT-002 |
| 15 | Server routes pass prefix | Public API (Server additions) | SRV-001, SRV-002 | TV-SRV-001, TV-SRV-002 |
| 16 | No index-time changes | Non-Goals | N/A | N/A |

## Result

**No missing intent items.** All 16 intent items are covered by spec sections, requirements, and test vectors.
