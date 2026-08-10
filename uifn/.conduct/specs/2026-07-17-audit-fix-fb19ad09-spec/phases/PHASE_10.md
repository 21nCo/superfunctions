# PHASE_10 — Gesture, date/color, feedback, and internationalization

## Objective

Complete the remaining behavior families and prove locale, direction, timezone, touch, timing, and announcement correctness across the catalog.

## Entry

- Phases 05–09 pass and shared range/locale/collection primitives are stable.

## Requirements

- `PRIM-006`, `PRIM-007`, `PRIM-008`, `I18N-001`.

## Work

1. Implement AngleSlider, Carousel, RatingGroup, Slider, SignaturePad, and Splitter with pointer capture/cancel, touch arbitration, keyboard, precision, orientation/RTL, multi-thumb/pointer, and reduced-motion policies.
2. Implement ColorPicker, DateInput, DatePicker, and Timer using structured values, explicit locale/calendar/timezone/color models, injected clocks, DST/visibility handling, and deterministic parsing/conversion.
3. Implement Meter, Progress, Steps, and Toast (and complete workflow/status aspects of TreeView) with native/ARIA states, queue/timer/pause/swipe, announcements, and cleanup.
4. Apply Arabic RTL, Hindi, Japanese IME, and European-locale scenarios across every applicable primitive; eliminate hardcoded English/LTR/ambient-time assumptions.
5. Add property/model, fake-clock, real pointer/touch, mobile, rate-limited announcement, and lifecycle stress suites.

## Required evidence

- `TV-PRIM-006-P/N` through `TV-PRIM-008-P/N` and `TV-I18N-001-P/N`.
- Pointer lost-capture/cancel, zoom, RTL axis, DST fold/gap, locale calendar, timer drift, toast queue/pause/destroy, and announcement-flood fixtures.
- Catalog completeness check shows all 61 primitives have an implemented canonical logic/static contract and no legacy path.

## Exit gate

All behavior families meet canonical model, input modality, localization, announcement, timing, and cleanup contracts; catalog behavior implementation is complete before adapter work closes.

## Do not

- Do not parse display dates/numbers with ambient host behavior.
- Do not use accumulating intervals as the authoritative elapsed-time model.
- Do not treat desktop pointer tests as touch evidence.

## Handoff

Phase report supplies the complete golden controller/parts/DOM trace corpus that all three adapters must reproduce.
