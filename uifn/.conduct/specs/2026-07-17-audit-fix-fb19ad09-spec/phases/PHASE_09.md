# PHASE_09 — Selection, editable, and input primitives

## Objective

Implement canonical selection and input behavior with native form, IME, async-control, and secure-data rigor.

## Entry

- Phase 06 algorithms and Phase 05 form/live/DOM services pass.
- Phase 08 collection/navigation behavior is available where shared.

## Requirements

- `PRIM-004`, `PRIM-005`.

## Work

1. Implement Checkbox, CheckboxGroup, Combobox, Listbox, RadioGroup, SegmentGroup, Select, TagsInput, Toggle, and ToggleGroup.
2. Implement Autocomplete, Clipboard, Editable, FileUpload, NumberInput, PasswordInput, and PinInput.
3. Define and test controlled/uncontrolled, single/multiple, nullable/required, object identity/serialization, reset, fieldset, validation, label/description/error, disabled/readonly, dynamic collection, and async reconciliation.
4. Implement composition/caret/paste/autofill/locale-step semantics; capability-inject clipboard/file operations and redact secrets/files from traces.
5. Exercise mobile touch/virtual keyboard and browser autofill where applicable; add deterministic fallbacks for unavailable capabilities.

## Required evidence

- `TV-PRIM-004-P/N`, `TV-PRIM-005-P/N`, and applicable `TV-DOM-007` regressions.
- Japanese IME, object-value form, disabled-fieldset, controlled-race, denied clipboard, file rejection, password redaction, and reset fixtures.
- Public controller/parts outcomes and real native `FormData`/validation evidence.

## Exit gate

All seventeen primitives preserve controlled/native/IME/security semantics across adverse updates and no secret/file content reaches evidence.

## Do not

- Do not stringify object identity implicitly.
- Do not commit composition text before composition end unless a primitive’s reviewed contract explicitly requires it.
- Do not fake file/clipboard success in production paths.

## Handoff

Phase report lists value/serialization contracts, capability errors, browser limitations, traces, and adapter form requirements.
