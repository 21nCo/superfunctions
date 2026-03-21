# Intent Inventory

1. The user requested a detailed and thorough spec, not a partial outline.
2. The spec MUST make `uifn` production-ready.
3. React MUST be explicitly covered as production-ready scope.
4. Svelte MUST be explicitly covered as production-ready scope.
5. The existing `uifn` intent/docs require a framework-agnostic, accessible, unstyled primitives library.
6. The existing component catalog and package family MUST either be honored or truthfully contract-aligned.
7. Public package names, docs, and install instructions MUST stop contradicting each other.
8. Accessibility, keyboard, focus, and reduced-motion behavior are first-class requirements.
9. Shared core semantics MUST exist for the documented primitives.
10. Controlled and uncontrolled behavior MUST be stable across stateful families.
11. Popup, menu, select, and combobox semantics MUST be production-grade rather than placeholder-level.
12. Determinism and SSR/hydration safety MUST be explicit.
13. Release readiness requires working build, test, lint, and pack verification.
14. React-specific gaps such as broken imports, a11y smoke, SSR safety, and polymorphism MUST be addressed.
15. Svelte-specific gaps such as toolchain mismatch, missing types, prop snapshotting, and warning-heavy builds MUST be addressed.
16. Public docs, support matrix, and licenses MUST become truthful.
17. Public-but-unspecced surfaces such as `Avatar`, `Badge`, `MenuBar`, `VirtualizedList`, and `@uifn/files` MUST be handled explicitly.
18. The spec MUST include canonical errors and failure behavior, not only happy-path goals.
19. The spec MUST include a phased plan with locally verifiable phases.
20. The spec MUST fully incorporate the audit findings from `2026-03-20-er70p4kq-full-audit.md`.

# Intent Coverage

