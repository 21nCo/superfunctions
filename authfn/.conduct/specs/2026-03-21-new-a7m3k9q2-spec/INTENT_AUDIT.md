# Intent Inventory

1. Create a spec in `authfn/.conduct` that is thorough enough that implementing it enables swapping Better Auth out of `21n` and `nucleus`.
2. Ignore legacy auth in `nucleus`; focus on the Better Auth replacement surface.
3. `authfn` must support Google, Apple, and GitHub OAuth sign-in.
4. `authfn` must support email-password sign-in.
5. `authfn` must support OTP flows.
6. `authfn` must use shared OAuth primitives rather than reimplementing OAuth.
7. `authfn` must use `superfunctions/http` for endpoints.
8. `authfn` must use `superfunctions/db` for persistence and `@superfunctions/cli` schema generation semantics.
9. `authfn` must use a plugins/hooks approach for additional capabilities.
10. 2FA is required and should be a plugin unless there is a compelling reason not to.
11. Multi-region behavior for `21n`/`nucleus` must be first-class and may be a plugin if implementable cleanly.
12. Python support is required from the start.
13. The design should favor clean `authfn` architecture over Better Auth compatibility shims for `nucleus`.
14. New package boundaries are allowed if they produce a cleaner architecture.
15. No migration paths should be created in this spec.
16. Delivery integrations should be provider-agnostic; future `sendfn` integration is acceptable but not required now.

# Coverage Audit

## 1. Spec thorough enough to replace Better Auth in `21n` and `nucleus`

- Covered in `SPEC.md`: `Overview`, `Goals / Non-goals`, `Public API`, `Semantics`
- Requirement IDs: `ARCH-001`, `CORE-001`, `HTTP-001`, `SESS-001`, `PASS-001`, `OTP-001`, `SOC-001`, `TFA-001`, `REGION-001`, `CLIENT-001`, `PY-001`
- Test vectors: `TV-AF-001`, `TV-AF-002`, `TV-AF-004`, `TV-AF-006`, `TV-AF-010`, `TV-AF-011`, `TV-AF-014`

## 2. Ignore legacy `nucleus` auth

- Covered in `SPEC.md`: `Non-goals`, `Undefined / Explicitly user-deferred only`
- Requirement IDs: `ARCH-001`
- Test vectors: N/A

## 3. Google, Apple, GitHub OAuth sign-in

- Covered in `SPEC.md`: `Goals / Non-goals`, `Public API`, `Semantics`
- Requirement IDs: `SOC-001`, `SOC-002`
- Test vectors: `TV-AF-006`, `TV-AF-007`, `TV-AF-008`

## 4. Email-password sign-in

- Covered in `SPEC.md`: `Goals / Non-goals`, `Public API`, `Semantics`
- Requirement IDs: `PASS-001`
- Test vectors: `TV-AF-002`, `TV-AF-003`, `TV-AF-005`

## 5. OTP flows

- Covered in `SPEC.md`: `Goals / Non-goals`, `Public API`, `Data formats / protocol`, `Semantics`
- Requirement IDs: `OTP-001`, `OTP-002`
- Test vectors: `TV-AF-004`, `TV-AF-005`

## 6. Reuse shared OAuth primitives

- Covered in `SPEC.md`: `Overview`, `Public API`, `Data formats / protocol`, `Invariants`
- Requirement IDs: `CORE-001`, `SOC-001`
- Test vectors: `TV-AF-006`, `TV-AF-007`, `TV-AF-008`

## 7. Use `superfunctions/http`

- Covered in `SPEC.md`: `Overview`, `Public API`, `Semantics`
- Requirement IDs: `CORE-001`, `HTTP-001`
- Test vectors: `TV-AF-001`, `TV-AF-002`

## 8. Use `superfunctions/db` and CLI schema semantics

- Covered in `SPEC.md`: `Overview`, `Data formats / protocol`, `Semantics`
- Requirement IDs: `CORE-001`, `DATA-001`
- Test vectors: `TV-AF-001`, `TV-AF-009`

## 9. Plugins/hooks approach

- Covered in `SPEC.md`: `Public API`, `Semantics`, `Invariants`
- Requirement IDs: `CORE-002`, `PLUG-001`, `OTP-002`, `REGION-001`
- Test vectors: `TV-AF-001`, `TV-AF-012`

## 10. 2FA required and plugin-first

- Covered in `SPEC.md`: `Goals / Non-goals`, `Public API`, `Semantics`
- Requirement IDs: `TFA-001`
- Test vectors: `TV-AF-010`

## 11. Multi-region first-class capability/plugin

- Covered in `SPEC.md`: `Goals / Non-goals`, `Public API`, `Data formats / protocol`, `Semantics`
- Requirement IDs: `REGION-001`
- Test vectors: `TV-AF-011`, `TV-AF-012`

## 12. Python required from the start

- Covered in `SPEC.md`: `Overview`, `Public API`, `Semantics`
- Requirement IDs: `ARCH-001`, `PY-001`
- Test vectors: `TV-AF-014`

## 13. Optimize for clean `authfn` design

- Covered in `SPEC.md`: `Goals / Non-goals`, `Public API`
- Requirement IDs: `ARCH-001`, `CLIENT-001`
- Test vectors: `TV-AF-001`, `TV-AF-013`

## 14. New package boundaries allowed

- Covered in `SPEC.md`: `Public API`
- Requirement IDs: `ARCH-001`
- Test vectors: `TV-AF-001`

## 15. No migration paths in this spec

- Covered in `SPEC.md`: `Non-goals`, `Undefined / Explicitly user-deferred only`
- Requirement IDs: `ARCH-001`
- Test vectors: N/A

## 16. Provider-agnostic delivery interfaces

- Covered in `SPEC.md`: `Goals / Non-goals`, `Data formats / protocol`, `Semantics`
- Requirement IDs: `OTP-001`, `OTP-002`
- Test vectors: `TV-AF-004`, `TV-AF-005`

# Final Audit

No missing intent items.
