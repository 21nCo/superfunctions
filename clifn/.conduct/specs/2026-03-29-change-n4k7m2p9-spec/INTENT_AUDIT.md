# Intent Inventory

1. Create a detailed and thorough spec under `clifn/.conduct`.
2. The spec MUST cover changes that should be added to `clifn` instead of being built directly inside `extfn`.
3. The resulting `clifn` capabilities MUST be generic enough for any CLI builder, not just `extfn`.
4. The spec MUST refer to existing CLIs in the Superfunctions repository.
5. Generic concerns identified in the prior discussion include:
   - runner / action execution
   - output and UI helpers
   - config loading
   - environment readers
   - diagnostics
   - subprocess execution
   - scaffolding helpers
6. Product-specific concerns MUST remain in the owning CLI package rather than moving into `clifn`.
7. `extfn` is an explicit adopter, but extfn-specific logic MUST stay in `extfn/cli`.
8. The repository currently mixes parser styles, so the shared toolkit MUST be parser-agnostic.
9. The spec MUST produce a phased implementation plan, requirements, tests, and audit artifacts according to the spec workflow.
10. The extfn spec MUST be patched in relevant places after the clifn spec is created.

# Coverage Audit

## 1. Create a detailed and thorough spec under `clifn/.conduct`.

- Covered in SPEC.md:
  - `Overview`
  - `Public API`
  - `Semantics`
  - `Security`
  - `Compatibility / versioning strategy`
- Requirements:
  - `PKG-001`
  - `ADOPT-001`
- Test vectors:
  - `TV-PKG-001`
  - `TV-ADOPT-001`

## 2. Cover changes that should be added to `clifn` instead of being built directly inside `extfn`.

- Covered in SPEC.md:
  - `Overview`
  - `Goals / Non-goals`
  - `Adoption semantics`
- Requirements:
  - `OUT-001`
  - `RUN-001`
  - `CFG-001`
  - `ENV-001`
  - `DIAG-001`
  - `EXEC-001`
  - `FS-001`
  - `ADOPT-001`
- Test vectors:
  - `TV-OUT-001`
  - `TV-RUN-001`
  - `TV-CFG-001`
  - `TV-ENV-001`
  - `TV-DIAG-001`
  - `TV-EXEC-001`
  - `TV-FS-001`
  - `TV-ADOPT-001`

## 3. Make the resulting capabilities generic enough for any CLI builder, not just `extfn`.

- Covered in SPEC.md:
  - `Goals / Non-goals`
  - `Public API`
  - `Parser integration semantics`
  - `Adoption semantics`
- Requirements:
  - `RUN-001`
  - `CFG-001`
  - `PARS-001`
  - `ADOPT-001`
- Test vectors:
  - `TV-RUN-001`
  - `TV-CFG-001`
  - `TV-PARS-001`
  - `TV-ADOPT-001`

## 4. Refer to existing CLIs in the Superfunctions repository.

- Covered in SPEC.md:
  - `Overview`
  - `Goals / Non-goals`
  - `Package responsibilities` in PLAN.md
- Requirements:
  - `ADOPT-001`
  - `PARS-001`
- Test vectors:
  - `TV-PARS-001`
  - `TV-ADOPT-001`

## 5. Cover runner, output, config loading, env readers, diagnostics, subprocess execution, and scaffolding helpers.

- Covered in SPEC.md:
  - `Public API`
  - `Semantics`
- Requirements:
  - `OUT-001`
  - `RUN-001`
  - `RUN-002`
  - `CFG-001`
  - `ENV-001`
  - `DIAG-001`
  - `EXEC-001`
  - `FS-001`
- Test vectors:
  - `TV-OUT-001`
  - `TV-RUN-001`
  - `TV-RUN-002`
  - `TV-CFG-001`
  - `TV-ENV-001`
  - `TV-DIAG-001`
  - `TV-EXEC-001`
  - `TV-FS-001`

## 6. Keep product-specific concerns in the owning CLI package.

- Covered in SPEC.md:
  - `Goals / Non-goals`
  - `Adoption semantics`
- Requirements:
  - `ADOPT-001`
- Test vectors:
  - `TV-ADOPT-001`

## 7. `extfn` is an explicit adopter, but extfn-specific logic stays in `extfn/cli`.

- Covered in SPEC.md:
  - `Overview`
  - `Adoption semantics`
- Requirements:
  - `ADOPT-001`
- Test vectors:
  - `TV-ADOPT-001`

## 8. The shared toolkit must be parser-agnostic.

- Covered in SPEC.md:
  - `Goals / Non-goals`
  - `Public API`
  - `Parser integration semantics`
  - `Invariants`
- Requirements:
  - `RUN-001`
  - `PARS-001`
- Test vectors:
  - `TV-RUN-001`
  - `TV-PARS-001`

## 9. Produce phased implementation, requirements, tests, and audit artifacts according to the spec workflow.

- Covered in:
  - `PLAN.md`
  - `REQUIREMENTS.md`
  - `TEST_VECTORS.md`
  - `INTENT_AUDIT.md`
  - `phases/PHASE_00.md` through `phases/PHASE_07.md`
- Requirements:
  - `PKG-001`
  - `ADOPT-001`
- Test vectors:
  - `TV-PKG-001`
  - `TV-ADOPT-001`

## 10. Patch the extfn spec in relevant places after the clifn spec is created.

- Covered in SPEC.md:
  - `Adoption semantics`
- Requirements:
  - `ADOPT-001`
- Test vectors:
  - `TV-ADOPT-001`
- Corrective action performed outside this bundle:
  - The imported extfn spec bundle is patched in the current workspace after this clifn spec bundle is created.

# Final Audit Result

No missing intent items.

