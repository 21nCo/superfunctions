# PHASE_10 completion report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-18T13:49:00Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin arm64; shell `zsh`; Node `v22.22.1`; npm `10.9.4` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before and after the phase; user and earlier-phase changes were preserved |
| Phase definition hash | `a48fa6bed8b053508300856752023f8f14d4d7d1b8f3e01ca6cb1901aaa9eacb` |
| Lockfile hash | `9a78346e07fc1dcc9418d2adb7172ceb81c0dde7cbac9112045f8d3a9d85b6c7` |
| Evidence | `.conduct/evidence/phase-10/2026-07-18T1906+0530-PHASE-10-7f3c9a/browser/results.json` and `.conduct/evidence/phase-10/2026-07-18T1906+0530-PHASE-10-7f3c9a/results.json` |

## Phase

- Phase: `PHASE_10`
- Status: **PASS**
- Requirements delivered: `PRIM-006`, `PRIM-007`, `PRIM-008`, `I18N-001`
- Objective: complete the remaining behavior families and prove locale, direction, timezone, touch, timing, announcement, and cleanup correctness before framework compound completion.

## Outcome

The catalog behavior layer is complete. `@uifn/core` now exposes canonical contracts for all fourteen Phase 10 primitives: twelve interactive controllers and two typed static contracts. TreeView also exposes explicit workflow status. The generated catalog proof constructs all 61 canonical primitives and finds no legacy state-machine or `create*Model` path.

Range and gesture behavior converges through shared pure algorithms and controller policy. Slider, AngleSlider, Carousel, RatingGroup, SignaturePad, and Splitter cover finite precision, orientation, RTL, keyboard stepping, pointer capture, cancel/lost-capture terminal state, touch-axis arbitration, multi-pointer or multi-thumb behavior, zoom, reduced motion, controlled values, and cleanup. Reduced-motion Carousel state now reports `idle` when autoplay is suppressed rather than claiming an autoplay timer exists.

Date, color, and time behavior uses structured values. DateInput and DatePicker use explicit calendar dates, locale, calendar, timezone, month grids, availability predicates, and deterministic ISO serialization. Zoned date resolution classifies DST gaps and folds without `Date.parse`. ColorPicker converts sRGB/HSL/alpha through bounded channels with a one-byte round-trip budget. Timer derives elapsed time from an injected authoritative clock and one-shot scheduling; non-finite public inputs fail before runtime snapshot creation.

Meter, Progress, Steps, Toast, and TreeView expose native or ARIA status. Toast owns limit/queue policy, finite deadline scheduling, persistent deadlines, multiple pause reasons, swipe cancel/dismiss, duplicate policy, ordered dismiss/remove callbacks, deduplicated announcements, route cleanup, and destruction. Persistent deadlines use serializable `null`, never `Infinity`, in state. Progress now has canonical label/track/range/circle/valueText anatomy, and React maps its SVG attribute without DOM warnings.

Arabic RTL, Hindi, Japanese calendar/IME-adjacent display, German, and French scenarios are frozen in the generated corpus. Core does not manufacture English sentences when the consumer has not supplied localized text. Numeric/date formatting uses explicit locale data; direction comes from the environment or public inputs.

The authoritative phase gate passes 26/26 checks. The durable Playwright matrix passes 41/41 tests across desktop Chromium, Firefox, WebKit, Pixel 7 Chromium emulation, and iPhone 13 WebKit emulation, with zero skipped, flaky, or unexpected results. The nested stable gate independently repeats the browser matrix and also passes.

This is Phase 10 development proof, not the final 10/10 release verdict. Phases 11–13 still own complete React/Svelte/Solid public compounds, Phase 14 owns parity, and Phases 15–20 own documentation, automated/manual accessibility certification, independent review, and immutable release-candidate proof.

## Primitive and anatomy contract

