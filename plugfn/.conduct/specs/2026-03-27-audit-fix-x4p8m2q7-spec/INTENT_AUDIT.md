# Intent Inventory

1. PlugFn must become the default reusable integration runtime across repository apps such as nucleus.
2. The product contract must be re-baselined so PlugFn is not simultaneously marketed as a general runtime and as an indistinguishable Finatron/Fellotron mail substrate.
3. OAuth must be handled through shared packages and safe persistence.
4. Webhook and OAuth routes must be automatically exposable through shared HTTP abstractions.
5. Shared persistence must use `@superfunctions/db`.
6. The runtime must support broad reusable integrations, with GitHub, Linear, Google-class integrations, and currently surfaced providers handled truthfully.
7. Security and operations must be production-safe.
8. Python parity is required as part of the adoption story.
9. Any client-side SDK must be intentionally thin and server-delegating.
10. Package naming and distribution docs must match the actual publishable packages.
11. OAuth state/token persistence must stop using synthetic connection-record hacks.
12. The legacy `plugfn/auth/oauth-flow` path must become a wrapper-only shim.
13. Webhook signature verification must use raw request bytes, not reserialized JSON.
14. Route auth must derive from configured auth providers; request-supplied `userId`/`tenantId` must not be authoritative.
15. Workflow disable/delete must actually unregister live handlers, and timing/idempotency behavior must be safe across multi-instance operation.
16. Docs, status files, and release guidance must be truthful and portable.
17. The runtime needs a real release gate that proves TypeScript, CLI, Python, and end-to-end OAuth/webhook behavior.
18. Shared-package reuse and no-duplication remain mandatory.

# Coverage Mapping

## 1) Default reusable integration runtime across apps

- Covered in SPEC.md:
  - Overview
  - Goals / Non-goals
  - Semantics -> Product contract and scope
- Requirement IDs:
  - CONTRACT-001
  - PROVIDER-001
  - REL-001
- Test vectors:
  - TV-CONTRACT-001
  - TV-PROVIDER-001
  - TV-REL-001

## 2) Re-baseline the product contract and resolve core-vs-vertical scope drift

- Covered in SPEC.md:
  - Goals / Non-goals
  - Semantics -> Product contract and scope
  - Compatibility / versioning strategy
- Requirement IDs:
  - CONTRACT-001
  - DOCS-001
- Test vectors:
  - TV-CONTRACT-001
  - TV-DOCS-001

## 3) Handle OAuth through shared packages and safe persistence

- Covered in SPEC.md:
  - Public API
  - Semantics -> Shared DB + OAuth storage
  - Semantics -> Shared OAuth orchestration
- Requirement IDs:
  - PLAT-001
  - OAUTH-001
  - OAUTH-002
- Test vectors:
  - TV-PLAT-001
  - TV-OAUTH-001
  - TV-OAUTH-002

## 4) Automatically expose OAuth/webhook routes through shared HTTP abstractions

- Covered in SPEC.md:
  - Public API -> HTTP router contract
  - Semantics -> Route exposure
- Requirement IDs:
  - ROUTER-001
  - AUTH-001
  - WEBHOOK-001
- Test vectors:
  - TV-ROUTER-001
  - TV-AUTH-001
  - TV-WEBHOOK-001

## 5) Use `@superfunctions/db` as the shared persistence contract

- Covered in SPEC.md:
  - Public API -> TypeScript runtime contract
  - Semantics -> Shared DB + OAuth storage
- Requirement IDs:
  - PLAT-001
  - OAUTH-001
- Test vectors:
  - TV-PLAT-001
  - TV-OAUTH-001

## 6) Provide truthful reusable provider coverage for GitHub, Linear, Google-class, and adjacent providers

- Covered in SPEC.md:
  - Goals / Non-goals
  - Data formats / protocol -> Canonical provider status record
  - Semantics -> Provider readiness matrix
- Requirement IDs:
  - PROVIDER-001
  - PY-003
  - CONTRACT-001
- Test vectors:
  - TV-PROVIDER-001
  - TV-PY-003
  - TV-CONTRACT-001

## 7) Be production-safe in security and operations

