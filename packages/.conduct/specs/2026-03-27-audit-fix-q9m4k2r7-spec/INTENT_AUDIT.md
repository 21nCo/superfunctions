# Intent Audit

## Intent Inventory

1. The spec MUST live under `packages/.conduct` and target the shared packages audited in `.conduct/audits/2026-03-26-y7m3q2k8-full-audit.md`.
2. The shared OAuth family MUST become credible as the production-default reusable OAuth substrate for future superfunctions consumers.
3. `oauth-flow` MUST stop owning duplicate lower-level contract types and MUST gain runtime-config resolver parity with `oauth-core`.
4. `oauth-flow` MUST default to encrypted token persistence and MUST require an explicit unsafe mode for plaintext storage.
5. `oauth-flow.disconnect()` MUST report connection cleanup truthfully and MUST expose richer disconnect hook context and validation.
6. `oauth-router` MUST stop making every route public by default and MUST document secure default route metadata.
7. `oauth-providers` MUST stop presenting in-memory arrays and `Math.random()` as an audit boundary, and MUST support durable policy consent/audit persistence.
8. Docs MUST correct the `oauth_tokens` naming mismatch, stop normalizing insecure production examples, and explain the new router/policy architecture.
9. Every audited shared OAuth package MUST have a package-local README, and `oauth-router` MUST be discoverable in docs navigation.
10. The shared OAuth family MUST have a reproducible repo-root release gate and package-local verification path.
11. The audit-fix work MUST ship deterministic regression tests and explicit compatibility/deprecation guidance for public contract changes.

## Coverage Map

### 1. The spec MUST live under `packages/.conduct` and target the shared packages audited in `.conduct/audits/2026-03-26-y7m3q2k8-full-audit.md`.

- Covered in SPEC.md:
  - `Metadata`
  - `Overview`
- Requirement IDs:
  - `DOCS-001`
  - `DOCS-002`
  - `GATE-001`
- Test vectors:
  - `TV-DOCS-002`
  - `TV-GATE-001`

### 2. The shared OAuth family MUST become credible as the production-default reusable OAuth substrate for future superfunctions consumers.

- Covered in SPEC.md:
  - `Overview`
  - `Goals / Non-goals`
  - `Invariants`
  - `Security`
- Requirement IDs:
  - `FLOW-001`
  - `FLOW-002`
  - `FLOW-003`
  - `ROUTER-001`
  - `PROVIDER-001`
  - `GATE-001`
- Test vectors:
  - `TV-FLOW-001`
  - `TV-FLOW-002`
  - `TV-FLOW-003`
  - `TV-ROUTER-001`
  - `TV-PROVIDER-001`
  - `TV-GATE-001`

### 3. `oauth-flow` MUST stop owning duplicate lower-level contract types and MUST gain runtime-config resolver parity with `oauth-core`.

- Covered in SPEC.md:
  - `Public API`
  - `Semantics`
- Requirement IDs:
  - `FLOW-001`
  - `COMPAT-001`
- Test vectors:
  - `TV-FLOW-001`
  - `TV-COMPAT-001`

### 4. `oauth-flow` MUST default to encrypted token persistence and MUST require an explicit unsafe mode for plaintext storage.

- Covered in SPEC.md:
  - `Public API`
  - `Data formats / protocol`
  - `Semantics`
  - `Security`
- Requirement IDs:
  - `FLOW-002`
  - `FLOW-004`
  - `COMPAT-001`
- Test vectors:
  - `TV-FLOW-002`
  - `TV-DOCS-001`
  - `TV-COMPAT-001`

### 5. `oauth-flow.disconnect()` MUST report connection cleanup truthfully and MUST expose richer disconnect hook context and validation.

- Covered in SPEC.md:
  - `Public API`
  - `Data formats / protocol`
  - `Semantics`
  - `Observability`
- Requirement IDs:
  - `FLOW-003`
  - `FLOW-004`
  - `COMPAT-001`
- Test vectors:
  - `TV-FLOW-003`
  - `TV-FLOW-004`
  - `TV-COMPAT-001`

### 6. `oauth-router` MUST stop making every route public by default and MUST document secure default route metadata.

- Covered in SPEC.md:
  - `Public API`
  - `Security`
  - `Documentation surface`
- Requirement IDs:
  - `ROUTER-001`
  - `DOCS-002`
- Test vectors:
  - `TV-ROUTER-001`
  - `TV-DOCS-002`

### 7. `oauth-providers` MUST stop presenting in-memory arrays and `Math.random()` as an audit boundary, and MUST support durable policy consent/audit persistence.

- Covered in SPEC.md:
  - `Public API`
  - `Semantics`
  - `Security`
- Requirement IDs:
  - `PROVIDER-001`
  - `COMPAT-001`
- Test vectors:
  - `TV-PROVIDER-001`
  - `TV-PROVIDER-002`
  - `TV-COMPAT-001`

### 8. Docs MUST correct the `oauth_tokens` naming mismatch, stop normalizing insecure production examples, and explain the new router/policy architecture.

- Covered in SPEC.md:
  - `Documentation surface`
  - `Semantics`
  - `Security`
- Requirement IDs:
  - `DOCS-001`
  - `DOCS-002`
- Test vectors:
  - `TV-DOCS-001`
  - `TV-DOCS-002`

### 9. Every audited shared OAuth package MUST have a package-local README, and `oauth-router` MUST be discoverable in docs navigation.

- Covered in SPEC.md:
  - `Documentation surface`
  - `Semantics`
- Requirement IDs:
  - `DOCS-002`
  - `COMPAT-001`
- Test vectors:
  - `TV-DOCS-002`
  - `TV-COMPAT-001`

### 10. The shared OAuth family MUST have a reproducible repo-root release gate and package-local verification path.

- Covered in SPEC.md:
  - `Release-gate surface`
  - `Semantics`
  - `Invariants`
- Requirement IDs:
  - `GATE-001`
  - `TEST-001`
- Test vectors:
  - `TV-GATE-001`

### 11. The audit-fix work MUST ship deterministic regression tests and explicit compatibility/deprecation guidance for public contract changes.

- Covered in SPEC.md:
  - `Invariants`
  - `Compatibility / versioning strategy`
- Requirement IDs:
  - `TEST-001`
  - `COMPAT-001`
- Test vectors:
  - `TV-FLOW-001`
  - `TV-FLOW-002`
  - `TV-FLOW-003`
  - `TV-FLOW-004`
  - `TV-ROUTER-001`
  - `TV-PROVIDER-001`
  - `TV-PROVIDER-002`
  - `TV-GATE-001`
  - `TV-COMPAT-001`

## Result

No missing intent items.
