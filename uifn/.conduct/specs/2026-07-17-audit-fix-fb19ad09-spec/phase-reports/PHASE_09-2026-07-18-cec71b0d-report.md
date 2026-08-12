# PHASE_09 completion report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-18T12:45:58Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin arm64; shell `zsh`; Node `v20.20.0`; npm `10.8.2` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before and after the phase; user and earlier-phase changes were preserved |
| Phase definition hash | `38c633f4c5d120c3006a8305b475584e48495e63abef241e6c312d0bdbbf83ba` |
| Lockfile hash | `9a78346e07fc1dcc9418d2adb7172ceb81c0dde7cbac9112045f8d3a9d85b6c7` |
| Evidence | `.conduct/evidence/phase-09/2026-07-18T124558Z-PHASE-09-cec71b0d.json` |

## Phase

- Phase: `PHASE_09`
- Status: **PASS**
- Requirements delivered: `PRIM-004`, `PRIM-005`
- Objective: implement canonical selection and input behavior with native form, IME, async-control, capability, and secure-data rigor.

## Outcome

`@uifn/core` now exposes canonical controllers for all seventeen Phase 09 primitives: ten selection/collection primitives and seven editable/input primitives. Selection behavior converges through one private selection substrate; composition-safe text behavior converges through one private input substrate. The old per-primitive model paths for Checkbox, Combobox, RadioGroup, Select, Toggle, and ToggleGroup were removed as a pre-1.0 clean break instead of retained as compatibility shims.

Controlled values remain owner-authoritative. User interactions issue requested values and sequenced reconciliation metadata without mutating a controlled value. Stale async updates are rejected deterministically. Dynamic collection removal and disablement repair focus and selection to a present enabled key. Required, nullable, readonly, disabled, fieldset, reset, label, description, error, and form outcomes share one contract.

Object identity is explicit. Primitive values serialize directly, but objects require a declared item adapter with stable key, text, and serialization functions. There is no `[object Object]` fallback. A native form bridge emits repeated controls for multiple values, observes disabled fieldsets, participates in reset, and uses real constraint validation.

Text input state is composition-aware. Japanese IME updates remain draft-only until `compositionend`; filtering, masking, callback commit, and caret mutation do not occur early. Paste, autofill, selection/caret, locale number parsing and stepping, PIN completion, controlled races, and reset are explicit actions with deterministic state.

Clipboard and file behavior is capability-injected. Denied or unavailable operations fail with stable errors and never report success. File acceptance checks type, size, and count. Passwords, PINs, file names, file payloads, and native file objects are held outside public snapshots and trace payloads. Event-triggered async failures are absorbed after controller state records them, preventing unhandled promise rejections while direct action calls still reject for callers.

React, Svelte, and Solid thin adapters now forward native attributes and complete input event payloads, including composition data, clipboard text, current value, caret positions, input type, pointer data, and current target. React uses canonical event prop casing. Svelte action teardown removes listeners and attributes. Solid root components avoid evaluating `children` while constructing controller input during SSR.

The authoritative phase gate passes 26/26 checks. The durable Playwright corpus passes 36/36 tests across Chromium, Firefox, WebKit, Pixel 7 Chromium, and iPhone 13 WebKit, and its nested stable rerun also passes 36/36. A separate navigation regression stress run passes 15/15 across three repetitions in each of the five projects.

This is Phase 09 development proof, not the final 10/10 readiness verdict. Phases 11–13 still own completed public framework compounds, and Phases 17–20 still own accessibility certification, independent review, and immutable release-candidate proof.

## Primitive and anatomy contract

