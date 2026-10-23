# Intent Audit

## Intent Inventory

1. Build architecture for Finatron personal finance management starting with financial email ingestion/parsing.
2. Build architecture for Fellotron as a unified communication manager across channels, starting with email.
3. Integrate Gmail and understand provider rules/restrictions.
4. Address whether forwarding-based ingestion is viable.
5. Address whether user rerouting bank email to platform-managed address is viable and risks.
6. Account for E2EE mailbox ambition similar to Proton-style positioning.
7. Explicitly handle what can go wrong even with strong security/reliability.
8. Evaluate current `superfunctions/plugfn` implementation and tighten it.
9. Reuse shared primitives (especially OAuth) across `plugfn` and future `authfn` social sign-in.
10. Cover all needed email providers for implementation, not only Gmail.
11. Make `plugfn` and related shared packages production-ready, with as many phases as needed.
12. Do not reduce scope to MVP/minimum subset.
13. Provide deterministic, testable, high-precision requirements and acceptance vectors.
14. Include canonical API/protocol envelopes and explicit failure/error behavior.
15. Include security, privacy, multi-tenant isolation, and data lifecycle controls.
16. Include operational readiness: observability, runbooks, release gating.
17. Keep future authfn interoperability explicit in architecture and plan.
18. Produce full `.conduct/specs/{spec_folder}` bundle with logs/tracker integration.

## Coverage Mapping

### 1) Finatron email-first finance ingestion/parsing

- **Covered in SPEC.md**:
  - Overview
  - Public API -> Email adapter contract
  - Semantics -> Finatron parsing semantics
- **Requirement IDs**:
  - MAIL-008
  - ARCH-004
- **Test vectors**:
  - TV-MAIL-PARSER-POS
  - TV-MAIL-PARSER-NEG

### 2) Fellotron unified communication manager starting with email

- **Covered in SPEC.md**:
  - Overview
  - Public API -> Email adapter contract
  - Semantics -> Fellotron outbound semantics
- **Requirement IDs**:
  - MAIL-009
  - ARCH-003
- **Test vectors**:
  - TV-MAIL-SEND-POS
  - TV-MAIL-SEND-NEG

### 3) Gmail integration + provider restrictions awareness

- **Covered in SPEC.md**:
  - Public API -> provider topology and mail contracts
  - Semantics -> Mail sync semantics
  - Security + Limits/caps
- **Requirement IDs**:
  - MAIL-001
  - MAIL-010
  - OAUTH-006
- **Test vectors**:
  - TV-MAIL-GMAIL-POS
  - TV-MAIL-GMAIL-NEG
  - TV-MAIL-POLICY-POS

### 4) Forwarding-based ingestion viability

- **Covered in SPEC.md**:
  - Semantics -> Forwarding and managed mailbox semantics
- **Requirement IDs**:
  - MAIL-006
- **Test vectors**:
  - TV-MAIL-FORWARD-POS
  - TV-MAIL-FORWARD-NEG

### 5) Platform-managed mailbox for finance and associated risks

- **Covered in SPEC.md**:
  - Semantics -> Forwarding and managed mailbox semantics
  - Security -> E2EE constraints
- **Requirement IDs**:
  - MAIL-007
  - SEC-004
- **Test vectors**:
  - TV-MAIL-MANAGED-POS
  - TV-MAIL-MANAGED-NEG
  - TV-SEC-E2EE-POS

### 6) E2EE mailbox ambition and constraints

- **Covered in SPEC.md**:
  - Security -> E2EE constraints
  - Invariants
- **Requirement IDs**:
  - SEC-004
- **Test vectors**:
  - TV-SEC-E2EE-POS
  - TV-SEC-E2EE-NEG

### 7) Explicit failure and risk handling despite security/reliability goals

- **Covered in SPEC.md**:
  - Data formats/protocol -> canonical error codes
  - Semantics -> partial sync / rebaseline / send block
  - Observability
- **Requirement IDs**:
  - PLUG-002
  - PLUG-006
  - MAIL-007
  - MAIL-009
- **Test vectors**:
  - TV-PLUG-WEBHOOK-VERIFY-NEG
  - TV-PLUG-RATELIMIT-NEG
  - TV-MAIL-MANAGED-NEG
  - TV-MAIL-SEND-NEG

### 8) Tighten current `plugfn` implementation

- **Covered in SPEC.md**:
  - Overview
  - Public API
  - Semantics
  - Compatibility/versioning strategy
- **Requirement IDs**:
  - ARCH-002
  - PLUG-001
  - PLUG-003
  - PLUG-005
  - OPS-001
