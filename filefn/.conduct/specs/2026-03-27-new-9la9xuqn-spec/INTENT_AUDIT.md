# INTENT_AUDIT

## Intent Inventory

1. Add a FileFn Swift client so SwiftUI apps can talk to a FileFn server.
2. Keep the work inside the existing monorepo and follow `AGENTS.md` conventions.
3. Treat the existing FileFn HTTP/JSON contract as the authoritative server boundary.
4. Cover upload sessions end to end: init, status, sign part, upload part, complete part, complete upload, abort.
5. Cover file listing, file metadata, versions, downloads, artifacts, and render descriptors.
6. Cover grants/permissions routes.
7. Cover share-link routes and share-link download resolution.
8. Cover processing triggers.
9. Cover canonical envelope parsing.
10. Make the client a real native client rather than a blind browser-port.
11. Give SwiftUI apps native progress/event semantics.
12. Support background uploads that survive app backgrounding/relaunch.
13. Provide a clear HEIC strategy for iOS-originated media.
14. Provide helper integration for SwiftUI file-picking flows.
15. Ship as Swift Package Manager only.
16. Keep this a pure client SDK, not a server-side Swift implementation.
17. Avoid shrinking scope to a tiny subset; cover the broad FileFn client surface.
18. Add a contract-first artifact so Swift and TypeScript do not drift silently.
19. Preserve security around auth headers, upload session tokens, and local files.
20. Include local verification and docs so maintainers can build/test from repo root.
21. Support apps rendered in `WKWebView` via a native-backed bridge mode in addition to direct native SwiftUI apps.
22. Follow the DataFn pattern of a native Swift host plus a thin JavaScript bridge package rather than porting browser behavior wholesale.
23. Keep native-backed uploads native-owned by using native asset handles instead of moving large raw bytes through `WKScriptMessageHandler`.
24. Preserve an explicit topology distinction between native-backed WebView mode and browser/web-owned mode; no silent fallback.
25. Keep auth headers and anonymous upload session tokens inside Swift in native-backed mode.
26. Provide sanitized preview semantics for native-backed WebView content without exposing raw filesystem paths.

## Coverage Map

| Intent item | SPEC.md coverage | Requirement IDs | Test vectors |
| --- | --- | --- | --- |
| 1 | Overview, Public API, Goals / Non-goals | PKG-001, FILE-001, RENDER-001, UP-001, UP-002, BG-001, UI-001, BRIDGE-001 | TV-PKG-001, TV-FILE-001, TV-RENDER-001, TV-UP-001, TV-UP-002, TV-BG-001, TV-UI-001, TV-BRIDGE-001 |
| 2 | Overview, Goals / Non-goals | PKG-001, DOC-001 | TV-PKG-001, TV-DOC-001 |
| 3 | Overview, Data formats / protocol, Semantics | CFG-001, ENV-001, ERR-001, CONTRACT-001 | TV-CFG-001, TV-ENV-001, TV-ERR-001, TV-CONTRACT-001 |
| 4 | Public API, Data formats / protocol, Semantics | UP-001, UP-002, BG-001, SEC-001 | TV-UP-001, TV-UP-002, TV-UP-003, TV-BG-001, TV-SEC-001 |
| 5 | Public API, Data formats / protocol, Semantics | FILE-001, RENDER-001 | TV-FILE-001, TV-RENDER-001 |
| 6 | Public API, Data formats / protocol | GRANT-001 | TV-GRANT-001 |
| 7 | Public API, Data formats / protocol | SHARE-001 | TV-SHARE-001 |
| 8 | Public API, Data formats / protocol | PROC-001 | TV-PROC-001 |
| 9 | Data formats / protocol | ENV-001 | TV-ENV-001 |
| 10 | Overview, Semantics, Non-goals | PKG-001, CFG-001, UP-002, BG-001, HEIC-001, UI-001, BRIDGE-002 | TV-PKG-001, TV-CFG-001, TV-UP-002, TV-BG-001, TV-HEIC-001, TV-UI-001, TV-BRIDGE-002 |
| 11 | Public API, Semantics | UP-002, UI-001, BRIDGE-002 | TV-UP-002, TV-UI-001, TV-BRIDGE-002 |
| 12 | Overview, Public API, Semantics, Invariants | BG-001, BRIDGE-002, SEC-001, TEST-001 | TV-BG-001, TV-BRIDGE-002, TV-SEC-001, TV-TEST-001 |
| 13 | Public API, Semantics | HEIC-001 | TV-HEIC-001 |
| 14 | Public API, Semantics | UI-001 | TV-UI-001 |
| 15 | Overview, Goals / Non-goals, Public API | PKG-001, DOC-001 | TV-PKG-001, TV-DOC-001 |
| 16 | Overview, Non-goals | PKG-001, DOC-001 | TV-PKG-001, TV-DOC-001 |
| 17 | Goals / Non-goals, Public API, PLAN.md phases | FILE-001, RENDER-001, POL-001, GRANT-001, SHARE-001, PROC-001, UP-001, UP-002, BG-001, BRIDGE-001, BRIDGE-002, HEIC-001, UI-001 | TV-FILE-001, TV-RENDER-001, TV-POL-001, TV-GRANT-001, TV-SHARE-001, TV-PROC-001, TV-UP-001, TV-UP-002, TV-BG-001, TV-BRIDGE-001, TV-BRIDGE-002, TV-HEIC-001, TV-UI-001 |
| 18 | Goals / Non-goals, Public API, Semantics | CONTRACT-001 | TV-CONTRACT-001 |
| 19 | Security, Observability, Semantics | SEC-001, ERR-001, BRIDGE-002 | TV-SEC-001, TV-ERR-001, TV-BRIDGE-002 |
| 20 | Overview, Limits/caps, PLAN.md, Documentation | TEST-001, DOC-001 | TV-TEST-001, TV-DOC-001 |
| 21 | Overview, Public API, Semantics, PLAN.md phases | PKG-001, BRIDGE-001, BRIDGE-002, DOC-001 | TV-PKG-001, TV-BRIDGE-001, TV-BRIDGE-002, TV-DOC-001 |
| 22 | Overview, Public API, Semantics, PLAN.md phases | PKG-001, BRIDGE-001, TEST-001 | TV-PKG-001, TV-BRIDGE-001, TV-TEST-001 |
| 23 | Goals / Non-goals, Public API, Semantics, Security | BRIDGE-002, SEC-001 | TV-BRIDGE-002, TV-SEC-001 |
| 24 | Goals / Non-goals, Semantics, Public API | BRIDGE-001, BRIDGE-002, DOC-001 | TV-BRIDGE-001, TV-BRIDGE-002, TV-DOC-001 |
| 25 | Overview, Semantics, Security | BRIDGE-002, SEC-001 | TV-BRIDGE-002, TV-SEC-001 |
| 26 | Glossary, Public API, Native-backed WebView bridge, Security | BRIDGE-002, SEC-001, UI-001 | TV-BRIDGE-002, TV-SEC-001, TV-UI-001 |

## Corrective completeness check

No missing intent items.