| Family | Primitive | Canonical parts |
| --- | --- | --- |
| Selection | Checkbox | root, control, indicator, label, hiddenInput |
| Selection | CheckboxGroup | root, label, item, itemControl, itemIndicator, hiddenInput, error |
| Selection | Combobox | root, label, control, input, trigger, clear, positioner, content, item, itemIndicator, empty, hiddenInput |
| Selection | Listbox | root, label, content, item, itemIndicator, group, groupLabel, hiddenInput |
| Selection | RadioGroup | root, label, item, itemControl, itemIndicator, hiddenInput, error |
| Selection | SegmentGroup | root, label, item, itemText, indicator, hiddenInput |
| Selection | Select | root, label, control, trigger, valueText, clear, positioner, content, item, itemText, itemIndicator, group, groupLabel, hiddenInput |
| Selection | TagsInput | root, label, control, item, itemText, itemDelete, input, clear, hiddenInput, error |
| Selection | Toggle | root |
| Selection | ToggleGroup | root, item |
| Input | Autocomplete | root, label, control, input, clear, positioner, content, item, empty |
| Input | Clipboard | root, trigger, status |
| Input | Editable | root, label, preview, input, control, submit, cancel, error, hiddenInput |
| Input | FileUpload | root, label, dropzone, trigger, input, itemGroup, item, itemName, itemSize, itemDelete, error, status |
| Input | NumberInput | root, label, control, input, increment, decrement, scrubber, hiddenInput, error |
| Input | PasswordInput | root, label, input, visibilityTrigger, strength, error |
| Input | PinInput | root, label, control, input, hiddenInput, error |

The generator freezes this inventory in four reviewed outputs. The dist verifier constructs every public controller and requires exact part order and presence.

## Selection, identity, and reconciliation contract

The shared selection substrate defines:

- controlled and uncontrolled state without a hidden mutation path;
- single, multiple, boolean, mixed-checkbox, nullable, and required value modes;
- item adapters for stable keys, display text, equality, and explicit form serialization;
- deterministic item registration, ref-counted unregister, insertion, reorder, disable, and removal repair;
- separate selected, highlighted, focused, open, and input-value state;
- pointer and keyboard selection with disabled/readonly/fieldset enforcement;
- sequenced controlled requests and stale-owner-update rejection;
- validation message, label, description, error, and announcement relationships;
- repeated form values for multi-select controls;
- reset against a valid current collection when the original default was removed;
- immutable state snapshots, part contracts, actions, and lifecycle.

For object values, consumers must provide a `UIFnSelectionItemAdapter<T>` with `getKey`, `getTextValue`, and `serialize` as appropriate. The verified object fixture serializes a `City` object as `city:2`. Omitting serialization for a selected object fails immediately with `UIFN_FORM_VALUE_SERIALIZATION`.

Controlled Select demonstrates the race contract directly: selecting `beta` while the owner value is `alpha` leaves public value at `alpha`, records requested value `beta`, and invokes the owner callback. A reconciliation sequence older than the pending request leaves `alpha` authoritative and records `UIFN_CONTROLLED_UPDATE_STALE`. The matching pending sequence commits `beta` and clears the request.

## Native form and validation contract

`uifn/dom/src/input.ts` owns the browser boundary:

- `createUIFnSelectionFormBinding` maps controller form values into native controls, fieldset state, reset, custom validity, and announcements.
- `createUIFnTextInputFormBinding` supports either a native input or a form bridge, keeps readonly/disabled/required validity synchronized, restores caret in a tracked animation frame, and handles native reset.
- `createUIFnFileInputBinding` converts native `FileList` values at the capability boundary without putting file identity into public state.
- `assertUIFnInputResourcesReleased` fails on remaining form bridges, listeners, observers, timers, animation frames, or live regions.

The browser fixture submits real `FormData` and observes `city:27` plus locale number value `2,0`. A required empty selection fails native validity; selection repairs it to a valid value. Disabling the owning fieldset removes the value from form participation and blocks interaction. Native reset restores valid controller/form state after dynamic collection changes.

Multiple selection values use repeated controls rather than delimiter encoding. Readonly controls remain form participants; disabled controls do not. Object values never reach a form without explicit serialization.

## IME, caret, paste, autofill, and locale contract

The shared input substrate keeps raw input private and exposes redacted public state for secret controls. Composition has three distinct stages:

1. `compositionStart` freezes committed value and filtering while recording caret.
2. `compositionUpdate` updates draft-only data and does not invoke the committed value callback.
3. `compositionEnd` normalizes and commits exactly once, then applies filtering/masking/completion.

The Japanese fixture updates `とう` without filtering the Tokyo option or firing the callback, then commits `東京` exactly once. React, Svelte, and Solid bridge tests prove the framework event carries composition data, input value, selection bounds, and current target into this contract.

