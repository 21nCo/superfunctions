# Intent Inventory

1. Create example apps in `uifn`.
2. Put the specification in `uifn/.conduct`.
3. Follow the previously proposed approach rather than inventing a different direction.
4. Treat the examples as private apps instead of part of the published package surface.
5. Use a clean `uifn/examples/*` layout and account for the current root workspace glob limitation.
6. Build canonical React and Svelte examples first because those adapters are GA.
7. Include a Vue example, but keep it experimental and truthful.
8. Prefer scenario-based apps over a component zoo.
9. Share one scenario kit across frameworks.
10. Handle `VirtualizedList` only where supported; Vue must not pretend support.
11. Use simple Vite-based apps instead of adding SSR complexity up front.
12. Add clear commands and example README documentation.
13. Add dedicated example verification that is separate from the existing publish/release gate.
14. Link the examples back into the main `uifn` docs once the apps exist.

# Coverage Audit

## 1. Create example apps in `uifn`.

- Covered in `SPEC.md`:
  - `Overview`
  - `Goals / Non-goals`
  - `Public API`
- Requirement IDs:
  - `EXW-001`
  - `HUB-002`
  - `RCT-005`
  - `SVE-006`
  - `VUE-007`
- Test vectors:
  - `TV-WS-001`
  - `TV-REACT-001`
  - `TV-SVELTE-001`
  - `TV-VUE-001`

## 2. Put the specification in `uifn/.conduct`.

- Covered in `SPEC.md`:
  - `Metadata`
- Requirement IDs:
  - `EXW-001` (project placement and workspace context)
- Test vectors:
  - N/A for runtime implementation; satisfied by spec-bundle location and metadata

## 3. Follow the previously proposed approach rather than inventing a different direction.

- Covered in `SPEC.md`:
  - `Goals / Non-goals`
  - `Public API`
  - `Semantics`
- Requirement IDs:
  - `EXW-001`
  - `HUB-002`
  - `SHARED-003`
  - `RCT-005`
  - `SVE-006`
  - `VUE-007`
  - `VERIFY-009`
- Test vectors:
  - `TV-WS-001`
  - `TV-SHARED-001`
  - `TV-REACT-001`
  - `TV-SVELTE-001`
  - `TV-VUE-001`
  - `TV-VERIFY-001`

## 4. Treat the examples as private apps instead of part of the published package surface.

- Covered in `SPEC.md`:
  - `Goals / Non-goals`
  - `Public API`
  - `Semantics`
- Requirement IDs:
  - `EXW-001`
- Test vectors:
  - `TV-WS-001`

## 5. Use a clean `uifn/examples/*` layout and account for the current root workspace glob limitation.

- Covered in `SPEC.md`:
  - `Public API`
  - `Semantics`
- Requirement IDs:
  - `EXW-001`
  - `HUB-002`
- Test vectors:
  - `TV-WS-001`
  - `TV-HUB-001`

## 6. Build canonical React and Svelte examples first because those adapters are GA.

- Covered in `SPEC.md`:
  - `Goals / Non-goals`
  - `Semantics`
  - `Compatibility / versioning strategy`
- Requirement IDs:
  - `RCT-005`
  - `SVE-006`
- Test vectors:
  - `TV-REACT-001`
  - `TV-SVELTE-001`

## 7. Include a Vue example, but keep it experimental and truthful.

- Covered in `SPEC.md`:
  - `Goals / Non-goals`
  - `Semantics`
  - `Invariants`
  - `Compatibility / versioning strategy`
- Requirement IDs:
  - `VUE-007`
  - `CAP-008`
  - `DOC-010`
- Test vectors:
  - `TV-VUE-001`
  - `TV-CAP-001`
  - `TV-DOC-001`

## 8. Prefer scenario-based apps over a component zoo.

- Covered in `SPEC.md`:
  - `Goals / Non-goals`
  - `Shared example module contract`
  - `Semantics`
- Requirement IDs:
  - `SHARED-003`
  - `UI-004`
- Test vectors:
  - `TV-SHARED-001`
  - `TV-ROUTE-001`

## 9. Share one scenario kit across frameworks.

- Covered in `SPEC.md`:
  - `Shared example module contract`
  - `Data formats / protocol`
  - `Semantics`
- Requirement IDs:
  - `SHARED-003`
  - `UI-004`
  - `CAP-008`
- Test vectors:
  - `TV-SHARED-001`
  - `TV-CAP-001`

## 10. Handle `VirtualizedList` only where supported; Vue must not pretend support.

- Covered in `SPEC.md`:
  - `Shared example module contract`
  - `Semantics`
  - `Invariants`
- Requirement IDs:
  - `RCT-005`
  - `SVE-006`
  - `VUE-007`
  - `CAP-008`
- Test vectors:
  - `TV-REACT-001`
  - `TV-SVELTE-001`
  - `TV-VUE-001`
  - `TV-CAP-001`

## 11. Use simple Vite-based apps instead of adding SSR complexity up front.

- Covered in `SPEC.md`:
  - `Overview`
  - `Goals / Non-goals`
- Requirement IDs:
  - `RCT-005`
  - `SVE-006`
  - `VUE-007`
- Test vectors:
  - `TV-REACT-001`
  - `TV-SVELTE-001`
  - `TV-VUE-001`

## 12. Add clear commands and example README documentation.

- Covered in `SPEC.md`:
  - `Script contract`
  - `Documentation semantics`
- Requirement IDs:
  - `HUB-002`
  - `DOC-010`
- Test vectors:
  - `TV-HUB-001`
  - `TV-DOC-001`

## 13. Add dedicated example verification that is separate from the existing publish/release gate.

- Covered in `SPEC.md`:
  - `Verification output envelope`
  - `Semantics`
- Requirement IDs:
  - `VERIFY-009`
  - `EXW-001`
- Test vectors:
  - `TV-VERIFY-001`
  - `TV-VERIFY-002`

## 14. Link the examples back into the main `uifn` docs once the apps exist.

- Covered in `SPEC.md`:
  - `Documentation semantics`
- Requirement IDs:
  - `DOC-010`
- Test vectors:
  - `TV-DOC-001`

# Final Audit Result

No missing intent items.
