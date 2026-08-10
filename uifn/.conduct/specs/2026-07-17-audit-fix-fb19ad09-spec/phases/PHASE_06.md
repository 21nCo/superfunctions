# PHASE_06 — Shared algorithms and foundational primitives

## Objective

Create canonical shared algorithms and implement the foundational/static/disclosure family without duplicate behavior.

## Entry

- Phases 02–05 pass; catalog definitions, controller contracts, and DOM services are stable enough for primitive work.

## Requirements

- `CAT-002`, `PRIM-001`.

## Work

1. Implement canonical collection, roving navigation, selection, typeahead, locale/value text, range, and ID helpers with model/property suites and virtualization extension points.
2. Implement Accordion, Avatar, Button, Collapsible, Field, Fieldset, Form, ImageCropper, Input, Marquee, QRCode, ScrollArea, Separator, and Toolbar from catalog logic/anatomy.
3. Prefer native elements/semantics; use controllers only where behavior exists, and prove static contracts add no subscription/effect cost.
4. Generate headless exports/types/test manifests but defer framework compound completion to Phases 11–13.
5. Delete older per-primitive algorithms/creators as each canonical implementation lands.

## Required evidence

- `TV-CAT-002-P/N`, `TV-PRIM-001-P/N`.
- Per-primitive controller/parts/native/a11y/form/SSR vectors plus generated-sequence algorithm evidence.
- Package/source harnesses may use thin temporary render fixtures but MUST exercise public controller/parts, not sidecar probes.

## Exit gate

Shared algorithms are the only applicable implementations, all listed primitives meet canonical contracts, and no static primitive pays interactive runtime cost.

## Do not

- Do not implement adapter-owned behavior or polished framework APIs early.
- Do not broaden primitive behavior beyond canonical definitions without updating schema/vectors first.

## Handoff

Phase report lists shared algorithms, primitive completeness, removed duplicates, seeds, traces, and remaining adapter work.
