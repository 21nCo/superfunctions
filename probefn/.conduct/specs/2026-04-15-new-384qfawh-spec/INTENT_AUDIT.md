# Intent Inventory

1. Build a framework that coding agents such as Codex and Claude Code can leverage directly.
2. The framework must operate on browser-based web applications.
3. The framework must support reliable debugging instead of guessing root causes.
4. The framework must collect and surface browser console logs.
5. The framework must inspect screenshots or equivalent evidence instead of relying on text-only assumptions.
6. The framework must help with app design review.
7. The framework must help with visual regression detection.
8. The framework must define a concrete architecture rather than a vague concept.
9. The framework must define a concrete implementation language and stack.
10. The framework must define how agents consume it, including CLI and/or MCP.
11. The framework must define how the agent navigates the web page.
12. The framework must define how it integrates with local dev servers such as Vite.
13. The framework must define where artifacts are stored.
14. The framework must define how console logs are forwarded or sunk so agents can use them as context.
15. The framework must be local-first.
16. The implementation stack must be TypeScript/Node.js plus Playwright plus Turborepo.
17. The repo must be created in the current workspace as a new repository.
18. Because the system has multiple surfaces, the repo should use a monorepo layout.
19. The design/regression system should combine screenshots with structural/browser-native signals.
20. The navigation model should prefer deterministic browser control over screenshot-only clicking.
21. The system must include artifact-backed reporting and explain regressions/findings in a machine-usable way.
22. The spec must be end to end and must not defer scope to later versions.

# Coverage Map

## Intent item 1

- Covered in SPEC.md: `Overview`, `Goals / Non-goals`, `Public API`
- Requirement IDs: `API-001`, `API-002`, `DOC-001`
- Test vectors: `TV-MCP-001`, `TV-CLI-001`, `TV-FIXTURE-001`

## Intent item 2

- Covered in SPEC.md: `Overview`, `Semantics`, `Public API`
- Requirement IDs: `DEV-001`, `BROWSER-001`, `NAV-001`
- Test vectors: `TV-SESSION-001`, `TV-SESSION-002`, `TV-ACTION-001`

## Intent item 3

- Covered in SPEC.md: `Goals / Non-goals`, `Semantics`, `Invariants`
- Requirement IDs: `DEBUG-001`, `EVENT-001`, `REPORT-001`
- Test vectors: `TV-DEBUG-001`, `TV-EVENT-001`, `TV-REPORT-001`

## Intent item 4

- Covered in SPEC.md: `Data formats / protocol`, `Semantics`, `Observability`
- Requirement IDs: `EVENT-001`, `EVENT-002`, `API-002`
- Test vectors: `TV-EVENT-001`, `TV-DELTA-001`, `TV-MCP-001`

## Intent item 5

- Covered in SPEC.md: `Goals / Non-goals`, `Data formats / protocol`, `Semantics`
- Requirement IDs: `SNAP-001`, `NAV-003`, `DESIGN-001`
- Test vectors: `TV-CHECKPOINT-001`, `TV-ACTION-004`, `TV-DESIGN-001`

## Intent item 6

- Covered in SPEC.md: `Goals / Non-goals`, `Semantics`
- Requirement IDs: `DESIGN-001`, `DESIGN-002`, `REPORT-001`
- Test vectors: `TV-DESIGN-001`, `TV-DESIGN-002`, `TV-REPORT-001`

## Intent item 7

- Covered in SPEC.md: `Goals / Non-goals`, `Semantics`
- Requirement IDs: `BASELINE-001`, `BASELINE-002`, `DETERMINISM-001`
- Test vectors: `TV-BASELINE-001`, `TV-BASELINE-002`, `TV-BASELINE-003`

## Intent item 8

- Covered in SPEC.md: `Overview`, `Public API`, `Compatibility / versioning strategy`
- Requirement IDs: `ARCH-001`, `CONFIG-001`, `DOC-001`
- Test vectors: `TV-CONFIG-001`, `TV-FIXTURE-001`