| Intent item | Covered in SPEC.md | Requirement IDs | Test vectors |
| --- | --- | --- | --- |
| 1 | `Overview`, `Goals / Non-goals`, `Compatibility / versioning strategy` | `REL-001`, `REL-002`, `REL-003`, `QA-001`, `QA-002` | `TV-REL-001`, `TV-REL-002`, `TV-REL-003`, `TV-QA-001`, `TV-QA-002` |
| 2 | `Overview`, `Semantics`, `Invariants` | `REL-001` through `COMPAT-001` | all vectors in this bundle contribute to production-readiness verification |
| 3 | `Overview`, `Public API`, `Semantics`, `Compatibility / versioning strategy` | `REACT-001`, `REACT-002`, `QA-001`, `QA-002`, `COMPAT-001` | `TV-REACT-001`, `TV-REACT-002`, `TV-QA-001`, `TV-QA-002`, `TV-COMPAT-001` |
| 4 | `Overview`, `Public API`, `Semantics`, `Compatibility / versioning strategy` | `SVELTE-001`, `SVELTE-002`, `QA-001`, `QA-002`, `COMPAT-001` | `TV-SVELTE-001`, `TV-SVELTE-002`, `TV-QA-001`, `TV-QA-002`, `TV-COMPAT-001` |
| 5 | `Overview`, `Goals / Non-goals`, `Semantics`, `Cross-cutting accessibility semantics` | `CORE-001`, `CORE-004`, `DISC-001`, `FORM-001`, `DLG-001`, `POP-001`, `MENU-001`, `SEL-001`, `CMB-001`, `RANGE-001`, `SCROLL-001`, `SIMPLE-001` | `TV-CORE-001`, `TV-CORE-004`, `TV-DISC-001`, `TV-FORM-001`, `TV-DLG-001`, `TV-POP-001`, `TV-MENU-001`, `TV-SEL-001`, `TV-CMB-001`, `TV-RANGE-001`, `TV-SCROLL-001`, `TV-SIMPLE-001` |
| 6 | `Public API`, `Semantics`, `Documentation and support matrix semantics` | `REL-001`, `DOCS-001`, `FILES-001`, `SIMPLE-001` | `TV-REL-001`, `TV-DOCS-001`, `TV-FILES-001`, `TV-SIMPLE-001` |
| 7 | `Release surface semantics`, `Compatibility / versioning strategy` | `REL-001`, `REL-002`, `DOCS-001`, `COMPAT-001` | `TV-REL-001`, `TV-REL-002`, `TV-DOCS-001`, `TV-COMPAT-001` |
| 8 | `Accessibility semantics`, `Invariants`, `Observability` | `CORE-003`, `CORE-004`, `QA-002` | `TV-CORE-003`, `TV-CORE-004`, `TV-QA-002` |
| 9 | `Core ownership semantics`, `Public API` | `CORE-001`, `CORE-002` | `TV-CORE-001`, `TV-CORE-002` |
| 10 | `Controlled and uncontrolled semantics`, `Disclosure and collection semantics` | `DISC-001`, `FORM-001`, `SEL-001`, `CMB-001`, `SVELTE-001` | `TV-DISC-001`, `TV-FORM-001`, `TV-SEL-001`, `TV-CMB-001`, `TV-SVELTE-001` |
| 11 | `Popup semantics`, `Selection semantics` | `DLG-001`, `POP-001`, `MENU-001`, `SEL-001`, `CMB-001`, `SCROLL-001` | `TV-DLG-001`, `TV-POP-001`, `TV-MENU-001`, `TV-SEL-001`, `TV-CMB-001`, `TV-SCROLL-001` |
| 12 | `Overview`, `Invariants`, `Compatibility / versioning strategy` | `CORE-002`, `REACT-002`, `SVELTE-001`, `COMPAT-001` | `TV-CORE-002`, `TV-REACT-002`, `TV-SVELTE-001`, `TV-COMPAT-001` |
| 13 | `Overview`, `Release surface semantics`, `Observability`, `Compatibility / versioning strategy` | `REL-002`, `REL-003`, `REACT-002`, `SVELTE-002`, `QA-001`, `COMPAT-001` | `TV-REL-002`, `TV-REL-003`, `TV-REACT-002`, `TV-SVELTE-002`, `TV-QA-001`, `TV-COMPAT-001` |
| 14 | `Adapter semantics`, `Public API` | `REACT-001`, `REACT-002` | `TV-REACT-001`, `TV-REACT-002` |
| 15 | `Adapter semantics`, `Public API`, `Compatibility / versioning strategy` | `SVELTE-001`, `SVELTE-002` | `TV-SVELTE-001`, `TV-SVELTE-002` |
| 16 | `Documentation and support matrix semantics`, `Compatibility / versioning strategy` | `DOCS-001`, `REL-001`, `REL-002`, `FILES-001` | `TV-DOCS-001`, `TV-REL-001`, `TV-REL-002`, `TV-FILES-001` |
| 17 | `Public API`, `Documentation and support matrix semantics`, `Limits/caps` | `SIMPLE-001`, `FILES-001`, `DOCS-001` | `TV-SIMPLE-001`, `TV-FILES-001`, `TV-DOCS-001` |
| 18 | `Data formats / protocol`, `Security`, `Observability` | `CORE-003`, `REL-003` | `TV-CORE-003`, `TV-REL-003` |
| 19 | `PLAN.md`, `Compatibility / versioning strategy` | all requirements are sequenced through `PHASE_00` to `PHASE_08` | verification is specified phase by phase |
| 20 | `Overview`, `Semantics`, `Invariants`, `Compatibility / versioning strategy` | `REL-001` through `COMPAT-001` | audit-derived vectors are encoded throughout the bundle |

# Coverage Result

No missing intent items.

Corrective edits made while preparing this bundle:

- Elevated React and Svelte to explicit GA scope because the user called out both adapters.
- Converted audit findings about package identity, Svelte toolchain, docs drift, and missing core semantics into explicit MUST-level requirements.
- Added explicit requirements and vectors for public surfaces not fully covered by the legacy `uifn/SPEC.md`, including `MenuBar`, `Avatar`, `Badge`, `VirtualizedList`, and `@uifn/files`.
