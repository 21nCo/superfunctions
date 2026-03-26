# Intent Inventory

1. `uifn` MUST be production-ready, not merely passing the current release script.
2. React MUST remain explicit GA scope.
3. Svelte MUST remain explicit GA scope.
4. The package family is an unstyled, accessible primitives system built around a shared core plus adapters.
5. Canonical package identities are `@uifn/core`, `@uifn/react`, `@uifn/svelte`, with Vue and files public but Experimental.
6. Unsupported adapters such as Solid and web-components MUST NOT be publicly claimed.
7. Display helpers (`Avatar`, `Badge`, `Label`, `Separator`, `VirtualizedList`) remain part of the public contract.
8. `AvatarFallback` behavior MUST be deterministic.
9. `VirtualizedList` MUST remain adapter-only with deterministic overscan and bounded rendering.
10. Compatibility claims for Node, React, Svelte, browsers, and Experimental packages MUST be truthful.
11. A one-command local release gate MUST exist.
12. Shared semantics MUST be owned by `@uifn/core`.
13. Public IDs and ARIA relationships MUST be deterministic and collision-free.
14. Canonical runtime errors MUST be used instead of plain adapter errors.
15. Accessibility, keyboard behavior, focus management, and reduced-motion correctness are first-class requirements.
16. Controlled and uncontrolled behavior MUST remain stable after mount.
17. Dialog, popup, menu, select, combobox, range, and scroll surfaces MUST be production-grade.
18. React MUST be typed, ref-safe, SSR-safe, hydration-safe, and support documented polymorphism.
19. Svelte MUST be typed, warning-free for GA surfaces, deterministic, and controlled-reactive.
20. Docs, support matrix, licenses, and public package boundaries MUST be truthful.
21. The `2026-03-25-ptnwmntx-full-audit.md` findings MUST be treated as authoritative implementation gaps.
22. Passing `npm run verify:uifn-release` alone is insufficient if it misses real blockers.
23. Duplicate fixed IDs in popup/select/combobox surfaces MUST be explicitly prohibited.
24. Warning suppression in the GA Svelte build path MUST be explicitly prohibited.
25. Manual accessibility evidence MUST come from real browser and assistive-technology runs, not jsdom or ARIA review alone.
26. The legacy root `uifn/.conduct/SPEC.md` MUST stop overclaiming unshipped public API.
27. Consumer smoke installs and import-resolution checks MUST be part of the release bar.

# Intent Coverage

