# PHASE_08 — Menu and navigation primitives

## Objective

Implement keyboard- and collection-rigorous navigation primitives from canonical algorithms and DOM services.

## Entry

- Phase 06 shared collection/navigation/typeahead algorithms pass.
- Phase 07 layer/position/focus integration is available for menu-based primitives.

## Requirements

- `PRIM-003`.

## Work

1. Implement ContextMenu, Menu, Menubar, NavigationMenu, Pagination, Tabs, and TreeView logic and anatomy.
2. Encode explicit APG/native key tables per orientation/direction, roving/activedescendant strategy, typeahead, selection/open state, disabled policy, submenu grace, focus return, and pointer/touch behavior.
3. Support dynamic insert/remove/reorder/disable, controlled changes, nested collections, virtualized registration, and deterministic focus repair.
4. Build model-based event-sequence tests and real browser submenu/nesting/RTL/touch scenarios.
5. Delete old machine/controller/key-map variants and prevent generic click assertions from satisfying behavior.

## Required evidence

- `TV-PRIM-003-P/N` plus shared algorithm and layer regressions.
- Executable key tables and minimized property-test sequences for every failure found.
- Actual state/selection/open/focus/ARIA outcomes, not only event-count evidence.

## Exit gate

All seven primitives match their declared navigation models under dynamic/disabled/nested/RTL input and have no primitive-local algorithm fork.

## Do not

- Do not assume ArrowRight/ArrowLeft mean the same logical direction in all primitives.
- Do not use DOM order as durable item identity.

## Handoff

Phase report freezes key tables, collection models, and golden traces for adapter parity.
