# Intent Inventory
1. The work MUST scan the entire DataFn docs site, including page content and sidebar/navigation structure, not just one page.
2. The public docs MUST become beginner-friendly.
3. The public docs MUST become outsider-friendly for readers unfamiliar with DataFn internals.
4. The rewrite MUST remain comprehensive and thorough across the whole docs surface.
5. The rewrite MUST keep the docs clean rather than bloated or internally jargon-first.
6. Public docs MUST remove legacy details, migration guidance, compatibility windows, and deprecated API guidance because the library is unpublished and has no migration burden.
7. The docs MUST align with DataFn’s intended public positioning as a schema-driven, local-first data layer with typed client/server APIs and DFQL as the underlying language.
8. The docs MUST improve the actual entry path for first-time readers, not only leaf pages.
9. The docs MUST create a clearer separation between guides/concepts and exhaustive reference material.
10. Sharing docs MUST be improved systemically, including structure, narrative clarity, and cross-links, not only rewritten in place.
11. Generic sync docs and sharing-specific sync docs MUST be clearly separated while staying cross-linked.
12. The docs MUST stay truthful about TypeScript/Python/runtime/package support differences.
13. Public examples and snippets MUST feel real and trustworthy, ideally tied to actual examples/tests.
14. The rewrite SHOULD use the existing docs app/content stack (`meta.json`, MDX, Fumadocs) rather than assuming a platform rewrite.
15. The rewrite MUST be locally verifiable and enforceable, not dependent on subjective manual review alone.
16. Internal-only archival material MAY remain in the repo, but it MUST stay outside the public docs tree.

# Coverage Matrix
| Intent item | Covered in SPEC.md | Requirement IDs | Test vectors |
| --- | --- | --- | --- |
| 1 | Overview; Public API; Semantics; Compatibility / versioning strategy | IA-001, IA-002, IA-003, QA-002 | TV-IA-001, TV-IA-002, TV-BUILD-001 |
| 2 | Overview; Goals / Non-goals; Data formats / protocol; Semantics | IA-001, GUIDE-001, CONCEPT-001, START-001 | TV-IA-001, TV-GUIDE-001, TV-CONCEPT-001, TV-START-001 |
| 3 | Overview; Glossary; Semantics; Invariants | TERM-001, GUIDE-001, CONCEPT-001, SHARE-001 | TV-CONCEPT-001, TV-SHARE-001 |
| 4 | Overview; Goals / Non-goals; Public API; Semantics | IA-002, DFQL-001, CLI-001, REF-001, ADV-001 | TV-IA-002, TV-DFQL-001, TV-CLI-001, TV-REF-001, TV-ADV-001 |
| 5 | Goals / Non-goals; Limits/caps; Semantics | GUIDE-001, CONCEPT-001, SETUP-001, ADV-001 | TV-GUIDE-001, TV-CONCEPT-001, TV-SETUP-001, TV-ADV-001 |
| 6 | Overview; Public API; Semantics; Invariants; Compatibility / versioning strategy | LEG-001, SHARE-001, SEARCH-001, DFQL-001, QA-001 | TV-LEG-001, TV-SHARE-001, TV-SEARCH-001, TV-QA-002 |
| 7 | Overview; Goals / Non-goals; Semantics | START-001, DFQL-001, SETUP-001 | TV-START-001, TV-DFQL-001, TV-SETUP-001 |
| 8 | Overview; Public API; Semantics | IA-001, START-001 | TV-IA-001, TV-START-001 |
| 9 | Goals / Non-goals; Data formats / protocol; Semantics; Limits/caps | GUIDE-001, CONCEPT-001, REF-001, ADV-001 | TV-GUIDE-001, TV-CONCEPT-001, TV-REF-001, TV-ADV-001 |
| 10 | Public API; Semantics; Invariants | IA-003, SHARE-001 | TV-IA-002, TV-SHARE-001, TV-SHARE-002 |
| 11 | Semantics; Invariants | SYNC-001, SHARE-001 | TV-SYNC-001, TV-SHARE-002 |
| 12 | Overview; Security; Semantics; Invariants | RUNTIME-001, SETUP-001 | TV-RUNTIME-001, TV-SETUP-001 |
| 13 | Goals / Non-goals; Semantics; Invariants | EXAMPLE-001, START-001 | TV-EXAMPLE-001, TV-START-001 |
| 14 | Overview; Performance constraints; Execution Notes in PLAN.md | IA-002, QA-001 | TV-IA-002, TV-QA-001 |
| 15 | Public API; Observability; Invariants | QA-001, QA-002, META-001 | TV-QA-001, TV-QA-002, TV-BUILD-001, TV-META-001 |
| 16 | Public API; Security; Compatibility / versioning strategy | LEG-001, QA-002 | TV-LEG-001, TV-QA-002 |

# Corrective Pass
I checked the spec bundle against the extracted intent inventory after drafting the requirements and phase plan.

Corrections made during drafting:
1. Added an explicit public move/removal map in `SPEC.md` so the spec covers structural cleanup, not only page-copy rewrites.
2. Added `LEG-001` and related audit vectors so “no legacy/migrations” is enforceable instead of merely editorial advice.
3. Added `RUNTIME-001` because outsider-friendliness depends on visible TypeScript/Python truthfulness.
4. Added `EXAMPLE-001` because beginner trust depends on real examples and snippet provenance, not only nicer prose.
5. Added `QA-001` and `QA-002` so the docs overhaul remains locally verifiable after implementation.

# Result
No missing intent items.
