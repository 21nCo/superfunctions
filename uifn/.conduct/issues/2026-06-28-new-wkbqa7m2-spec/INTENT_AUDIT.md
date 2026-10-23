# Intent Audit

## Intent Inventory

1. The user asked whether all example apps can render every single component.
2. The user asked whether examples can serve both as example apps and full QA.
3. The user asked for full interactive product QA, not only static examples.
4. The user explicitly required every single component, not only popovers or overlays.
5. Prior context asked whether browser tests prove visual correctness and behavior such as dropdown position and popover edge behavior.
6. The resulting approach must cover dropdowns, popovers, modals, edge-of-screen behavior, and all other component classes.
7. The approach must support all uifn frameworks: React, Svelte, Vue, Solid, and Angular.
8. The approach should be catalog-driven to avoid framework drift.
9. The approach should use real browser testing.
10. The approach should include human-usable examples.
11. The approach should include deterministic QA routes.
12. The approach should cover components, patterns, and SF-backed panels where applicable.
13. The approach should avoid real backend dependency for SF panels.
14. The approach should become release-gate eligible.

## Coverage Map

| Intent | SPEC Coverage | Requirement IDs | Test Vectors |
| --- | --- | --- | --- |
| 1 | Goals, Public API, Full Component Inventory | WB-001, WB-002 | TV-WB-001, TV-COMP-001 |
| 2 | Overview, Goals, Workbench Generation | WB-004, QA-002 | TV-WB-002, TV-BROWSER-001 |
| 3 | Real Browser Behavior, QA Profiles | QA-002, QA-004, QA-005, QA-006 | TV-BROWSER-001, TV-FORM-001, TV-DATA-001, TV-STATIC-001 |
| 4 | Full Component Inventory | WB-002 | TV-COMP-001 |
| 5 | Overlay and Floating Placement, Visual Behavior | QA-003, QA-008 | TV-OVERLAY-001, TV-VISUAL-001 |
| 6 | QA Profiles, Overlay and Floating Placement | QA-003, QA-004, QA-005, QA-006 | TV-OVERLAY-001, TV-FORM-001, TV-DATA-001, TV-STATIC-001 |
| 7 | Public API, Framework Parity | WB-001, WB-003 | TV-WB-001, TV-FW-001 |
| 8 | Workbench Generation, Invariants | QA-001, WB-003 | TV-QA-001, TV-FW-001 |
| 9 | Real Browser Behavior | QA-002, QA-010 | TV-BROWSER-001, TV-REPORT-001 |
| 10 | Human Examples and Product Scenarios | WB-004, DOC-001 | TV-WB-002, TV-DOC-001 |
| 11 | Workbench Routes, QA Contract Shape | QA-001, QA-010 | TV-QA-001, TV-REPORT-001 |
| 12 | Patterns and SF Panels | QA-009 | TV-PATTERN-001, TV-SF-001 |
| 13 | Security, Patterns and SF Panels | SEC-001, QA-009 | TV-SEC-001, TV-SF-001 |
| 14 | Compatibility and Versioning, Release Integration | REL-001 | TV-REL-001 |

No missing intent items.
