# PHASE_07 — Overlay and modal primitives

## Objective

Implement every stable overlay/modal family using only controllers plus the shared DOM platform.

## Entry

- Phase 05 DOM services and Phase 06 shared foundations pass.

## Requirements

- `PRIM-002`.

## Work

1. Implement AlertDialog, Dialog, Drawer, FloatingPanel, HoverCard, Popover, Tooltip, and Tour canonical logic, typed parts, inputs/events/callbacks, and lifecycle.
2. Encode per-primitive modal/non-modal, title/description, initial/return focus, dismissal, pointer/touch interaction, hover delay, controlled open, presence, portal, and positioning policy.
3. Build nested cross-type matrices, including menu/popover/dialog stacks, portaled/shadow branches, trigger removal, close/reopen races, mobile viewport/keyboard, and abrupt unmount.
4. Remove all prior framework/local overlay, focus, outside-click, scroll-lock, portal, presence, and geometry forks as consumers migrate later; static scans prevent new ones.

## Required evidence

- `TV-PRIM-002-P/N` plus applicable `TV-DOM-002`–`TV-DOM-006` regression vectors.
- Primitive-specific negative cases, especially AlertDialog naming/dismissal and Tooltip hover/focus/touch semantics.
- Real-browser semantic/focus/geometry/resource traces; axe alone is insufficient.

## Exit gate

All eight primitives have complete canonical logic/parts and pass nested real-browser behavior with zero local DOM-service forks or leaks.

## Do not

- Do not make all overlays share identical dismissal/focus defaults.
- Do not accept generic “overlay opened” assertions where a specific focus/dismissal/geometry result is required.

## Handoff

Phase report records each policy table and the actual trace corpus framework compounds must preserve.