Paste inserts at the current selection and restores the resulting caret. Autofill uses the change path and marks its source explicitly. NumberInput derives decimal, group, and minus symbols from `Intl.NumberFormat`; the `de-DE` fixture parses `1,5`, steps by `0.5` to `2,0`, accepts paste, preserves caret, accepts autofill, and resets to the locale-correct default. PinInput delays full-width Japanese composition and fires completion only after a normalized complete value is committed.

Browser autofill evidence exercises native input/change semantics deterministically. It does not claim automation of a particular browser password manager. Mobile evidence uses Playwright Pixel 7 and iPhone 13 emulation with real touch pointer events and mobile viewport behavior; physical OS keyboards and platform IME UI remain part of the later manual accessibility/device matrix.

## Capability and secure-data contract

Clipboard receives a `UIFnClipboardCapability`; DOM supplies a capability rooted in the injected owner window. Missing capability fails `UIFN_INPUT_CAPABILITY_UNAVAILABLE`. Permission denial fails `UIFN_CLIPBOARD_DENIED`, leaves `operationCount` at zero, and sets error state. A trigger click records the same error state without producing an unhandled rejection; callers invoking `actions.copy()` still receive the rejection.

FileUpload receives a `UIFnFilePickerCapability`. The DOM native picker configures accept/multiple state, tracks change/cancel listeners, releases them on every outcome, and returns file descriptors only at the private action boundary. Type, size, and count rejection set `UIFN_FILE_REJECTED`, increment rejected count, leave accepted file count at zero, and invoke the reviewed rejection callback. No production path reports fake file-picker success.

PasswordInput and PinInput expose raw values only through explicit private actions required to bind the native input. Their public state reports length/completion/masking metadata, never content. FileUpload public state reports counts/bytes/status, never names or native objects. The negative evidence serializes controller snapshots and DOM traces and proves absence of password content, PIN content, file name, file payload, and native bytes.

## Framework adapter requirements and proof

The framework-neutral adapter inventory now contains 37 primitives and maps every Phase 09 slug to its canonical controller. React, Svelte, and Solid each expose generic factories/hooks/actions for the eleven newly introduced adapter surfaces; existing bespoke Checkbox, Combobox, RadioGroup, Select, Toggle, and ToggleGroup surfaces point to the canonical core.

The framework event bridges now:

- use exact framework handler names for `input`, `change`, `select`, `paste`, all composition events, context menu, and scroll;
- forward key, pointer, button, coordinates, related target, composition state/data, clipboard text, input type, value, selection bounds, and current target;
- project native attributes such as autocomplete, input mode, min/max length, readonly, type, name, value, form, and multiple;
- preserve user-before-core event composition and default-prevention semantics;
- project class and ref fields at the framework boundary;
- release Svelte listeners, attributes, and styles on action teardown;
- avoid eager Solid `children` evaluation during controller construction and SSR.

Targeted runtime results:

| Adapter | Conformance and Phase 09 event tests | Result |
| --- | ---: | --- |
| React | 5 | PASS |
| Svelte | 5 | PASS |
| Solid | 8 | PASS |

All three package typechecks pass. React's full 28-file / 73-test suite also passes. The existing package-wide Svelte component suite still contains legacy components that expect removed pre-1.0 controller fields/methods, and the Solid matrix contains one legacy test that mutates actions after owner disposal even though the canonical lifecycle now throws on post-destroy use. Their migrations are already assigned to `PHASE_12` and `PHASE_13`; they were not hidden or converted into Phase 09 shims. Completed public compound/native-form parity remains a Phase 11–13 exit condition.

## Browser evidence

The durable authoritative browser result contains 36 passing tests:

| Project | Tests | Result |
| --- | ---: | --- |
| Chromium desktop | 10 | PASS |
| Firefox desktop | 10 | PASS |
| WebKit desktop | 10 | PASS |
| Pixel 7 / mobile Chromium | 3 | PASS |
| iPhone 13 / mobile WebKit | 3 | PASS |