- **Test vectors**:
  - TV-ARCH-SHARED-USE-POS
  - TV-PLUG-ROUTE-AUTH-POS
  - TV-PLUG-WEBHOOK-MAP-POS
  - TV-PLUG-HTTP-POS
  - TV-OPS-HARDEN-POS

### 9) Shared OAuth primitives reusable for `plugfn` and `authfn`

- **Covered in SPEC.md**:
  - Public API -> package topology and authfn social contract
  - Compatibility/versioning strategy
- **Requirement IDs**:
  - ARCH-001
  - OAUTH-007
- **Test vectors**:
  - TV-ARCH-PACKAGES-POS
  - TV-OAUTH-AUTHFN-POS

### 10) Include all required email providers for implementation

- **Covered in SPEC.md**:
  - Public API -> email provider set
- **Requirement IDs**:
  - ARCH-003
  - MAIL-001
  - MAIL-002
  - MAIL-003
  - MAIL-004
  - MAIL-005
  - MAIL-006
  - MAIL-007
- **Test vectors**:
  - TV-ARCH-ADAPTERS-POS
  - TV-MAIL-GMAIL-POS
  - TV-MAIL-OUTLOOK-POS
  - TV-MAIL-YAHOO-POS
  - TV-MAIL-ICLOUD-POS
  - TV-MAIL-IMAP-POS

### 11) Production readiness across many phases

- **Covered in SPEC.md**:
  - Overview
  - Invariants
  - Security
  - Observability
- **Requirement IDs**:
  - OPS-001
  - OPS-002
  - OPS-003
  - OPS-004
- **Test vectors**:
  - TV-OPS-HARDEN-POS
  - TV-OPS-MATRIX-POS
  - TV-OPS-RUNBOOK-POS
  - TV-OPS-DOCS-POS

### 12) No MVP scope reduction

- **Covered in SPEC.md**:
  - Goals/Non-goals
  - Compatibility/versioning strategy
- **Requirement IDs**:
  - ARCH-003
  - OPS-002
- **Test vectors**:
  - TV-ARCH-ADAPTERS-POS
  - TV-OPS-MATRIX-POS

### 13) Deterministic, testable requirements

- **Covered in SPEC.md**:
  - Data formats/protocol
  - Invariants
- **Requirement IDs**:
  - PLUG-004
  - PLUG-007
  - OAUTH-003
- **Test vectors**:
  - TV-PLUG-CONNECTION-POS
  - TV-PLUG-WORKFLOW-POS
  - TV-OAUTH-CALLBACK-POS

### 14) Canonical envelopes and explicit error behavior

- **Covered in SPEC.md**:
  - Data formats/protocol
- **Requirement IDs**:
  - OAUTH-004
  - PLUG-002
  - MAIL-010
- **Test vectors**:
  - TV-OAUTH-TOKEN-POS
  - TV-PLUG-WEBHOOK-VERIFY-NEG
  - TV-MAIL-POLICY-NEG

### 15) Security/privacy/multi-tenant/data lifecycle

- **Covered in SPEC.md**:
  - Security
  - Invariants
  - Observability
- **Requirement IDs**:
  - SEC-001
  - SEC-002
  - SEC-003
  - SEC-004
- **Test vectors**:
  - TV-SEC-LIFECYCLE-POS
  - TV-SEC-REDACTION-POS
  - TV-SEC-ISOLATION-POS
  - TV-SEC-E2EE-POS

### 16) Operational readiness: observability, runbooks, release gates

- **Covered in SPEC.md**:
  - Observability
  - Compatibility/versioning strategy
- **Requirement IDs**:
  - OPS-002
  - OPS-003
  - OPS-004
- **Test vectors**:
  - TV-OPS-MATRIX-POS
  - TV-OPS-RUNBOOK-POS
  - TV-OPS-DOCS-POS

### 17) Future authfn interoperability

- **Covered in SPEC.md**:
  - Public API -> authfn social OAuth service contract
  - Compatibility/versioning strategy
- **Requirement IDs**:
  - OAUTH-007
  - OAUTH-008
- **Test vectors**:
  - TV-OAUTH-AUTHFN-POS
  - TV-OAUTH-REVOKE-POS

### 18) Full spec bundle + logs/tracker compliance

- **Covered in SPEC.md**:
  - Metadata section
- **Requirement IDs**:
  - OPS-002
- **Test vectors**:
  - TV-OPS-MATRIX-POS

## Corrective pass result

No missing intent items.
