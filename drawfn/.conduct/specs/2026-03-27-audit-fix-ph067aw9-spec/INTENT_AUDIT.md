# Intent Inventory

1. Create a detailed fix spec under `drawfn/.conduct`.
2. The spec MUST target the issues identified in `drawfn/.conduct/audits/2026-03-26-srwfzazr-full-audit.md`.
3. Scope MUST be limited to drawfn core, React adapter, Svelte adapter, packaging, docs, tests, and release readiness.
4. The fix bundle MUST improve production readiness for drawfn-only single-user drawing flows.
5. Packaging and docs inconsistencies MUST be fixed.
6. Scene loading, serialization, and freedraw correctness MUST be fixed.
7. Gesture history granularity and event emission semantics MUST be fixed.
8. Selection, marquee, zoom, shortcut safety, and pointer completion behavior MUST be fixed.
9. Text editing correctness MUST be fixed.
10. Rendering, async image behavior, and export correctness MUST be fixed.
11. React and Svelte controlled/uncontrolled wrapper correctness MUST be fixed.
12. Release verification and test coverage MUST be strengthened.
13. Nucleus migration and anything related to Nucleus MUST NOT be part of this spec.

# Coverage Audit

| Intent item | Covered in SPEC.md | Requirement IDs | Test vectors |
| --- | --- | --- | --- |
| 1 | `Overview`; metadata | `QA-001` | `TV-QA-001`, `TV-QA-002` |
| 2 | `Overview`; `Goals / Non-goals`; `Compatibility / versioning strategy` | `SURFACE-001`, `SURFACE-002`, `SCENE-001`, `SCENE-002`, `HISTORY-001`, `EVENTS-001`, `INPUT-001`, `INPUT-002`, `TEXT-001`, `RENDER-001`, `EXPORT-001`, `REACT-001`, `SVELTE-001`, `OBS-001`, `QA-001` | all vectors referenced by those requirements |
| 3 | `Overview`; `Goals / Non-goals` | `BOUNDARY-001`, `SURFACE-001`, `SURFACE-002`, `REACT-001`, `SVELTE-001`, `QA-001` | `TV-BOUNDARY-001`, `TV-BOUNDARY-002`, `TV-SURFACE-001`, `TV-SURFACE-003`, `TV-REACT-001`, `TV-SVELTE-001`, `TV-QA-001` |
| 4 | `Overview`; `Semantics`; `Limits/caps` | `SCENE-001`, `SCENE-002`, `HISTORY-001`, `EVENTS-001`, `INPUT-001`, `INPUT-002`, `TEXT-001`, `RENDER-001`, `EXPORT-001`, `QA-001` | `TV-SCENE-001` to `TV-QA-002` as applicable |
| 5 | `Public API`; `Compatibility / versioning strategy` | `SURFACE-001`, `SURFACE-002` | `TV-SURFACE-001`, `TV-SURFACE-002`, `TV-SURFACE-003`, `TV-SURFACE-004` |
| 6 | `Data formats / protocol`; `Semantics`; `Invariants` | `SCENE-001`, `SCENE-002`, `OBS-001` | `TV-SCENE-001`, `TV-SCENE-002`, `TV-SCENE-003`, `TV-SCENE-004`, `TV-OBS-001` |
| 7 | `Semantics`; `Invariants` | `HISTORY-001`, `EVENTS-001` | `TV-HISTORY-001`, `TV-HISTORY-002`, `TV-EVENTS-001`, `TV-EVENTS-002` |
| 8 | `Semantics`; `Invariants`; `Security` | `INPUT-001`, `INPUT-002`, `EVENTS-001` | `TV-INPUT-001`, `TV-INPUT-002`, `TV-INPUT-003`, `TV-INPUT-004`, `TV-EVENTS-002` |
| 9 | `Semantics`; `Security` | `TEXT-001`, `INPUT-002`, `OBS-001` | `TV-TEXT-001`, `TV-TEXT-002`, `TV-INPUT-004`, `TV-OBS-001` |
| 10 | `Semantics`; `Limits/caps`; `Observability` | `RENDER-001`, `EXPORT-001`, `OBS-001` | `TV-RENDER-001`, `TV-RENDER-002`, `TV-EXPORT-001`, `TV-EXPORT-002`, `TV-OBS-002` |
| 11 | `Public API`; `Semantics` | `REACT-001`, `SVELTE-001` | `TV-REACT-001`, `TV-REACT-002`, `TV-SVELTE-001`, `TV-SVELTE-002` |
| 12 | `Overview`; `Observability`; `Compatibility / versioning strategy` | `SURFACE-002`, `QA-001`, `OBS-001` | `TV-SURFACE-003`, `TV-SURFACE-004`, `TV-QA-001`, `TV-QA-002`, `TV-OBS-001`, `TV-OBS-002` |
| 13 | `Goals / Non-goals`; `Compatibility / versioning strategy`; `Undefined / Explicitly user-deferred only` | `BOUNDARY-001` | `TV-BOUNDARY-001`, `TV-BOUNDARY-002` |

# Coverage Result

No missing intent items.

All intent items are covered by at least one SPEC section, at least one requirement, and at least one verification vector. The user-deferred Nucleus boundary is explicitly preserved as a scope constraint rather than treated as missing product scope.

