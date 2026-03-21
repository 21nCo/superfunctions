# Intent Inventory

1. Create a spec in `superfunctions/packages/.conduct` for shared OAuth changes, improvements, and dependencies needed by `authfn`.
2. The resulting shared package work must be thorough enough that, together with the `authfn` spec, Better Auth can be swapped out in `21n` and `nucleus`.
3. `authfn` should use OAuth primitives rather than reimplementing protocol logic.
4. `authfn` should use shared HTTP abstractions rather than duplicate routing code.
5. `authfn` should use shared DB/CLI schema-generation semantics.
6. New shared packages are allowed if they produce a better design.
7. OpenAPI support should be shared if it does not already exist.
8. Python support is required from the start.
9. The design should favor cleaner architecture over preserving the current single-package or Better Auth-shaped surface.
10. The shared packages must support Google, Apple, and GitHub social sign-in needs for authfn.
11. No migration paths should be created in this spec.

# Coverage Audit

## 1. Shared OAuth/dependency spec under `packages/.conduct`

- Covered in `SPEC.md`: `Overview`, `Goals / Non-goals`, `Public API`
- Requirement IDs: `PKG-001`
- Test vectors: `TV-PKG-012`

## 2. Thorough enough to unblock Better Auth replacement with authfn

- Covered in `SPEC.md`: `Overview`, `Public API`, `Semantics`
- Requirement IDs: `PKG-001`, `AUTH-001`, `HTTP-001`, `OAUTH-CORE-001`, `OAUTH-FLOW-001`, `OPENAPI-001`, `CLI-001`, `PY-001`
- Test vectors: `TV-PKG-001`, `TV-PKG-004`, `TV-PKG-008`, `TV-PKG-009`, `TV-PKG-010`, `TV-PKG-012`

## 3. Reuse shared OAuth primitives

- Covered in `SPEC.md`: `Goals / Non-goals`, `Public API`, `Semantics`
- Requirement IDs: `OAUTH-CORE-001`, `OAUTH-HTTP-001`, `OAUTH-STORAGE-001`, `OAUTH-FLOW-001`, `OAUTH-ROUTER-001`
- Test vectors: `TV-PKG-003`, `TV-PKG-004`, `TV-PKG-005`, `TV-PKG-006`

## 4. Reuse shared HTTP abstractions

- Covered in `SPEC.md`: `Public API`, `Semantics`
- Requirement IDs: `HTTP-001`, `HTTP-002`, `OPENAPI-001`, `ADAPTER-001`
- Test vectors: `TV-PKG-002`, `TV-PKG-008`, `TV-PKG-010`

## 5. Reuse shared DB/CLI schema semantics

- Covered in `SPEC.md`: `Overview`, `Public API`, `Data formats / protocol`
- Requirement IDs: `OAUTH-STORAGE-001`, `CLI-001`
- Test vectors: `TV-PKG-005`, `TV-PKG-009`

## 6. New shared packages allowed

- Covered in `SPEC.md`: `Public API`
- Requirement IDs: `OAUTH-ROUTER-001`, `OPENAPI-001`
- Test vectors: `TV-PKG-006`, `TV-PKG-008`

## 7. Shared OpenAPI support

- Covered in `SPEC.md`: `Goals / Non-goals`, `Public API`, `Semantics`
- Requirement IDs: `OPENAPI-001`
- Test vectors: `TV-PKG-008`, `TV-PKG-010`

## 8. Python required from the start

- Covered in `SPEC.md`: `Overview`, `Public API`, `Semantics`
- Requirement IDs: `HTTP-002`, `PY-001`, `ADAPTER-001`
- Test vectors: `TV-PKG-001`, `TV-PKG-010`

## 9. Favor cleaner architecture

- Covered in `SPEC.md`: `Goals / Non-goals`, `Public API`
- Requirement IDs: `PKG-001`, `CLI-001`
- Test vectors: `TV-PKG-009`, `TV-PKG-012`

## 10. Google, Apple, GitHub provider support

- Covered in `SPEC.md`: `Goals / Non-goals`, `Public API`, `Semantics`
- Requirement IDs: `PROVIDER-001`, `OAUTH-HTTP-001`
- Test vectors: `TV-PKG-007`

## 11. No migration paths in this spec

- Covered in `SPEC.md`: `Non-goals`, `Undefined / Explicitly user-deferred only`
- Requirement IDs: `PKG-001`
- Test vectors: N/A

# Final Audit

No missing intent items.