| Intent item | Covered in SPEC.md | Requirement IDs | Test vectors |
| --- | --- | --- | --- |
| 1 | `Overview`, `Goals / Non-goals`, `Compatibility / versioning strategy` | `REL-001`, `REL-002`, `REL-003`, `QA-001`, `QA-002`, `COMPAT-001` | `TV-REL-001`, `TV-REL-002`, `TV-REL-003`, `TV-QA-001`, `TV-QA-002`, `TV-COMPAT-001` |
| 2 | `Overview`, `Public API`, `Semantics`, `Compatibility / versioning strategy` | `REACT-001`, `REACT-002`, `QA-001`, `QA-002`, `COMPAT-001` | `TV-REACT-001`, `TV-REACT-002`, `TV-QA-001`, `TV-QA-002`, `TV-COMPAT-001` |
| 3 | `Overview`, `Public API`, `Semantics`, `Compatibility / versioning strategy` | `SVELTE-001`, `SVELTE-002`, `QA-001`, `QA-002`, `COMPAT-001` | `TV-SVELTE-001`, `TV-SVELTE-002`, `TV-QA-001`, `TV-QA-002`, `TV-COMPAT-001` |
| 4 | `Overview`, `Goals / Non-goals`, `Semantics` | `CORE-001`, `CORE-004`, `DISC-001`, `FORM-001`, `DLG-001`, `POP-001`, `MENU-001`, `SEL-001`, `CMB-001`, `RANGE-001`, `SCROLL-001`, `SIMPLE-001` | `TV-CORE-001`, `TV-CORE-004`, `TV-DISC-001`, `TV-FORM-001`, `TV-DLG-001`, `TV-POP-001`, `TV-MENU-001`, `TV-SEL-001`, `TV-CMB-001`, `TV-RANGE-001`, `TV-SCROLL-001`, `TV-SIMPLE-001` |
| 5 | `Overview`, `Public API`, `Semantics` | `REL-001`, `DOCS-001`, `FILES-001` | `TV-REL-001`, `TV-DOCS-001`, `TV-FILES-001` |
| 6 | `Semantics` | `REL-001`, `DOCS-001` | `TV-REL-001`, `TV-DOCS-001` |
| 7 | `Public API`, `Semantics`, `Limits/caps` | `SIMPLE-001`, `DOCS-001` | `TV-SIMPLE-001`, `TV-DOCS-001` |
| 8 | `Semantics`, `Invariants` | `SIMPLE-001` | `TV-SIMPLE-001` |
| 9 | `Public API`, `Limits/caps`, `Semantics` | `SIMPLE-001`, `QA-001` | `TV-SIMPLE-001`, `TV-QA-001` |
| 10 | `Overview`, `Compatibility / versioning strategy` | `REL-001`, `DOCS-001`, `COMPAT-001`, `FILES-001` | `TV-REL-001`, `TV-DOCS-001`, `TV-COMPAT-001`, `TV-FILES-001` |
| 11 | `Overview`, `Data formats / protocol`, `Semantics` | `REL-003` | `TV-REL-003` |
| 12 | `Semantics` | `CORE-001` | `TV-CORE-001` |
| 13 | `Semantics`, `Invariants` | `CORE-002`, `REACT-002`, `SVELTE-001` | `TV-CORE-002`, `TV-REACT-002`, `TV-SVELTE-001` |
| 14 | `Data formats / protocol`, `Semantics` | `CORE-003`, `REACT-001`, `SVELTE-002` | `TV-CORE-003`, `TV-REACT-001`, `TV-SVELTE-002` |
| 15 | `Semantics`, `Invariants`, `Observability` | `CORE-004`, `QA-002` | `TV-CORE-004`, `TV-QA-002` |
| 16 | `Semantics` | `DISC-001`, `FORM-001`, `SEL-001`, `CMB-001`, `SVELTE-001` | `TV-DISC-001`, `TV-FORM-001`, `TV-SEL-001`, `TV-CMB-001`, `TV-SVELTE-001` |
| 17 | `Semantics` | `DLG-001`, `POP-001`, `MENU-001`, `SEL-001`, `CMB-001`, `RANGE-001`, `SCROLL-001` | `TV-DLG-001`, `TV-POP-001`, `TV-MENU-001`, `TV-SEL-001`, `TV-CMB-001`, `TV-RANGE-001`, `TV-SCROLL-001` |
| 18 | `Semantics` | `REACT-001`, `REACT-002` | `TV-REACT-001`, `TV-REACT-002` |
| 19 | `Semantics`, `Invariants` | `SVELTE-001`, `SVELTE-002` | `TV-SVELTE-001`, `TV-SVELTE-002` |
| 20 | `Semantics`, `Compatibility / versioning strategy` | `DOCS-001`, `FILES-001`, `COMPAT-001` | `TV-DOCS-001`, `TV-FILES-001`, `TV-COMPAT-001` |
| 21 | `Overview`, `Goals / Non-goals`, `Semantics` | `CORE-002`, `CORE-003`, `DISC-001`, `DLG-001`, `SVELTE-001`, `SVELTE-002`, `DOCS-001`, `QA-001`, `QA-002` | `TV-CORE-002`, `TV-CORE-003`, `TV-DISC-001`, `TV-DLG-001`, `TV-SVELTE-001`, `TV-SVELTE-002`, `TV-DOCS-001`, `TV-QA-001`, `TV-QA-002` |
| 22 | `Overview`, `Data formats / protocol`, `Observability` | `REL-003`, `QA-002`, `COMPAT-001` | `TV-REL-003`, `TV-QA-002`, `TV-COMPAT-001` |
| 23 | `Semantics`, `Invariants` | `CORE-002`, `SEL-001`, `CMB-001`, `REACT-002`, `SVELTE-001` | `TV-CORE-002`, `TV-SEL-001`, `TV-CMB-001`, `TV-REACT-002`, `TV-SVELTE-001` |
| 24 | `Semantics`, `Invariants` | `SVELTE-002`, `REL-003`, `COMPAT-001` | `TV-SVELTE-002`, `TV-REL-003`, `TV-COMPAT-001` |
| 25 | `Semantics`, `Observability` | `QA-002` | `TV-QA-002` |
| 26 | `Public API`, `Semantics` | `DOCS-001`, `REL-001` | `TV-DOCS-001`, `TV-REL-001` |
| 27 | `Data formats / protocol`, `Semantics`, `Compatibility / versioning strategy` | `REL-003`, `COMPAT-001`, `QA-001` | `TV-REL-003`, `TV-COMPAT-001`, `TV-QA-001` |

# Coverage Result

No missing intent items.

Corrective edits made while preparing this bundle:

- Elevated the `2026-03-25` audit findings to explicit MUST-level release requirements.
- Added explicit requirements and vectors for duplicate-instance ID collisions, warning suppression, and real manual accessibility evidence.
- Added consumer smoke verification as a release-bar requirement because the current gate does not prove public installability by itself.
- Added root-spec truth requirements so the legacy `uifn/.conduct/SPEC.md` no longer remains outside the release contract.
