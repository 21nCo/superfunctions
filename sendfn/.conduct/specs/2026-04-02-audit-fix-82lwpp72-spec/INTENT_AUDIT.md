# Intent Audit

## Intent Inventory

1. `sendfn` MUST be a self-deployable unified communications SDK/platform.
2. The public TypeScript package/import identity MUST be `sendfn`.
3. v0 MUST support basic email sending.
4. v0 MUST support basic email receiving, interpreted here as AWS SES lifecycle event intake.
5. Transactional templates MUST remain in-codebase for v0.
6. AWS SES MUST remain the v0 email provider adapter.
7. Suppression lists MUST cover bounces, complaints, unsubscribe/manual actions, and removal.
8. Base event tracking MUST cover SES lifecycle events.
9. v0 MUST support push notifications using FCM for Android and APNS for iOS.
10. Device tokens, email transactions, suppression entries, and communication events MUST be stored through the provided database adapter.
11. Shared Superfunctions abstractions MUST be reused instead of duplicating generic DB/HTTP code.
12. TypeScript and Python SDKs MUST remain aligned for supported features.
13. Public APIs MUST be type-safe, validated, and coherent.
14. Production readiness MUST include security hardening.
15. Production readiness MUST include performance readiness.
16. Production readiness MUST include scalability readiness.
17. Production readiness MUST include low duplication / parity-drift control.
18. Production readiness MUST include packaging and abstraction quality.
19. Production readiness MUST include a real test/release gate.
20. Documentation and examples MUST match the shipped behavior.

## Coverage matrix

| Intent item | Covered in SPEC.md | Requirement IDs | Test vectors |
| --- | --- | --- | --- |
| 1 | Overview; Goals / Non-goals; Compatibility / versioning strategy | `PKG-001`, `API-001`, `SHARED-001`, `TEST-001` | `TV-PKG-001-P`, `TV-API-001-P`, `TV-SHARED-001-P`, `TV-TEST-001-P` |
| 2 | Public API; Packaging semantics; Compatibility / versioning strategy | `PKG-001`, `DOC-001` | `TV-PKG-001-P`, `TV-PKG-001-N`, `TV-DOC-001-P`, `TV-DOC-001-N` |
| 3 | Public API; Email semantics | `EMAIL-002`, `EMAIL-003`, `API-001` | `TV-EMAIL-002-P`, `TV-EMAIL-002-N`, `TV-EMAIL-003-P`, `TV-EMAIL-003-N` |
| 4 | Overview; SNS envelope input; Webhook semantics | `WEBHOOK-001`, `WEBHOOK-002`, `DB-001` | `TV-WEBHOOK-001-P`, `TV-WEBHOOK-001-N`, `TV-WEBHOOK-002-P`, `TV-WEBHOOK-002-N` |
| 5 | Public API; Email semantics | `EMAIL-001`, `EMAIL-002`, `DOC-001`, `PARITY-001` | `TV-EMAIL-001-P`, `TV-EMAIL-001-N`, `TV-DOC-001-P` |
| 6 | Context; Email semantics | `EMAIL-003`, `WEBHOOK-002`, `DOC-001` | `TV-EMAIL-003-P`, `TV-WEBHOOK-002-P`, `TV-DOC-001-P` |
| 7 | Suppression semantics | `SUP-001`, `EMAIL-002`, `WEBHOOK-002` | `TV-SUP-001-P`, `TV-SUP-001-N`, `TV-EMAIL-002-P`, `TV-WEBHOOK-002-P` |
| 8 | Data formats / protocol; Persistence and event semantics; Webhook semantics | `DB-001`, `WEBHOOK-002`, `OBS-001` | `TV-DB-001-P`, `TV-WEBHOOK-002-P`, `TV-OBS-001-P` |
| 9 | Public API; Push semantics | `PUSH-001`, `DEVICE-001`, `PERF-001`, `PARITY-001` | `TV-PUSH-001-P`, `TV-PUSH-001-N`, `TV-DEVICE-001-P`, `TV-PERF-001-P` |
| 10 | Context; Persistence and event semantics | `DB-001`, `TEST-002`, `SHARED-001` | `TV-DB-001-P`, `TV-TEST-002-P`, `TV-SHARED-001-P` |
| 11 | Goals / Non-goals; Compatibility / versioning strategy | `SHARED-001` | `TV-SHARED-001-P`, `TV-SHARED-001-N` |
| 12 | Public API; Compatibility / versioning strategy | `API-001`, `PARITY-001`, `DOC-001` | `TV-API-001-P`, `TV-API-001-N`, `TV-DOC-001-P` |
| 13 | Public API; Canonical envelopes; Security | `API-001`, `API-002`, `EMAIL-002` | `TV-API-001-P`, `TV-API-002-P`, `TV-EMAIL-002-N` |
| 14 | Security; Webhook semantics; Observability | `WEBHOOK-001`, `WEBHOOK-002`, `OBS-001`, `API-002` | `TV-WEBHOOK-001-P`, `TV-WEBHOOK-001-N`, `TV-OBS-001-P`, `TV-API-002-N` |
| 15 | Context; Email semantics; Push semantics; Limits/caps | `EMAIL-003`, `PUSH-001`, `PERF-001` | `TV-EMAIL-003-P`, `TV-PUSH-001-P`, `TV-PERF-001-P` |
| 16 | Context; Push semantics; Limits/caps | `PUSH-001`, `DEVICE-001`, `PERF-001` | `TV-PUSH-001-P`, `TV-DEVICE-001-P`, `TV-PERF-001-N` |
| 17 | Invariants; Release-gate semantics | `TEST-002`, `PARITY-001`, `SHARED-001` | `TV-TEST-002-P`, `TV-TEST-002-N`, `TV-API-001-P` |
| 18 | Packaging semantics; Compatibility / versioning strategy | `PKG-001`, `PKG-002`, `API-001`, `SHARED-001` | `TV-PKG-001-P`, `TV-PKG-002-P`, `TV-SHARED-001-P` |
| 19 | Release-gate semantics | `TEST-001`, `TEST-002` | `TV-TEST-001-P`, `TV-TEST-001-N`, `TV-TEST-002-P` |
| 20 | Packaging semantics; Documentation alignment | `DOC-001`, `PKG-001`, `PKG-002` | `TV-DOC-001-P`, `TV-DOC-001-N`, `TV-PKG-001-P`, `TV-PKG-002-P` |

## Final audit statement

No missing intent items.

Corrective edits made while drafting this spec:

1. The audit findings were converted into explicit MUST-level requirements for packaging, webhook security, event correlation, template correctness, performance/scalability, shared-abstraction reuse, and release gating.
2. The ambiguous “basic email receiving” intent item was resolved with explicit Assumption A-001 so the spec remains complete and testable.
3. Documentation drift, parity drift, and adapter-fidelity gaps were promoted from observations into concrete acceptance criteria and test vectors.