Every desktop project runs seven inherited DOM vectors plus the complete input, navigation, and overlay matrices. Each mobile project runs the complete input, navigation, and overlay matrices. Phase 09 input evidence therefore runs once in all five projects and proves:

- real native `FormData` and constraint-validation outcomes;
- object serialization through a declared adapter;
- required repair and reset after dynamic removal;
- disabled fieldset behavior;
- Japanese IME draft/commit behavior;
- locale number stepping and caret preservation;
- denied clipboard and rejected file outcomes;
- password, PIN, and file redaction;
- touch selection;
- zero owned input resources after teardown.

The browser directory contains the JSON result, 36 traces, and 36 screenshots. The final aggregate invokes the stable gate, which independently repeats the same 36-test matrix and also passes.

## Inherited navigation regression found and fixed

Repeated aggregate runs initially exposed intermittent WebKit navigation failures. The product state changed synchronously, but the Phase 08 fixture used fixed 20–45 ms waits for requestAnimationFrame focus and delayed intent. Those assertions now use bounded state/focus conditions.

Strengthening the pointer-grace fixture beyond its configured 120 ms delay then exposed a real DOM bug: moving inside the safe triangle was recognized, but the original fallback timeout remained active and closed the submenu anyway. `createUIFnMenuDomBinding` now cancels fallback dismissal when the pointer enters the corridor while retaining the triangle for subsequent leave detection. Leaving the triangle still schedules closure.

A dedicated stress run repeats the navigation vector three times in each of five browser projects: 15/15 pass. The authoritative and nested stable matrices both pass afterwards. This is an inherited prerequisite repair required to keep Phase 09's entry gate honest, not Phase 10 work.

## Requirement evidence

### PRIM-004 — Selection and collection families

Status: **PASS**

Acceptance criterion 1: controlled/uncontrolled, single/multiple, nullable/required, disabled/readonly, dynamic, and reset semantics are explicit and tested.

- All ten controllers use the canonical selection substrate and exact generated anatomy.
- Controlled Select remains owner-authoritative and rejects stale reconciliation.
- Listbox repairs after removal, enforces disabled fieldset interaction, retains valid form state, and resets against the current collection.
- Multi-value, boolean/mixed, nullable, required, readonly, open, highlighted, selected, and focus state have separate contracts.

Acceptance criterion 2: value identity and serialization are deterministic for primitives and objects via declared item adapters.

- Object keys and form serialization require explicit adapter functions.
- The City fixture serializes as `city:2`.
- Implicit object serialization fails exact code `UIFN_FORM_VALUE_SERIALIZATION`.
- Dynamic registration is stable-keyed and ref-counted rather than DOM-position based.

Acceptance criterion 3: keyboard, IME, touch, form, label/description/error, and announcement vectors pass across the three adapter labels.

- Adapter-kit conformance passes 16/16 with all Phase 09 slugs present.
- React, Svelte, and Solid targeted conformance/event tests pass.
- The five-project browser corpus proves native form, Japanese composition, touch selection, ARIA/form relationships, and cleanup.
- Completed public compound parity remains explicitly assigned to Phases 11–13.

### PRIM-005 — Text, editable, and file-input families

Status: **PASS**

Acceptance criterion 1: composition events do not prematurely filter, commit, mask, or move the caret.

- Japanese Autocomplete composition remains draft-only, leaves options visible, and fires no committed callback until composition end.
- PinInput completion is deferred until composition end.
- Framework bridges preserve composition data, value, and selection bounds.
- Controlled mutation of filtering/masking during composition is classified as `UIFN_IME_COMMIT_EARLY`.

Acceptance criterion 2: clipboard and file operations are capability-injected, permission/error aware, and never serialize secret/file content into traces.

- Missing capability fails closed.
- Clipboard denial never increments success count.
- File type/size/count rejection never enters accepted state.
- Password, PIN, file identity, native objects, and payloads are absent from public snapshots and durable evidence.
- Resource accounting covers picker listeners and live regions.

Acceptance criterion 3: locale parsing, stepping, paste, autofill, reset, and async-controlled update races pass browser vectors.

