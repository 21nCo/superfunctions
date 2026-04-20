# Intent Inventory
1. DataFn remains a schema-driven, local-first, reactive data runtime with offline sync semantics.
2. Typed SDK APIs remain the primary authoring surface; DFQL remains the underlying protocol/wire format.
3. A Swift native client/runtime is required for DataFn.
4. SwiftUI support is required, but as a thin layer over the native runtime rather than the runtime itself.
5. Core Data replaces IndexedDB as the local persistence layer for embedded Apple apps.
6. A TypeScript bridge package is required so a web app embedded in `WKWebView` can use Core Data persistence through Swift.
7. The same web application codebase must also keep working in a normal browser with IndexedDB local persistence and direct DataFn server sync.
8. In embedded mode, DataFn local data must not be persisted in IndexedDB.
9. In embedded mode, Swift must own remote persistence and synchronization.
10. Native-backed embedded mode must support DataFn-server remote sync.
11. Native-backed embedded mode must also support CloudKit-backed personal multi-device sync without a DataFn server.
12. If the client config selects iCloud remote mode, Swift must use CloudKit instead of DataFn server persistence.
13. Native-backed mode must preserve DataFn storage semantics: records, joins, changelog, cursors, hydration state, and namespace isolation.
14. Query-during-hydration and remote-only resource semantics must remain coherent in the new topology.
15. Determinism, idempotency, and ordering must remain preserved.
16. The bridge pattern should follow an explicit host messaging model like the referenced Nucleus WebView bridge.
17. Native-backed mode should avoid secret leakage and support native-owned auth.
18. The spec must fit existing monorepo conventions and `.conduct` conventions.

# Coverage Audit
## 1. DataFn remains schema-driven, local-first, reactive data runtime with offline sync semantics.
- Covered in `SPEC.md`: Overview; Goals / Non-goals; Semantics sections 3, 5, 7.
- Requirement IDs: STO-001, MUT-001, SYN-001.
- Test vectors: TV-STO-001, TV-MUT-001, TV-SYN-001.

## 2. Typed SDK APIs remain primary; DFQL remains underlying protocol/wire format.
- Covered in `SPEC.md`: Overview; Public API.
- Requirement IDs: API-001, API-002, API-003.
- Test vectors: TV-API-001, TV-API-002, TV-API-003.

## 3. A Swift native client/runtime is required for DataFn.
- Covered in `SPEC.md`: Overview; Public API; Package layout.
- Requirement IDs: PKG-001, API-003.
- Test vectors: TV-PKG-001, TV-API-003.

## 4. SwiftUI support is required as a thin layer over the runtime.
- Covered in `SPEC.md`: Overview; Public API; Semantics section 10.
- Requirement IDs: SWUI-001.
- Test vectors: TV-SWUI-001, TV-EVT-001.

## 5. Core Data replaces IndexedDB as local persistence for embedded Apple apps.
- Covered in `SPEC.md`: Goals / Non-goals; Semantics sections 3, 7.
- Requirement IDs: STO-001, MUT-001, COMP-001.
- Test vectors: TV-STO-001, TV-MUT-002, TV-SYN-003.

## 6. A TypeScript bridge package is required for `WKWebView`.
- Covered in `SPEC.md`: Public API; Data formats / protocol.
- Requirement IDs: PKG-001, API-002, BRG-001.
- Test vectors: TV-PKG-001, TV-BRG-001, TV-BRG-002.

## 7. The same web app must still work in a normal browser with IndexedDB and direct DataFn server sync.
- Covered in `SPEC.md`: Overview; Public API; Semantics sections 1 and 2.
- Requirement IDs: API-001, COMP-001.
- Test vectors: TV-API-001, TV-SYN-002.

## 8. Embedded mode must not persist DataFn local data in IndexedDB.
- Covered in `SPEC.md`: Goals / Non-goals; Invariants.
- Requirement IDs: MUT-001, COMP-001.
- Test vectors: TV-MUT-002, TV-SYN-003.

## 9. In embedded mode, Swift must own remote persistence and synchronization.
- Covered in `SPEC.md`: Semantics sections 3, 9, 10.
- Requirement IDs: SYN-001, SYN-002, CLD-001.
- Test vectors: TV-SYN-001, TV-SYN-004, TV-CLD-001.

## 10. Native-backed embedded mode must support DataFn-server remote sync.
- Covered in `SPEC.md`: Public API; Semantics section 9.
- Requirement IDs: SYN-002, AUTH-001.
- Test vectors: TV-API-002, TV-SYN-004, TV-AUTH-001.

## 11. Native-backed embedded mode must support CloudKit-backed personal multi-device sync without a DataFn server.
- Covered in `SPEC.md`: Overview; Semantics section 10.
- Requirement IDs: CLD-001, CLD-002.
- Test vectors: TV-API-003, TV-CLD-001, TV-CLD-003.

## 12. If iCloud remote mode is selected, Swift must use CloudKit instead of the DataFn server.
- Covered in `SPEC.md`: Public API; Semantics sections 1 and 10.
- Requirement IDs: API-001, CLD-001.
- Test vectors: TV-API-003, TV-CLD-002.

## 13. Native-backed mode must preserve records, joins, changelog, cursors, hydration state, and namespace isolation.
- Covered in `SPEC.md`: Semantics sections 7 and 8.
- Requirement IDs: STO-001, STO-002.
- Test vectors: TV-STO-001, TV-STO-002.

## 14. Query-during-hydration and remote-only resource semantics must remain coherent.
- Covered in `SPEC.md`: Semantics sections 4 and 6.
- Requirement IDs: QRY-001, REM-001.
- Test vectors: TV-QRY-001, TV-QRY-002, TV-QRY-003, TV-QRY-004.

## 15. Determinism, idempotency, and ordering must remain preserved.
- Covered in `SPEC.md`: Overview; Invariants; Semantics section 7.
- Requirement IDs: STO-001, STO-002, EVT-001.
- Test vectors: TV-STO-001, TV-STO-002, TV-EVT-001.

## 16. The bridge pattern should follow an explicit host messaging model like the referenced Nucleus WebView bridge.
- Covered in `SPEC.md`: Overview; Public API; Data formats / protocol.
- Requirement IDs: API-002, BRG-001, SEC-001.
- Test vectors: TV-BRG-001, TV-BRG-002, TV-BRG-003.

## 17. Native-backed mode should avoid secret leakage and support native-owned auth.
- Covered in `SPEC.md`: Security; Observability; Semantics section 9.
- Requirement IDs: AUTH-001, SEC-001, OBS-001.
- Test vectors: TV-AUTH-001, TV-SEC-001, TV-OBS-001.

## 18. The spec must fit existing monorepo and `.conduct` conventions.
- Covered in `SPEC.md`: Package layout; Compatibility / versioning strategy.
- Requirement IDs: PKG-001.
- Test vectors: TV-PKG-001.

# Final Audit Status
No missing intent items.