## Intent item 9

- Covered in SPEC.md: `Overview`, `Public API`
- Requirement IDs: `ARCH-001`, `BROWSER-001`
- Test vectors: `TV-CONFIG-001`, `TV-BROWSER-001`

## Intent item 10

- Covered in SPEC.md: `Public API`
- Requirement IDs: `API-001`, `API-002`, `DOC-001`
- Test vectors: `TV-CLI-001`, `TV-MCP-001`, `TV-FIXTURE-001`

## Intent item 11

- Covered in SPEC.md: `Public API`, `Semantics`, `Invariants`
- Requirement IDs: `NAV-001`, `NAV-002`, `NAV-003`
- Test vectors: `TV-ACTION-001`, `TV-ACTION-002`, `TV-ACTION-004`

## Intent item 12

- Covered in SPEC.md: `Public API`, `Semantics`, `Observability`
- Requirement IDs: `DEV-001`, `DEV-002`, `DETERMINISM-002`
- Test vectors: `TV-SESSION-001`, `TV-SESSION-002`, `TV-DETERMINISM-002`

## Intent item 13

- Covered in SPEC.md: `Data formats / protocol`, `Semantics`, `Observability`
- Requirement IDs: `STORAGE-001`, `STORAGE-002`, `REPORT-001`
- Test vectors: `TV-STORAGE-001`, `TV-LIMITS-001`, `TV-REPORT-001`

## Intent item 14

- Covered in SPEC.md: `Data formats / protocol`, `Semantics`, `Observability`
- Requirement IDs: `EVENT-001`, `EVENT-002`, `API-002`
- Test vectors: `TV-EVENT-001`, `TV-DELTA-001`, `TV-MCP-001`

## Intent item 15

- Covered in SPEC.md: `Overview`, `Security`
- Requirement IDs: `RUNTIME-001`, `SECURITY-001`
- Test vectors: `TV-SESSION-001`, `TV-SECURITY-001`

## Intent item 16

- Covered in SPEC.md: `Overview`, `Public API`
- Requirement IDs: `ARCH-001`, `BROWSER-001`
- Test vectors: `TV-CONFIG-001`, `TV-BROWSER-001`

## Intent item 17

- Covered in SPEC.md: `Overview`
- Requirement IDs: `ARCH-001`, `DOC-001`
- Test vectors: `TV-FIXTURE-001`

## Intent item 18

- Covered in SPEC.md: `Public API`
- Requirement IDs: `ARCH-001`
- Test vectors: `TV-CONFIG-001`, `TV-FIXTURE-001`

## Intent item 19

- Covered in SPEC.md: `Goals / Non-goals`, `Semantics`, `Data formats / protocol`
- Requirement IDs: `SNAP-001`, `DESIGN-001`, `BASELINE-002`
- Test vectors: `TV-CHECKPOINT-001`, `TV-DESIGN-001`, `TV-BASELINE-003`

## Intent item 20

- Covered in SPEC.md: `Goals / Non-goals`, `Semantics`, `Invariants`
- Requirement IDs: `NAV-001`, `NAV-002`, `NAV-003`
- Test vectors: `TV-ACTION-001`, `TV-ACTION-002`, `TV-ACTION-004`

## Intent item 21

- Covered in SPEC.md: `Data formats / protocol`, `Semantics`, `Observability`
- Requirement IDs: `DEBUG-001`, `REPORT-001`, `OBS-001`
- Test vectors: `TV-DEBUG-001`, `TV-REPORT-001`, `TV-OBS-001`

## Intent item 22

- Covered in SPEC.md: `Overview`, `Goals / Non-goals`, `Undefined / Explicitly user-deferred only`; PLAN.md `Phases overview`
- Requirement IDs: `TEST-001`, `DOC-001`, `ARCH-001`
- Test vectors: `TV-FIXTURE-001`

# Audit result

- All intent items listed above are covered by SPEC.md, REQUIREMENTS.md, TEST_VECTORS.md, and PLAN.md.
- No missing intent items.