- `de-DE` parse/step/paste/autofill/reset behavior passes core and browser evidence.
- Caret movement is bounded and restored through the scoped scheduler.
- Controlled selection requests reject stale owner sequences and commit matching sequences.
- Native form reset and fieldset behavior pass in all five projects.

## Controlled-negative evidence

| Mutation or defect | Required classification | Result |
| --- | --- | --- |
| Controlled selection mutates before owner reconciliation | `UIFN_CONTROLLED_STATE_DIVERGED` | killed |
| Object value falls back to implicit string conversion | `UIFN_FORM_VALUE_SERIALIZATION` | killed |
| Autocomplete filters or secret input masks during composition | `UIFN_IME_COMMIT_EARLY` | killed |
| Password/PIN/file content reaches state, snapshots, or trace evidence | `UIFN_TRACE_SECRET` | killed |
| Stale controlled update is accepted | `UIFN_CONTROLLED_UPDATE_STALE` | killed |
| Clipboard permission denial is reported as success | `UIFN_CLIPBOARD_DENIED` | killed |
| Rejected file is reported as accepted | `UIFN_FILE_REJECTED` | killed |
| Ambient/missing clipboard or file capability is treated as available | `UIFN_INPUT_CAPABILITY_UNAVAILABLE` | killed |
| Teardown leaves an input-owned DOM resource | `UIFN_INPUT_RESOURCE_LEAK` | killed |

Exact error codes are asserted; a generic thrown error or non-zero process exit is not accepted as mutation evidence.

## Generated and release-contract proof

`scripts/generate-uifn-phase-09.mjs` owns four checked-in outputs:

- `phase-09-exports.json` — the reviewed seventeen factories and exact anatomy.
- `phase-09-input-contracts.json` — selection, input, browser, framework, and negative-code contracts.
- `phase-09-test-manifest.json` — required vectors and fixtures.
- `phase-09-types.d.ts` — generated public controller type presence.

The check mode is byte-for-byte clean. The contract verifier rejects missing controllers, old model constructors, core browser-global reads, implicit object conversion, absent canonical substrates, absent DOM capabilities, missing framework exports, anatomy drift, controlled mutation, early IME commit, and secret snapshot content.

The public core entrypoint passes Node 20, 22, and 24 while `document` and `window` throw on read. DOM source ownership scans 212 framework files with zero violations. The package pack verifier passes for all stable packages. Catalog generation remains deterministic at 61 canonical primitives. Governance owns `verify:uifn-phase-09` under `uifn-maintainer` with the existing seven-day cadence.

## Verification summary

### Authoritative gate

`npm run verify:uifn-phase-09` — **PASS**, 26/26 top-level checks.

Included results:

1. `npm --workspace @uifn/core run typecheck` — PASS.
2. `npm --workspace @uifn/core run test` — PASS, 29 files / 147 tests.
3. `npm --workspace @uifn/core run build` — PASS.
4. `npm --workspace @uifn/dom run typecheck` — PASS.
5. `npm --workspace @uifn/dom run test` — PASS, 1/1.
6. `npm --workspace @uifn/dom run build` — PASS.
7. `npm --workspace @uifn/adapter-kit run typecheck` — PASS.
8. `npm --workspace @uifn/adapter-kit run test` — PASS, 4 files / 16 tests.
9. `npm --workspace @uifn/adapter-kit run build` — PASS.
10. `node --test scripts/verify-uifn-phase-09-contract.test.mjs` — PASS, 4/4.
11. `node scripts/verify-uifn-phase-09-contract.mjs --require-dist` — PASS, 17 primitives, three framework labels, zero issues.
12. `node scripts/generate-uifn-phase-09.mjs --check` — PASS, four outputs.
13. `npm --workspace @uifn/dom run test:browser` — PASS, 36/36 in five projects.
14. `node scripts/verify-uifn-dom-platform.mjs --require-dist` — PASS, 212 files, zero violations.
15. `node scripts/verify-uifn-controller-contract.mjs --require-dist` — PASS, 41 controllers.
16. `node scripts/verify-uifn-runtime-architecture.mjs --require-dist` — PASS, zero issues and zero production trace payloads.
17. `node scripts/verify-uifn-core-node-matrix.mjs` — PASS, Node 20/22/24.
18. `npm --workspace @uifn/react run typecheck` — PASS.
19. `npm --workspace @uifn/svelte run typecheck` — PASS.
20. `npm --workspace @uifn/solid run typecheck` — PASS.
21. React targeted core/event tests — PASS, 5/5.
22. Svelte targeted core/event tests — PASS, 5/5.
23. Solid targeted core/event tests — PASS, 8/8.
24. `node scripts/generate-uifn-catalog.mjs --check` — PASS, 61 primitives and deterministic outputs.
25. `node scripts/verify-uifn-pack.mjs` — PASS.
26. `node scripts/verify-uifn-stable.mjs` — PASS, including governance, consumers, pack hygiene, and a second 36-test browser pass.