- Covered in SPEC.md:
  - Security
  - Semantics -> Auth semantics
  - Semantics -> Webhook semantics
  - Semantics -> Workflow semantics
  - Semantics -> Release-gate semantics
- Requirement IDs:
  - AUTH-001
  - WEBHOOK-001
  - WORKFLOW-001
  - REL-001
- Test vectors:
  - TV-AUTH-001
  - TV-WEBHOOK-001
  - TV-WORKFLOW-001
  - TV-WORKFLOW-002
  - TV-REL-001

## 8) Provide Python parity

- Covered in SPEC.md:
  - Public API -> Python contract
  - Semantics -> Python parity semantics
- Requirement IDs:
  - PY-001
  - PY-002
  - PY-003
- Test vectors:
  - TV-PY-001
  - TV-PY-002
  - TV-PY-003

## 9) Keep any client-side SDK thin and server-delegating

- Covered in SPEC.md:
  - Public API -> Optional browser helper boundary
  - Semantics -> Client boundary semantics
  - Undefined / Explicitly user-deferred only
- Requirement IDs:
  - SDK-001
- Test vectors:
  - TV-SDK-001

## 10) Fix package/distribution contradictions

- Covered in SPEC.md:
  - Public API -> Canonical package contract
  - Semantics -> Package surface
- Requirement IDs:
  - PKG-001
  - DOCS-001
- Test vectors:
  - TV-PKG-001
  - TV-DOCS-001

## 11) Replace synthetic connection-record OAuth persistence

- Covered in SPEC.md:
  - Semantics -> Shared DB + OAuth storage
- Requirement IDs:
  - PLAT-001
  - OAUTH-001
- Test vectors:
  - TV-PLAT-001
  - TV-OAUTH-001

## 12) Reduce legacy OAuth path to a wrapper-only shim

- Covered in SPEC.md:
  - Semantics -> Shared OAuth orchestration
  - Compatibility / versioning strategy
- Requirement IDs:
  - OAUTH-002
- Test vectors:
  - TV-OAUTH-002

## 13) Use raw request bytes for webhook verification

- Covered in SPEC.md:
  - Data formats / protocol
  - Semantics -> Webhook semantics
  - Security
- Requirement IDs:
  - WEBHOOK-001
  - PY-002
- Test vectors:
  - TV-WEBHOOK-001
  - TV-PY-002

## 14) Derive auth from configured auth providers instead of trusting request identity

- Covered in SPEC.md:
  - Public API -> TypeScript runtime contract
  - Semantics -> Auth semantics
  - Security
- Requirement IDs:
  - AUTH-001
  - PY-002
- Test vectors:
  - TV-AUTH-001
  - TV-PY-002

## 15) Fix workflow unregister and multi-instance durability

- Covered in SPEC.md:
  - Semantics -> Workflow semantics
  - Invariants
- Requirement IDs:
  - WORKFLOW-001
- Test vectors:
  - TV-WORKFLOW-001
  - TV-WORKFLOW-002

## 16) Make docs, status files, and release guidance truthful and portable

- Covered in SPEC.md:
  - Goals / Non-goals
  - Invariants
  - Compatibility / versioning strategy
- Requirement IDs:
  - DOCS-001
  - CONTRACT-001
  - PKG-001
- Test vectors:
  - TV-DOCS-001
  - TV-CONTRACT-001
  - TV-PKG-001

## 17) Add a real release gate across TypeScript, CLI, Python, and e2e checks

- Covered in SPEC.md:
  - Data formats / protocol -> Canonical release-gate result
  - Semantics -> Release-gate semantics
  - Observability
- Requirement IDs:
  - REL-001
  - DOCS-001
- Test vectors:
  - TV-REL-001
  - TV-DOCS-001

## 18) Preserve shared-package reuse and remove duplicated core logic

- Covered in SPEC.md:
  - Goals / Non-goals
  - Semantics -> Shared DB + OAuth storage
  - Semantics -> Shared OAuth orchestration
- Requirement IDs:
  - PLAT-001
  - OAUTH-001
  - OAUTH-002
- Test vectors:
  - TV-PLAT-001
  - TV-OAUTH-001
  - TV-OAUTH-002

# Coverage result

No missing intent items.