| Family | Primitive | Kind | Canonical parts |
| --- | --- | --- | --- |
| Gesture | AngleSlider | controller | root, track, thumb, valueText, hiddenInput |
| Gesture | Carousel | controller | root, viewport, item, previous, next, indicatorGroup, indicator, liveRegion |
| Structured value | ColorPicker | controller | root, label, control, trigger, positioner, content, area, areaThumb, channelSlider, channelInput, swatch, hiddenInput |
| Structured value | DateInput | controller | root, label, segment, hiddenInput, error |
| Structured value | DatePicker | controller | root, label, input, segment, trigger, positioner, content, header, previous, next, grid, gridLabel, cell, cellTrigger, hiddenInput |
| Feedback | Meter | static contract | root, label, track, range, valueText |
| Feedback | Progress | static contract plus transition controller | root, label, track, range, circle, valueText |
| Gesture | RatingGroup | controller | root, label, control, item, itemIndicator, hiddenInput, valueText |
| Gesture | SignaturePad | controller | root, label, canvas, clear, undo, status, hiddenInput |
| Gesture | Slider | controller | root, label, control, track, range, thumb, valueText, hiddenInput |
| Gesture | Splitter | controller | root, panel, resizeTrigger, resizeHandle |
| Feedback | Steps | controller | root, list, item, trigger, indicator, separator, content, completed |
| Structured time | Timer | controller | root, value, start, pause, reset, status |
| Feedback | Toast | controller | viewport, root, title, description, action, close |

TreeView retains its Phase 08 anatomy and now adds `pending`, `current`, `complete`, and `error` workflow state, including `aria-current="step"`, `aria-invalid`, loading transitions, and programmatic status updates.

## PRIM-006 — Range and gesture families

Status: **PASS**

Acceptance proof:

- `gesture.ts` and the shared range algorithms own exact alignment, decimal precision, PageUp/PageDown/Home/End, orientation, RTL direction, axis percent, closest-thumb selection, thumb collision, splitter pair conservation, carousel index resolution, and touch-axis arbitration.
- Slider supports multiple thumbs and simultaneous pointer records. Pointer cancel and lost capture remove only the terminal pointer and block stale movement.
- SignaturePad supports simultaneous strokes and discards only the cancelled pointer's active stroke.
- Splitter preserves a 100-percent total while honoring per-panel minimum and maximum bounds.
- Carousel drag direction is logical in RTL, pauses by reason, clears every timer, and suppresses autoplay under reduced motion while reporting truthful interaction state.
- Controller parts expose native slider/separator/radiogroup roles, value bounds/text, orientation, controls, current state, hidden form values, disabled/read-only state, and stable IDs.
- The DOM gesture binding captures each pointer, listens for document-level terminal events, handles direct non-bubbling `lostpointercapture`, tracks multiple pointers, arbitrates `touch-action`, and restores prior style/listener state on destroy.
- Real browser evidence uses actual Playwright mouse input and mobile `tap`; synthetic events are limited to explicit pointer-cancel/lost-capture and multi-pointer terminal fixtures that browser automation cannot reliably initiate as OS gestures.

## PRIM-007 — Structured date, color, and time families

Status: **PASS**

Acceptance proof:

- Calendar dates are `{ calendar, year, month, day }` values, not ambient `Date` objects or display strings.
- ISO parsing accepts reviewed `YYYY-MM-DD` input and rejects host-dependent display parsing with `UIFN_AMBIENT_DATE_PARSE`.
- Month grids are deterministic 42-cell structures with locale first-day-of-week, min/max, unavailable, and disabled policy.
- `America/New_York` fixtures classify the 2024 spring gap and autumn fold, returning two instants for the fold.
- Japanese calendar display, `Asia/Tokyo` timezone, German first-day-of-week, leap-day repair, unavailable-day navigation, and exact hidden serialization pass.
- Color parsing/conversion supports modern hex sRGB and HSL with alpha, clamps channels, serializes deterministically, and round-trips within one byte.
- Timer uses injected `now` and scoped one-shot timeouts. Elapsed time is recomputed from clock anchors across drift, pause, visibility, completion, reset, controlled synchronization, and destroy.
- Duration, remaining time, and announcement intervals must be finite non-negative values; invalid input fails `UIFN_ERR_INVALID_VALUE` before entering the canonical runtime.