Additional focused results:

- React full suite — PASS, 28 files / 73 tests.
- Navigation regression stress — PASS, 15/15 across three repetitions in five projects.
- Governance — PASS, 10/10 checks and 35 owned release gates.
- `git diff --check` — required as the final worktree hygiene check after report creation.

Vite's CJS Node API and `NO_COLOR` notices are toolchain warnings. No failure was suppressed, retried, marked flaky, or skipped.

## Deliverables summary

### Added

- Canonical core substrates: `selection-control.ts` and `input-control.ts`.
- New core primitives: CheckboxGroup, Listbox, SegmentGroup, TagsInput, Autocomplete, Clipboard, Editable, FileUpload, NumberInput, PasswordInput, and PinInput.
- Rebuilt canonical controllers for Checkbox, Combobox, RadioGroup, Select, Toggle, and ToggleGroup.
- `phase-09-selection-input.test.ts`.
- Four Phase 09 generated contract outputs.
- DOM input/form/capability bindings and the five-project input browser harness/spec.
- React, Svelte, and Solid input event bridge tests.
- React/Svelte/Solid generic Phase 09 exports.
- Phase 09 generator, contract verifier, mutation tests, and aggregate verifier.
- Phase 09 durable browser, stress, and JSON evidence.

### Replaced or modified

- Core public primitive/controller exports, error taxonomy, part-event payload, and controller contract inventory.
- Form bridge empty-value required validation.
- Adapter-kit canonical inventory and conformance vectors.
- React part projection, Select structure/registration cleanup, and Solid SSR root input handling.
- Svelte part projection and cleanup.
- DOM resource assertion and native file/clipboard boundaries.
- Root package scripts and release-gate ownership.
- Inherited menu pointer-grace behavior and navigation browser synchronization.

### Removed

- Superseded core model tests for Checkbox, Combobox, RadioGroup, Select, Toggle, and ToggleGroup.
- Superseded model blocks from the old controller aggregation path.

These removals are deliberate pre-1.0 clean breaks. No legacy core behavior shim was added.

## Notes and limitations

- Evidence contains no raw password, PIN, file name, file content, or native file object.
- Capability failure is observable both as controller error state and direct-action rejection; UI event triggers do not create unhandled rejections.
- Native picker cancellation is represented as a stable recoverable file error; no fake success fallback exists.
- Playwright mobile projects are device emulation, not physical screen-reader/keyboard certification.
- Browser autofill is exercised through native input/change event semantics, not a vendor password-manager UI.
- Public compound completion and package-wide adapter migrations remain in their already assigned framework phases.
- Automated axe/AT proof, manual VoiceOver/NVDA/TalkBack proof, independent audit, and immutable release-candidate evidence remain later phases.
- No commit, push, publication, or external state change was performed.
- The phase is not final; `.conduct/tracker.csv` was intentionally not advanced. The final spec phase remains Phase 20.

## Ready for next phase?

**Yes.** Phase 10 can implement range, gesture, structured date/time/color, status, and notification families on the canonical controller, DOM platform, resource, form, event, and evidence contracts. All Phase 09 exit gates and inherited prerequisites pass.

## Blockers

None for Phase 10. The overall 10/10 program remains incomplete until the remaining primitive families, React/Svelte/Solid public compounds, cross-framework parity, documentation, automated and manual accessibility matrices, independent review, and immutable release-candidate gates complete in later phases.
