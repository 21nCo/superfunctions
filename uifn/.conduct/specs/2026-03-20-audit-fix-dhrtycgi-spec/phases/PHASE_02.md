# Phase goal

Bring the core disclosure, form, and range families to the published contract so adapters can reuse trustworthy semantics.

# In scope / Out of scope

In scope:

- `Accordion`, `Collapsible`, `Tabs`, `ToggleGroup`
- `Checkbox`, `Switch`, `Toggle`, `RadioGroup`
- `Slider`, `Progress`
- Shared collection-state helpers required by those families

Out of scope:

- Popup families
- Select/Combobox/Menu/ScrollArea

# Deliverables

- `uifn/core/src/primitives/accordion.ts`
- `uifn/core/src/primitives/collapsible.ts`
- `uifn/core/src/primitives/tabs.ts`
- `uifn/core/src/primitives/toggle-group.ts`
- `uifn/core/src/primitives/checkbox.ts`
- `uifn/core/src/primitives/switch.ts`
- `uifn/core/src/primitives/toggle.ts`
- `uifn/core/src/primitives/radio-group.ts`
- `uifn/core/src/primitives/slider.ts`
- `uifn/core/src/primitives/progress.ts`
- `uifn/core/src/primitives/index.ts`
- `uifn/core/src/primitives/**/*.test.ts`

# Requirements covered

- `CORE-001`
- `CORE-004`
- `DISC-001`
- `FORM-001`
- `RANGE-001`

# Implementation tasks

- [ ] Implement stable controlled/uncontrolled rules for all in-scope families.
- [ ] Move roving-focus and keyboard semantics into reusable core helpers.
- [ ] Implement correct disabled behavior and change-reason metadata.
- [ ] Implement hidden-input/form serialization rules where applicable.
- [ ] Implement multi-thumb slider ordering, clamping, and step alignment.
- [ ] Add unit tests for positive and negative family vectors.

# Verification steps

- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm test -- --run accordion collapsible tabs toggle-group checkbox switch toggle radio-group slider progress`
- `cd /Users/serro/Documents/dev/n/superfunctions/uifn/core && npm run build`
- Re-run the release-gate suite in partial mode if available

Expected outcomes:

- Core family tests pass for in-scope primitives.
- Controlled and uncontrolled paths produce the same deterministic state transitions described in the vectors.

# Stop condition

Report which shared collection/form helpers now live in core and confirm the core family vector coverage before starting popup/select/menu behavior.