## PRIM-008 — Feedback, workflow, and notification families

Status: **PASS**

Acceptance proof:

- Meter publishes `role="meter"`, exact min/max/current/value text, and optimum/warning/critical zone state.
- Progress publishes determinate, indeterminate, complete, and error state. Indeterminate mode omits `aria-valuenow`; determinate text is locale-formatted as a ratio.
- Steps separates current step, per-step workflow state, overall workflow state, completion, linear navigation, errors, current-step semantics, and localized announcements.
- TreeView workflow status is independent of selection, expansion, focus, and loading.
- Toast limits visible records, queues the remainder, promotes deterministically, applies ignore/replace/allow duplicate policy, and preserves dismiss-before-remove callback order.
- Toast deadlines pause by independent hover/focus/window reasons and resume from clock-derived remaining time. Persistent toasts use `duration: null` and `remaining: null`, keeping snapshots JSON-compatible.
- Swipe below threshold cancels; swipe above threshold dismisses. Route change clears the queue before dismissing visible records, preventing promotion survivors.
- Each toast ID is announced once with its declared politeness. Live-region publication is deduplicated and rate-limited.
- Destroy clears all timers; no callback fires afterward. DOM resource accounting reaches zero.

## I18N-001 — Locale, direction, timezone, and message policy

Status: **PASS**

| Scenario | Proof |
| --- | --- |
| Arabic RTL | Logical ArrowRight decrement, RTL axis percent, Arabic-formatted value text, touch and pointer behavior |
| Hindi | Locale number output for angle/rating/steps without embedded English sentences |
| Japanese | Japanese-calendar display and explicit `Asia/Tokyo` timezone; structured value remains Gregorian-compatible data |
| German | Decimal/date formatting and Monday first day of week |
| French | Frozen generated corpus and locale formatter coverage |

Localized labels/messages are consumer inputs where platform-neutral defaults would require English prose. Universal channel symbols (`R`, `G`, `B`, `H`, `S`, `L`, `alpha`) remain overrideable. Direction, locale, calendar, and timezone are explicit controller/environment values rather than ambient browser assumptions.

## Controlled-negative evidence

| Mutation or defect | Required classification | Result |
| --- | --- | --- |
| Movement continues after pointer cancel/lost capture | `UIFN_GESTURE_AFTER_CANCEL` | killed |
| RTL movement uses physical rather than logical direction | `UIFN_RANGE_DIRECTION_INVALID` or `UIFN_RTL_KEYBOARD_DIVERGED` | killed |
| Display date is parsed through ambient host behavior | `UIFN_AMBIENT_DATE_PARSE` | killed |
| Structured calendar date is invalid | `UIFN_DATE_VALUE_INVALID` | killed |
| Color format/channel data is invalid | `UIFN_COLOR_VALUE_INVALID` | killed |
| Timer drifts beyond the authoritative clock budget | `UIFN_TIMER_DRIFT_BUDGET` | killed |
| Announcement publication exceeds its budget | `UIFN_ANNOUNCEMENT_FLOOD` | killed |
| Timer/Toast callback survives destroy | `UIFN_TIMER_AFTER_DESTROY` | killed |
| English/LTR default leaks into localized behavior | `UIFN_UNLOCALIZED_DEFAULT` | killed |
| Non-finite Timer input reaches a runtime snapshot | `UIFN_ERR_INVALID_VALUE` | killed |

Exact codes and state outcomes are asserted. Generic process failure is not treated as mutation proof.

## Browser evidence

The authoritative Playwright result contains 41 passing cases:

| Project | Tests | Result |
| --- | ---: | --- |
| Chromium desktop | 11 | PASS |
| Firefox desktop | 11 | PASS |
| WebKit desktop | 11 | PASS |
| Pixel 7 / mobile Chromium | 4 | PASS |
| iPhone 13 / mobile WebKit | 4 | PASS |

The Phase 10 matrix runs once in every project and proves:

