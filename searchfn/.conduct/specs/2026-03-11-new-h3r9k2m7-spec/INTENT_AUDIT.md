# Intent Audit

## Intent Inventory

1. Use `$spec` workflow and produce formal spec artifacts.
2. Create a spec for splitting `searchfn` adapters into separate packages.
3. Model the target like package-per-surface (similar to `http-*` pattern).
4. No backward compatibility is required.
5. Old setup may be destroyed/removed if necessary.
6. Update dependencies within the superfunctions monorepo.
7. Be thorough and execution-ready.

## Coverage Mapping

### 1) Use `$spec` workflow and produce formal spec artifacts

- **Covered in SPEC.md**: Metadata, Overview, full normative sections.
- **Requirement IDs**: PKG-001, TEST-002
- **Test vectors**: TV-PKG-001-POS, TV-TEST-002-POS

### 2) Split `searchfn` adapters into separate packages

- **Covered in SPEC.md**: Public API -> New package set; Architecture Sketch in PLAN.
- **Requirement IDs**: PKG-001, PKG-002
- **Test vectors**: TV-PKG-001-POS, TV-PKG-002-POS

### 3) Package-per-surface pattern

- **Covered in SPEC.md**: Public API new leaf package list and invariants.
- **Requirement IDs**: PKG-001, MIG-002
- **Test vectors**: TV-PKG-001-POS, TV-MIG-002-POS

### 4) No backward compatibility required

- **Covered in SPEC.md**: Compatibility/versioning strategy and invariants (no-compat policy).
- **Requirement IDs**: MIG-003, ERR-001
- **Test vectors**: TV-MIG-003-POS, TV-MIG-003-NEG

### 5) Destroy old package if required

- **Covered in SPEC.md**: Compatibility/versioning strategy; Semantics and failure behavior.
- **Requirement IDs**: MIG-003
- **Test vectors**: TV-MIG-003-POS, TV-MIG-003-NEG

### 6) Update dependencies across monorepo

- **Covered in SPEC.md**: Data formats/protocol -> package dependency envelope; sematics migration rules.
- **Requirement IDs**: MIG-001, MIG-002, TEST-002
- **Test vectors**: TV-MIG-001-POS, TV-MIG-002-POS, TV-TEST-002-POS

### 7) Thorough, execution-ready spec

- **Covered in SPEC.md**: full normative sections including invariants, error behavior, observability.
- **Requirement IDs**: All requirements collectively
- **Test vectors**: All vectors collectively

## Corrective pass result

No missing intent items.
