# Intent Audit

## Intent Inventory
1. `RC-1`: SearchProvider contract currently drops `prefix`, `fuzzy`, and `fieldBoosts` at DataFn type boundaries and must be fixed.
2. `RC-2`: `client.search()` currently drops these options and must forward them.
3. `RC-3`: Server per-resource query search currently drops these options and must forward them.
4. `RC-4`: Server cross-resource search execution currently drops these options and must forward them.
5. `RC-5`: Server `/datafn/search` route currently does not parse/forward these options and must do so.
6. `RC-6`: Client-side local mutations must update search indices immediately (not only clone/pull sync ingestion).
7. `RC-7`: Client has disconnected search systems (`clientSearch` MiniSearch and `searchProvider`) and must be unified.
8. `RC-8`: SearchFn IndexedDB adapter must be usable client-side with parity options (prefix/fuzzy/field boosts) like server Elasticsearch/OpenSearch usage.
9. Search behavior must default to local in offline-first sync scenarios.
10. Explicit remote search path should remain possible for seamless local/server operation.
11. Existing optional behavior must remain backward compatible (new fields optional).
12. Deterministic result ordering must remain stable.
13. Existing clone/pull search indexing lifecycle must not regress.
14. Search index update failures must not block mutation success.
15. New option fields require canonical validation/error behavior.
16. This spec must close DataFn caller gaps not covered by searchfn spec `2026-03-12-change-p7x3k9m2-spec`.
17. Todo example app must be updated where necessary to demonstrate working search both locally and on server.
18. Testing must explicitly cover prefix/fuzzy/fieldBoosts behavior, lifecycle updates, and boundary forwarding.
19. Search documentation must reflect the provider-backed local-first model and plugin deprecation state.
20. Scope must be complete with no deferred issue items.

## File-Level Boundary Checklist
| RC ID | File-level boundary | Locked requirement IDs | Locked vectors |
|---|---|---|---|
| RC-1 | `datafn/core/src/search-provider.ts`, `datafn/server/src/search-provider.ts` | CON-001 | TV-CON-001-P, TV-CON-001-N |
| RC-2 | `datafn/client/src/client.ts` | CON-003, CLI-001, CLI-002, CLI-003 | TV-CON-003-P, TV-CON-003-N, TV-CLI-001-P, TV-CLI-001-N, TV-CLI-002-P, TV-CLI-002-N, TV-CLI-003-P, TV-CLI-003-N |
| RC-3 | `datafn/server/src/execution/query/search.ts`, `datafn/server/src/execution/query/dfql.ts` | CON-002, SRV-001 | TV-CON-002-P, TV-CON-002-N, TV-SRV-001-P, TV-SRV-001-N |
| RC-4 | `datafn/server/src/execution/search/cross-resource.ts` | CON-002, SRV-001 | TV-CON-002-P, TV-CON-002-N, TV-SRV-001-P, TV-SRV-001-N |
| RC-5 | `datafn/server/src/routes/search.ts` | CON-003, SRV-002 | TV-CON-003-P, TV-CON-003-N, TV-SRV-002-P, TV-SRV-002-N |
| RC-6 | `datafn/client/src/mutate.ts`, `datafn/client/src/client.ts` | IDX-001, IDX-002 | TV-IDX-001-P, TV-IDX-001-N, TV-IDX-002-P, TV-IDX-002-N |
| RC-7 | `datafn/client/src/plugins/clientSearch.ts` | UNI-001, UNI-002 | TV-UNI-001-P, TV-UNI-001-N, TV-UNI-002-P, TV-UNI-002-N |
| RC-8 | `searchfn/.conduct/specs/2026-03-12-change-p7x3k9m2-spec/SPEC.md` + DataFn caller boundaries | CON-001, CON-002, CON-003, TST-001 | TV-CON-001-P, TV-CON-001-N, TV-CON-002-P, TV-CON-002-N, TV-CON-003-P, TV-CON-003-N, TV-TST-001-P, TV-TST-001-N |

## Coverage Mapping
| Intent # | Covered in SPEC.md | Requirement IDs | Test vectors |
|---|---|---|---|
| 1 | Public API; Semantics (Option propagation) | CON-001 | TV-CON-001-P, TV-CON-001-N |
| 2 | Semantics (Option propagation); Data formats/protocol | CLI-002 | TV-CLI-002-P, TV-CLI-002-N |
| 3 | Semantics (Option propagation) | CON-002, SRV-001 | TV-CON-002-P, TV-SRV-001-P |
| 4 | Public API; Semantics (Option propagation) | CON-002, SRV-001 | TV-CON-002-P, TV-SRV-001-P |
| 5 | Data formats/protocol; Semantics; Security | CON-003, SRV-002 | TV-CON-003-P, TV-SRV-002-P |
| 6 | Semantics (Client index lifecycle) | IDX-001 | TV-IDX-001-P, TV-IDX-001-N |
| 7 | Semantics (Client search unification) | UNI-001, UNI-002 | TV-UNI-001-P, TV-UNI-002-P |
| 8 | Goals; Semantics; Example semantics | CLI-002, EX-001 | TV-CLI-002-P, TV-EX-001-P |
| 9 | Goals; Semantics (Client search routing) | CLI-003 | TV-CLI-003-P, TV-CLI-003-N |
| 10 | Semantics (Client search routing); Example semantics | CLI-003, EX-001 | TV-CLI-003-P, TV-EX-001-N |
| 11 | Invariants; Compatibility/versioning strategy | CON-003, CLI-001 | TV-CON-003-P, TV-CLI-001-P |
| 12 | Invariants | SRV-001 | TV-SRV-001-P, TV-SRV-001-N |
| 13 | Invariants; Semantics (Client index lifecycle) | IDX-001 | TV-IDX-001-P, TV-TST-001-P |
| 14 | Semantics (Fail-soft lifecycle); Observability | IDX-002 | TV-IDX-002-P, TV-IDX-002-N |
| 15 | Data formats/protocol; Security | CLI-001, SRV-002 | TV-CLI-001-N, TV-SRV-002-N |
| 16 | Overview; Compatibility/versioning strategy | SRV-001, TST-001 | TV-SRV-001-P, TV-TST-001-P |
| 17 | Semantics (Todo example); Goals | EX-001 | TV-EX-001-P, TV-EX-001-N |
| 18 | Goals; Requirements testing scope | TST-001 | TV-TST-001-P, TV-TST-001-N |
| 19 | Observability; Compatibility/versioning strategy | DOC-001 | TV-DOC-001-P, TV-DOC-001-N |
| 20 | Overview (Hard constraints); Undefined section | CON-001, TST-001 | TV-TST-001-P, TV-TST-001-N |

## Completeness Result
No missing intent items and no unresolved scope ambiguities.

Corrective edits made during audit pass:
1. Added explicit `source` override semantics to preserve remote usability while meeting local-first default intent.
2. Added explicit plugin unification + compatibility requirement split (`UNI-001`, `UNI-002`) to fully resolve RC-7 without breaking existing users.
3. Added docs requirement (`DOC-001`) so user-facing guidance matches runtime behavior.