- actual pointer capture, movement, release, and zoom-aware RTL percent calculation;
- direct `lostpointercapture`, explicit pointer cancellation, and simultaneous pointer cleanup;
- real mobile touch input in both mobile projects;
- RTL keyboard state change through rendered part props;
- Japanese calendar/timezone and unavailable-date grid state;
- sRGB/HSL/alpha round-trip;
- native Meter/Progress state, Steps current state, and Toast visible/queued/paused state;
- live-region dedupe with one publication;
- restored `touch-action` and zero owned DOM resources after teardown.

The JSON report has `expected: 41`, `skipped: 0`, `unexpected: 0`, and `flaky: 0`. Each Phase 10 project result includes the attached structured vector result and screenshot evidence. The nested stable gate repeats all 41 browser cases independently.

## Generated and release-contract proof

`scripts/generate-uifn-phase-10.mjs` owns five checked-in outputs:

- `phase-10-exports.json` — fourteen public contracts/factories and exact anatomy.
- `phase-10-behavior-contracts.json` — gesture, structured value, feedback, locale, browser, and negative-code policy.
- `phase-10-golden-corpus.json` — deterministic operations, trace channels, anatomy, and locale matrix.
- `phase-10-test-manifest.json` — all eight positive/negative vectors and twelve mandatory fixtures.
- `phase-10-types.d.ts` — generated public type/factory presence.

Check mode is byte-for-byte clean. The contract verifier constructs all fourteen Phase 10 surfaces and all 61 catalog contracts from built output. It rejects anatomy drift, missing public symbols, legacy `create*Model` factories, the retired state-machine path, ambient `Date.parse`, accumulating `setInterval`, browser-global reads in core, missing shared algorithms, missing DOM gesture ownership, and missing TreeView workflow status.

The public core entrypoint passes Node 20, 22, and 24 while `document` and `window` throw on read. Its Toast interaction verifies that an `Infinity` consumer deadline is normalized to serializable persistent state. DOM source ownership scans 212 framework files with zero violations. Catalog generation remains deterministic at 61 primitives. Stable package tarballs pass path hygiene.

## Framework boundary proof

Phase 10 does not pre-empt the compound-component work assigned to Phases 11–13. It does keep the existing thin adapter boundary compatible with the canonical behavior layer:

- Adapter-kit conformance now uses Progress's canonical six-part anatomy.
- React recognizes SVG parts in conformance and maps `stroke-dashoffset` to `strokeDashoffset`, with an explicit no-warning test.
- React, Svelte, and Solid package typechecks pass.
- Targeted shared conformance/event suites pass: React 6/6, Svelte 5/5, Solid 8/8.

Actual Phase 10 compound exports, native element choices, hydration/SSR behavior, and full framework parity remain required deliverables in their assigned phases; no compatibility shim or duplicate behavior engine was added here.

## Verification summary

### Authoritative gate

`npm run verify:uifn-phase-10` — **PASS**, 26/26 top-level checks.

1. `npm --workspace @uifn/core run typecheck` — PASS.
2. `npm --workspace @uifn/core run test` — PASS, 30 files / 156 tests.
3. `npm --workspace @uifn/core run build` — PASS.
4. `npm --workspace @uifn/dom run typecheck` — PASS.
5. `npm --workspace @uifn/dom run test` — PASS, 1/1.
6. `npm --workspace @uifn/dom run build` — PASS.
7. `npm --workspace @uifn/adapter-kit run typecheck` — PASS.
8. `npm --workspace @uifn/adapter-kit run test` — PASS, 4 files / 16 tests.
9. `npm --workspace @uifn/adapter-kit run build` — PASS.
10. `node --test scripts/verify-uifn-phase-10-contract.test.mjs` — PASS, 4/4.
11. `node scripts/verify-uifn-phase-10-contract.mjs --require-dist` — PASS, 14 Phase 10 primitives, 61 catalog primitives, zero issues.
12. `node scripts/generate-uifn-phase-10.mjs --check` — PASS, five outputs.
13. `npm --workspace @uifn/dom run test:browser` — PASS, 41/41 across five projects.
14. `node scripts/verify-uifn-dom-platform.mjs --require-dist` — PASS, 212 files, zero violations.
15. `node scripts/verify-uifn-controller-contract.mjs --require-dist` — PASS, zero issues.
16. `node scripts/verify-uifn-runtime-architecture.mjs --require-dist` — PASS, zero issues and zero production trace payloads.
17. `node scripts/verify-uifn-core-node-matrix.mjs` — PASS, Node 20/22/24.
18. `npm --workspace @uifn/react run typecheck` — PASS.
19. `npm --workspace @uifn/svelte run typecheck` — PASS.
20. `npm --workspace @uifn/solid run typecheck` — PASS.
21. React targeted core/event tests — PASS, 6/6.
22. Svelte targeted core/event tests — PASS, 5/5.
23. Solid targeted core/event tests — PASS, 8/8.
24. `node scripts/generate-uifn-catalog.mjs --check` — PASS, 61 primitives.
25. `node scripts/verify-uifn-pack.mjs` — PASS.
26. `node scripts/verify-uifn-stable.mjs` — PASS, including governance, consumers, package hygiene, Node matrix, architecture, and a second 41-test browser run.

