# Intent Audit

## Intent Inventory

1. Create a spec to fix the root Superfunctions docs.
2. The intro page is poorly written and too minimal.
3. Package pages are poorly written and too minimal.
4. Sidebar grouping is poor and not beginner-friendly.
5. Sidebar grouping should be organized by category and scope.
6. Root docs should explain the Superfunctions mission.
7. Root docs should explain the ecosystem.
8. Root docs should link to function docs such as `datafn`, `searchfn`, and peers.
9. Root docs should go into detail for shared packages.
10. The title/heading `Superfunctions Shared` does not make sense.
11. The sidebar item `Shared packages` does not make sense.
12. Authentication-related packages should be grouped together.
13. HTTP packages and adapters should be grouped together.
14. Middleware- and storage-oriented grouping should exist.
15. Migration, legacy, and deprecation docs are not needed because the packages are not published yet.
16. Final docs must be comprehensive.
17. Final docs must be beginner-friendly.
18. Final docs must be written for the outside world rather than internal readers.
19. Shared/primitive packages should be documented for external library authors as well.
20. Example usage should be thorough.

## Coverage Mapping

| Intent ID | Intent statement | Covered in SPEC.md | Requirement IDs | Test vectors |
|---|---|---|---|---|
| 1 | Create a spec to fix the root docs | Overview, Plan | DOCS-001 through QA-002 | All vectors |
| 2 | Intro page is weak | Overview, Data formats / protocol, Semantics | DOCS-001, DOCS-003 | TV-DOCS-001 |
| 3 | Package pages are weak | Data formats / protocol, Semantics, Limits / caps | DOCS-005, DOCS-006, QA-001 | TV-DOCS-005, TV-DOCS-006, TV-QA-001 |
| 4 | Sidebar grouping is poor | Data formats / protocol, Semantics | DOCS-002 | TV-DOCS-002 |
| 5 | Grouping should be by category/scope | Data formats / protocol, Semantics | DOCS-002, DOCS-004, DOCS-007 | TV-DOCS-002, TV-DOCS-004, TV-DOCS-008 |
| 6 | Explain mission | Overview, Data formats / protocol, Semantics | DOCS-001 | TV-DOCS-001 |
| 7 | Explain ecosystem | Overview, Semantics | DOCS-003 | TV-DOCS-003 |
| 8 | Link to function docs | Semantics | DOCS-003, DOCS-009 | TV-DOCS-003, TV-DOCS-010 |
| 9 | Go deep on shared packages | Data formats / protocol, Limits / caps | DOCS-005, DOCS-006 | TV-DOCS-005, TV-DOCS-006 |
| 10 | `Superfunctions Shared` is wrong | Semantics, Invariants | DOCS-001 | TV-DOCS-001 |
| 11 | `Shared packages` sidebar item is wrong | Data formats / protocol, Invariants | DOCS-002, DOCS-008 | TV-DOCS-002, TV-DOCS-009 |
| 12 | Group auth + OAuth together | Canonical information architecture, Category-specific semantics | DOCS-002, DOCS-007 | TV-DOCS-002, TV-DOCS-008 |
| 13 | Group HTTP packages together | Canonical information architecture, Category-specific semantics | DOCS-002, DOCS-007 | TV-DOCS-002, TV-DOCS-008 |
| 14 | Group middleware/storage by scope | Canonical information architecture, Category-specific semantics | DOCS-002, DOCS-004, DOCS-007 | TV-DOCS-002, TV-DOCS-004, TV-DOCS-008 |
| 15 | Remove migrations/legacy/deprecations | Non-goals, Removal semantics, Undefined / Explicitly user-deferred only | DOCS-008 | TV-DOCS-009 |
| 16 | Docs must be comprehensive | Goals, Limits / caps | DOCS-003, DOCS-004, DOCS-005 | TV-DOCS-003, TV-DOCS-004, TV-DOCS-005 |
| 17 | Docs must be beginner-friendly | Goals, Semantics | DOCS-001, DOCS-003, DOCS-004 | TV-DOCS-001, TV-DOCS-004 |
| 18 | Docs must be outside-world focused | Goals, Semantics | DOCS-006 | TV-DOCS-007 |
| 19 | Packages should work for external library authors | Overview, Semantics | DOCS-006, DOCS-007 | TV-DOCS-007, TV-DOCS-008 |
| 20 | Example usage should be thorough | Data formats / protocol, Limits / caps | DOCS-005, DOCS-006, QA-001 | TV-DOCS-005, TV-DOCS-006, TV-QA-001 |

## Coverage status

No missing intent items.
