# PHASE_05 — DOM platform services

## Objective

Build the sole production DOM behavior layer used by every primitive and framework.

## Entry

- Phase 04 controller/environment contracts pass.
- Any proposed focused dependency is license/security/size reviewed and wrapped behind owned contracts.

## Requirements

- `DOM-001` through `DOM-007`.

## Work

1. Implement root scope/event delegation, modality/focus-visible, robust tabbable/focusable discovery, observers, and zero-consumer teardown in `uifn/dom` (`@uifn/dom`).
2. Implement composed-path dismissable layers with branches, nesting, pointer/focus outside, Escape, cancellation, and top-layer routing.
3. Implement nested focus scopes, modal isolation/inertness, pointer blocking, scroll locks/compensation, iOS viewport behavior, and exact restoration.
4. Implement production positioning/middleware/auto-update for clipping ancestors, transforms, zoom, mobile visual viewport, RTL, virtual anchors, arrow/size/hide.
5. Implement root-aware portals, presence/transition/reduced-motion lifecycle, native form bridges, live regions, and all cleanup/error contracts.
6. Delete/reject framework-local equivalents; adapters may only bind these services.

## Required evidence

- `TV-DOM-001-P/N` through `TV-DOM-007-P/N` in Chromium, Firefox, and WebKit during development, with later device confirmation owned by Phase 14/18.
- Geometry/focus/layer/form/live-region traces and screenshots for pass and intended negative failures.
- Stress mount/interact/destroy evidence shows zero listeners, observers, timers, animation frames, detached nodes, stale inert/style/ARIA state.

## Exit gate

All DOM services meet their behavioral contracts across documents, iframes, portals, open shadow roots, nesting, abrupt unmount, SSR/hydration, and browser edge fixtures; no adapter owns equivalent logic.

## Do not

- Do not embed primitive-specific selection/state logic.
- Do not expose dependency APIs as uifn contracts.
- Do not accept jsdom-only proof for browser geometry/focus/layer behavior.

## Handoff

Phase report provides stable DOM service APIs, dependency rationale, resource accounting, browser evidence, and the primitive integration recipes used in Phases 06–10.
