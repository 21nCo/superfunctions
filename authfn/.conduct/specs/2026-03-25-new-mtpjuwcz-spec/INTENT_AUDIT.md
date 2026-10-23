# Intent Audit

## Intent Inventory

1. `authfn` examples MUST be split into multiple focused apps rather than one bloated example.
2. The examples MUST demonstrate `authfn` capability, not generic app behavior.
3. The examples MUST be usable for end-to-end testing with Playwright.
4. The ideated example portfolio MUST include `password-sessions`, `otp-recovery`, `social-oauth`, `account-settings`, and `multi-region-routing`.
5. The examples SHOULD share infrastructure rather than duplicate it per app.
6. The examples SHOULD exercise official `authfn` browser/server packages rather than custom wrappers.
7. The examples SHOULD reflect that there is no `authfn/server`; the server integration point is `@authfn/core` plus shared HTTP adapters.
8. Example-server auth schemas MUST be generated using `packages/cli` instead of manual table creation.
9. Example servers SHOULD use a realistic persisted database integration path, specifically Postgres plus Drizzle.
10. Deterministic test hooks such as reset, OTP access, event capture, and fake OAuth fixtures are needed so Playwright can run reliably.
11. Example docs and scripts MUST make the examples runnable manually and automatically.
12. Root workspace wiring MUST include the example packages.
13. Any `authfn` or CLI gaps required to make the above real are part of scope.

## Coverage Matrix

### 1. Multiple focused apps, not one bloated example

- SPEC.md coverage: `Overview`, `Public API`, `Semantics`, `Invariants`
- Requirements: `EXAUTH-001`, `EXAUTH-005`, `EXAUTH-006`, `EXAUTH-007`, `EXAUTH-008`, `EXAUTH-009`
- Test vectors: `TV-EXAUTH-001`, `TV-EXAUTH-005`, `TV-EXAUTH-006`, `TV-EXAUTH-007`, `TV-EXAUTH-008`, `TV-EXAUTH-009`

### 2. Demonstrate authfn capability

- SPEC.md coverage: `Overview`, `Public API`, `Semantics`
- Requirements: `EXAUTH-005`, `EXAUTH-006`, `EXAUTH-007`, `EXAUTH-008`, `EXAUTH-009`, `EXAUTH-010`
- Test vectors: `TV-EXAUTH-005`, `TV-EXAUTH-006`, `TV-EXAUTH-007`, `TV-EXAUTH-008`, `TV-EXAUTH-009`, `TV-EXAUTH-010`

### 3. Playwright-grade end-to-end testing

- SPEC.md coverage: `Overview`, `Semantics`, `Invariants`, `Observability`
- Requirements: `EXAUTH-005`, `EXAUTH-006`, `EXAUTH-007`, `EXAUTH-008`, `EXAUTH-009`, `EXAUTH-011`, `EXAUTH-013`
- Test vectors: `TV-EXAUTH-005`, `TV-EXAUTH-006`, `TV-EXAUTH-007`, `TV-EXAUTH-008`, `TV-EXAUTH-009`, `TV-EXAUTH-011`, `TV-EXAUTH-013`

### 4. Portfolio includes the five ideated apps

- SPEC.md coverage: `Overview`, `Public API`, `Semantics`
- Requirements: `EXAUTH-001`, `EXAUTH-005`, `EXAUTH-006`, `EXAUTH-007`, `EXAUTH-008`, `EXAUTH-009`
- Test vectors: `TV-EXAUTH-001`, `TV-EXAUTH-005`, `TV-EXAUTH-006`, `TV-EXAUTH-007`, `TV-EXAUTH-008`, `TV-EXAUTH-009`

### 5. Shared infrastructure

- SPEC.md coverage: `Public API`, `Semantics`
- Requirements: `EXAUTH-002`, `EXAUTH-011`, `EXAUTH-013`
- Test vectors: `TV-EXAUTH-002`, `TV-EXAUTH-011`, `TV-EXAUTH-013`

### 6. Use official authfn browser/server packages

- SPEC.md coverage: `Public API`, `Semantics`, `Compatibility / versioning strategy`
- Requirements: `EXAUTH-002`, `EXAUTH-010`
- Test vectors: `TV-EXAUTH-003`, `TV-EXAUTH-010`

### 7. No authfn/server package; use @authfn/core plus HTTP adapters

- SPEC.md coverage: `Overview`, `Public API`
- Requirements: `EXAUTH-002`
- Test vectors: `TV-EXAUTH-003`

### 8. Schemas generated using packages/cli, not manual creation

- SPEC.md coverage: `Overview`, `Public API`, `Data formats / protocol`, `Invariants`
- Requirements: `EXAUTH-003`, `EXAUTH-004`
- Test vectors: `TV-EXAUTH-003`, `TV-EXAUTH-004`

### 9. Postgres plus Drizzle path

- SPEC.md coverage: `Overview`, `Semantics`
- Requirements: `EXAUTH-003`
- Test vectors: `TV-EXAUTH-003`

### 10. Deterministic reset, OTP, events, fake OAuth

- SPEC.md coverage: `Public API`, `Data formats / protocol`, `Semantics`, `Invariants`, `Observability`
- Requirements: `EXAUTH-002`, `EXAUTH-006`, `EXAUTH-007`, `EXAUTH-011`, `EXAUTH-013`
- Test vectors: `TV-EXAUTH-002`, `TV-EXAUTH-006`, `TV-EXAUTH-007`, `TV-EXAUTH-011`, `TV-EXAUTH-013`

### 11. Manual and automated docs/scripts

- SPEC.md coverage: `Public API`, `Semantics`
- Requirements: `EXAUTH-012`
- Test vectors: `TV-EXAUTH-012`

### 12. Root workspace updates

- SPEC.md coverage: `Public API`
- Requirements: `EXAUTH-001`
- Test vectors: `TV-EXAUTH-001`

### 13. Scope includes authfn and CLI gaps needed to make examples real

- SPEC.md coverage: `Public API`, `Semantics`, `Compatibility / versioning strategy`
- Requirements: `EXAUTH-004`, `EXAUTH-010`
- Test vectors: `TV-EXAUTH-004`, `TV-EXAUTH-010`

## Audit Result

No missing intent items.
