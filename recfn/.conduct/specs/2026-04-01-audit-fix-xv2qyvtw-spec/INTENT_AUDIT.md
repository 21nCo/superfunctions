# Intent Audit

## Intent Inventory

1. `recfn` MUST become production-ready for `nucleus`, not remain a prototype.
2. Bot-driven recording and transcription MUST work end-to-end for the named Tier-1 platforms.
3. The immediately named production platforms are Zoom, Google Meet, Microsoft Teams, and desktop capture mode.
4. Unsupported or unnamed platforms MUST NOT be silently claimed as supported.
5. Automatic recording finalization after bot sessions MUST exist; manual upload alone is insufficient.
6. Google Meet and Microsoft Teams MUST stop using stub capture implementations.
7. Zoom MUST be hardened to the same production recording pipeline.
8. WebSocket namespace isolation MUST be secure.
9. WebSocket payload schemas MUST match both SDKs.
10. Bot detail responses MUST include nested related data.
11. Chat and metadata MUST be persistently captured and exposed.
12. Shared Superfunctions packages and functions MUST be reused where they already exist instead of keeping bespoke seams.
13. Code duplication between browser platforms and cloud ASR adapters MUST be reduced.
14. Python SDK parity MUST be achieved for the audited gaps.
15. CLI transcript behavior MUST be PII-safe by default.
16. Calendar auto-scheduling and token refresh MUST be production runtime behavior, not just exported helpers.
17. Release readiness MUST include observability, build/typecheck/test gates, and migration discipline.
18. Self-hosted, namespace-scoped, secret-safe behavior remains mandatory.

## Coverage matrix

| # | Intent item | SPEC.md coverage | Requirement IDs | Test vectors |
|---|---|---|---|---|
| 1 | Production-ready for nucleus | Overview, Semantics, Observability, Compatibility / versioning strategy | `PROD-001`, `BUILD-001`, `OBS-001`, `COMPAT-001` | `TV-PROD-001`, `TV-BUILD-001`, `TV-OBS-001`, `TV-COMPAT-001` |
| 2 | End-to-end bot recording/transcription on named platforms | Public API, Semantics, Limits/caps | `BOT-001`, `PLAT-001`, `PLAT-002`, `PLAT-003`, `TRX-001`, `TRX-002` | `TV-BOT-001`, `TV-PLAT-001`, `TV-PLAT-002`, `TV-PLAT-003`, `TV-TRX-001`, `TV-TRX-002` |
| 3 | Named Tier-1 platform set | Overview, Glossary, Data formats / protocol | `PROD-001` | `TV-PROD-001` |
| 4 | Unsupported platforms must not be claimed | Data formats / protocol, Invariants | `PROD-001`, `COMPAT-001` | `TV-PROD-001`, `TV-COMPAT-001` |
| 5 | Automatic recording finalization | Semantics | `BOT-001` | `TV-BOT-001` |
| 6 | Meet and Teams cannot remain stubbed | Semantics, Invariants | `PLAT-002`, `PLAT-003` | `TV-PLAT-002`, `TV-PLAT-003` |
| 7 | Zoom hardened to full production path | Public API, Semantics | `PLAT-001` | `TV-PLAT-001` |
| 8 | WS namespace isolation secure | Security, Invariants | `WS-001`, `SEC-001` | `TV-WS-001`, `TV-SEC-001` |
| 9 | WS schemas match SDKs | Public API, Data formats / protocol | `WS-002`, `SDK-001` | `TV-WS-002`, `TV-SDK-001` |
| 10 | Bot detail returns nested related data | Public API | `API-001` | `TV-API-001` |
| 11 | Chat and metadata persistence | Public API, Semantics | `DATA-001`, `API-001` | `TV-DATA-001`, `TV-API-001` |
| 12 | Reuse shared superfunctions packages/functions | Overview, Runtime configuration, Semantics | `ARCH-001`, `ARCH-002`, `INT-001`, `SEC-001` | `TV-ARCH-001`, `TV-ARCH-002`, `TV-INT-001`, `TV-SEC-001` |
| 13 | Reduce browser and ASR duplication | Semantics | `ARCH-003`, `ARCH-004` | `TV-ARCH-003`, `TV-ARCH-004` |
| 14 | Python SDK parity | SDK contract | `SDK-001`, `WS-002` | `TV-SDK-001`, `TV-WS-002` |
| 15 | CLI PII-safe default | CLI contract, Security | `CLI-001` | `TV-CLI-001` |
| 16 | Calendar runtime behavior | Semantics | `CAL-001` | `TV-CAL-001` |
| 17 | Observability and release gates | Observability, Compatibility / versioning strategy | `OBS-001`, `BUILD-001`, `COMPAT-001` | `TV-OBS-001`, `TV-BUILD-001`, `TV-COMPAT-001` |
| 18 | Self-hosted, namespace-scoped, secret-safe | Overview, Invariants, Security | `ARCH-001`, `ARCH-002`, `WS-001`, `SEC-001`, `LIMIT-001` | `TV-ARCH-001`, `TV-ARCH-002`, `TV-WS-001`, `TV-SEC-001`, `TV-LIMIT-001` |

## Missing items analysis

No missing intent items.

The only explicit assumption is the named Tier-1 platform set in Assumption A1. That assumption is surfaced in `SPEC.md` and enforced by `PROD-001`; it does not silently remove any named source-material requirement.