Additional audit results:

- Phase 10 focused core suite — PASS, 13 tests.
- React SVG/conformance focus — PASS, 6 tests and no React DOM warning.
- `rg` debt scan across Phase 10 implementation/verifier files — no `TODO`, `FIXME`, `HACK`, or `XXX` markers.
- `git diff --check` — PASS before report creation and required again after the artifact/log write.

No failing check was suppressed, marked flaky, skipped, or converted into a dry-run assertion.

## Deliverables summary

### Added

- Pure gesture, structured date/time, and color algorithms.
- Shared Phase 10 controller/part/ID helpers.
- Range/gesture, date/color/time, and status/feedback controller modules.
- Canonical wrappers and public exports for all fourteen Phase 10 primitives.
- TreeView workflow status support.
- DOM pointer/gesture binding and Phase 10 browser harness/spec.
- Phase 10 core property/model/fake-clock/lifecycle tests.
- Five generated contract/golden/type outputs.
- Phase 10 generator, contract verifier, mutation tests, aggregate gate, and durable evidence.

### Replaced or modified

- Slider, Progress, and Toast old implementations with canonical contracts/controllers.
- Core algorithm/primitive indexes and error taxonomy.
- Pointer terminal handling for non-bubbling lost capture.
- Adapter-kit Progress anatomy.
- React SVG attribute projection and conformance element normalization.
- Runtime architecture verifier ownership for grouped feedback controllers.
- Node import matrix to exercise canonical persistent Toast state.
- Root package scripts and release-gate governance.

### Removed

- Remaining public-ish `create*Model` factories in Accordion, Collapsible, ScrollArea, Switch, and Toolbar were renamed to internal runtime terminology.
- The retired core state-machine path remains deleted.

These are deliberate pre-1.0 clean breaks. No legacy behavior shim was introduced.

## Notes and limitations

- Playwright mobile projects are device emulation, not physical-device or screen-reader certification.
- Synthetic pointer cancellation/lost-capture fixtures supplement, but do not replace, actual mouse and mobile touch evidence.
- Consumer-provided localized control text remains necessary where a platform-neutral package cannot invent a language-correct sentence.
- React/Svelte/Solid public compound completion and parity remain in Phases 11–14.
- Axe, VoiceOver, NVDA, TalkBack, forced-colors, zoom/reflow certification, independent audit, and immutable release-candidate evidence remain in their assigned later phases. JAWS is intentionally outside the current agreed matrix.
- No commit, push, publication, or external state change was performed.
- The phase is not final; `.conduct/tracker.csv` was intentionally not advanced. The final spec phase remains Phase 20.

## Ready for next phase?

**Yes.** Phase 11 can build the complete React compound surface against a frozen 61-primitive core behavior catalog, exact Phase 10 anatomy, and the recorded state/parts/callback/DOM golden corpus.

## Blockers

None for Phase 11. The overall 10/10 program remains incomplete until framework compounds, parity, documentation, automated/manual accessibility certification, independent review, and immutable release-candidate gates pass.
