# Intent Inventory
1. A new example is needed for sharing instead of continuing to grow the existing todo example.
2. The example must help consumers understand DataFn sharing capability in a realistic way.
3. The example must also serve as a realistic testing target, including Playwright-style browser flows.
4. The example must explain how to model actors.
5. The example must explain how to model namespace resolution.
6. The example must show demonstrable basic functionality instead of staying abstract.
7. The example should reflect real DataFn usage rather than a fake mock-only UI.
8. The example should make the workspace/tenant boundary distinct from the current user/actor.
9. The example should teach principal-based sharing, not only user-local state.
10. The example should show common sharing semantics such as viewer/editor behavior, revocation, and team-style access.
11. The example should support deterministic testing and resettable state.
12. The example should avoid depending on heavy external services for evaluation.
13. The example should avoid overloading `datafn/examples/todo-app`.

# Coverage Audit
## 1. Separate example instead of expanding todo app
- Covered in SPEC.md: `Overview`, `Goals / Non-goals`, `Public API -> Filesystem layout`
- Requirement IDs: EXAPP-001
- Test vectors: TV-ARCH-001

## 2. Teach consumers how sharing works in real apps
- Covered in SPEC.md: `Overview`, `Glossary`, `Semantics`, `Observability`
- Requirement IDs: UI-001, UI-002, UI-003, DOC-001
- Test vectors: TV-DOC-001, TV-SHARE-001, TV-DOCS-001

## 3. Serve as a Playwright/browser testing target
- Covered in SPEC.md: `Overview`, `Public API -> Playwright surface`, `Invariants`
- Requirement IDs: SYNC-001, TEST-001
- Test vectors: TV-SYNC-001, TV-SYNC-002, TV-E2E-001

## 4. Model actors clearly
- Covered in SPEC.md: `Glossary`, `Public API -> Demo identity headers`, `Semantics -> Namespace and actor resolution`
- Requirement IDs: AUTH-001, AUTH-003, UI-001
- Test vectors: TV-AUTH-001, TV-UI-001

## 5. Model namespace resolution clearly
- Covered in SPEC.md: `Glossary`, `Public API -> Demo identity headers`, `Semantics -> Namespace and actor resolution`
- Requirement IDs: AUTH-001, ISO-001, DOC-001
- Test vectors: TV-AUTH-001, TV-ISO-001, TV-DOCS-001

## 6. Show demonstrable basic functionality
- Covered in SPEC.md: `Public API -> Client UI surface`, `Semantics -> Record share behavior`, `Semantics -> Resource-scope grant behavior`
- Requirement IDs: UI-002, UI-003, SHARE-001, SHARE-002, SHARE-003, SHARE-004
- Test vectors: TV-DOC-001, TV-DOC-002, TV-SHARE-001, TV-SHARE-002, TV-SHARE-003, TV-SHARE-004

## 7. Use real DataFn flows, not mock-only state
- Covered in SPEC.md: `Overview`, `Semantics`, `Consistency`
- Requirement IDs: UI-002, UI-003, SYNC-001
- Test vectors: TV-DOC-001, TV-SYNC-001

## 8. Distinguish workspace boundary from current actor
- Covered in SPEC.md: `Data formats / protocol -> Client session model`, `Semantics -> Namespace and actor resolution`
- Requirement IDs: AUTH-001, AUTH-003, ISO-001
- Test vectors: TV-AUTH-001, TV-UI-001, TV-ISO-001

## 9. Teach principal-based sharing
- Covered in SPEC.md: `Glossary`, `Semantics -> Principal modeling`
- Requirement IDs: AUTH-002, UI-003, SHARE-004
- Test vectors: TV-CTX-001, TV-SHARE-004

## 10. Show viewer/editor/revoke/team access semantics
- Covered in SPEC.md: `Semantics -> Record share behavior`, `Semantics -> Resource-scope grant behavior`
- Requirement IDs: SHARE-001, SHARE-002, SHARE-003, SHARE-004
- Test vectors: TV-DOC-002, TV-SHARE-001, TV-SHARE-002, TV-SHARE-003, TV-SHARE-004

## 11. Support deterministic reset and repeatable testing
- Covered in SPEC.md: `Public API -> Demo endpoints`, `Invariants`
- Requirement IDs: API-001, API-002, TEST-001
- Test vectors: TV-RESET-001, TV-E2E-001

## 12. Avoid heavy external services
- Covered in SPEC.md: `Overview`, `Hard constraints`, `Plan -> Architecture Sketch`
- Requirement IDs: TEST-001
- Test vectors: TV-E2E-001

## 13. Do not overload the todo example
- Covered in SPEC.md: `Goals / Non-goals`, `Public API -> Filesystem layout`
- Requirement IDs: EXAPP-001
- Test vectors: TV-ARCH-001

# Final Audit Result
No missing intent items.
