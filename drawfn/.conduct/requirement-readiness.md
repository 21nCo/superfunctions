# DrawFn requirement evidence

This inventory covers all 16 requirements and all 13 intent items in `specs/2026-03-27-audit-fix-ph067aw9-spec/`. The baseline is `7f66e306b`; the changes described below extend that implementation. Local functional evidence does not establish hosted CI, publication, deployment, or unconditional production readiness.

## Requirement mapping

Paths in the evidence column are relative to `drawfn/`. Vector names refer to `TEST_VECTORS.md` in the original specification directory.

| Requirement | Implementation and executable evidence | Qualification |
| --- | --- | --- |
| BOUNDARY-001 | `core/src/types.ts`, existing node tool and preview/click plumbing; `core/__tests__/readiness.test.ts` and browser node smoke; TV-BOUNDARY-001/002 | This change does not modify node-specific types/options/serialization. No Nucleus migration or external application integration is established. |
| SURFACE-001 | Core/React/Svelte manifests, canonical imports and package READMEs; TV-SURFACE-001/002 | Names remain `drawfn`, `@drawfn/react`, `@drawfn/svelte`, MIT. |
| SURFACE-002 | Package build/lint/test scripts and conditional exports; `scripts/packed-consumer.mjs`, `scripts/framework-browser-acceptance.mjs`; TV-SURFACE-003/004 | A fresh packed matrix was rerun after the API/export changes; see the final receipt below. Svelte root is ESM only and component subpaths ship Svelte source. |
| SCENE-001 | `normalizeSceneData`, `normalizeElement`, `applyLoadedScene` in `core/src/drawfn.ts`; `scene-load.test.ts`; TV-SCENE-001/002 | Unknown fields are dropped, metadata cloned, malformed scene keeps prior state. Non-positive grid sizes now fail before entering rendering loops. Missing IDs are generated; repeated normalization of missing-ID input does not promise byte-identical IDs. |
| SCENE-002 | Freedraw normalization, renderer and SVG local coordinates; `freedraw-normalization.test.ts`, browser pen smoke; TV-SCENE-003/004 | Legacy repair is restricted to the documented first-point corruption pattern. |
| HISTORY-001 | Gesture snapshots and completion in core; `interaction-history.test.ts`, cancellation in `readiness.test.ts`, browser drag/resize/rotation/undo; TV-HISTORY-001/002 | Gesture granularity and undoable clear are covered by `clear-history.test.ts`; explicit `resetHistory()` preserves the ability to discard history without changing content. |
| EVENTS-001 | Core event methods; `selection-events.test.ts`, `camera-input.test.ts`, `text-editing.test.ts`; TV-EVENTS-001/002 | Text creation/editing now emit `text-commit`, with ordered element/history/scene events and one undo snapshot. |
| INPUT-001 | `tools/select-tool.ts`, geometry and pointer capture/window completion/cancellation; `selection-events.test.ts`, `renderer-rotation.test.ts`, browser interactions; TV-INPUT-001/002 | Single-pointer desktop evidence; not exhaustive touch/multi-pointer evidence. |
| INPUT-002 | Canvas-scoped keyboard handling, space restoration and cursor-anchored wheel zoom; `camera-input.test.ts`, `readiness.test.ts`, browser CSS-scaled interactions; TV-INPUT-003/004 | Text-entry/outside-canvas shortcuts are excluded; no cross-browser/mobile matrix is claimed. |
| TEXT-001 | `tools/text-tool.ts` create/edit/cleanup pipeline; `text-editing.test.ts`, browser focus/blur and CSS-scaled overlay; TV-TEXT-001/002 | Empty provisional text, clear/destroy cleanup, and text-commit metadata are covered. |
| RENDER-001 | `renderer.ts` oriented bounds, locked rendering and zoom-normalized handles; `renderer-rotation.test.ts`, browser visual interactions; TV-RENDER-001/002 | `scripts/performance-acceptance.mjs` measures one concrete 2,000-element browser workload; see timings and limitations below. |
| EXPORT-001 | Core PNG/SVG bounds, selection and error handling; `export-image.test.ts`, `image-capacity.test.ts`, actual browser decoded PNG pixels and native tainted-canvas failure; TV-EXPORT-001/002 | PNG and SVG both use the host loader. SVG embeds owned loaded pixels as PNG data URLs; see source/pixel limits and native browser evidence below. |
| REACT-001 | `drawfn-react/src/use-drawfn.ts`, component and hook tests; TV-REACT-001/002 | Deep-equal echoes and constructor-option replacement covered; fresh packed React 18/19 consumers pass. |
| SVELTE-001 | Action/component/store sources and six tests; TV-SVELTE-001/002 | Supported peer is Svelte 5.57.2+, not original Svelte 4/5 target. Existing README records the intentional security-related restriction; this requirement is qualified, not silently satisfied for Svelte 4. |
| OBS-001 | Core result/error event/export rejection paths; scene/export tests and source has no console-dependent recoverable behavior; TV-OBS-001/002 | Native PNG encoder throws and null results now emit one structured `EXPORT_RENDER_FAILED` event and reject. Image-capacity rejections are deduplicated while a source remains blocked. |
| QA-001 | Root workspace tests/build/typechecks and repeatable browser/packed scripts; TV-QA-001/002 | Local gates pass as recorded below. Hosted PR51 JS run39142198276 is not green evidence; hosted workflow/billing completion remains a separate gate. |

## Intent mapping

| Original intent | Coverage |
| --- | --- |
| 1: detailed specification in `.conduct` | Existing SPEC/REQUIREMENTS/TEST_VECTORS and this explicit completion inventory. |
| 2: address original audit issues | Requirement rows map the original scene, gesture, rendering, wrapper and packaging defects; remaining qualifications are stated. |
| 3: DrawFn-only scope | Core, adapters, package tests/scripts and function documentation; no shared package modifications. |
| 4: production single-user flows | Local browser interactions and lifecycle coverage; device/workload performance breadth, hosted CI and qualified semantics remain gates. |
| 5: packaging/docs consistency | SURFACE-001/002. |
| 6: scene/serialization/freedraw | SCENE-001/002. |
| 7: history/events | HISTORY-001 and EVENTS-001, including undoable clear and dedicated text-commit metadata. |
| 8: selection/input | INPUT-001/002 and EVENTS-001. |
| 9: text editing | TEXT-001. |
| 10: rendering/image/export | RENDER-001 and EXPORT-001, including portable custom-loader SVG image assets. |
| 11: controlled/uncontrolled wrappers | REACT-001 and SVELTE-001; original Svelte 4 target remains excluded. |
| 12: release verification | QA-001 and both SURFACE requirements; hosted status separate. |
| 13: no Nucleus migration | BOUNDARY-001. |

## Added bounds and lifecycle behavior

- PNG and SVG reject non-finite, zero/subpixel, or over-8192 output dimensions before creating an export canvas/string. Padding and scale are included. Exactly 8192 is accepted. PNG browser encoding failures use the structured error path.
- Direct additions and provisional text admission cannot grow a scene beyond 2,000 elements; rejected additions do not create history or content events. Scene loading already enforced this cap.
- Renderer capacity counts unique cached and pending image sources together, with a maximum of 64. Repeated URLs share a request. Capacity errors are emitted once per blocked source, not each render. Existing admitted images remain available; this is deterministic admission, not LRU eviction.
- A rendered scene releases cached sources absent from that scene. Removed pending requests retain their reservation until settlement because the host loader has no cancellation API. Their late bitmaps are closed; when capacity becomes available, a still-blocked source is scheduled again. Destroy closes loaded and late assets and suppresses completion callbacks.
- Preloading more than 64 distinct sources rejects with `SCENE_LIMIT_EXCEEDED` before invoking loaders. A scene may contain more than 64 image elements if they share sources; source admission can depend on which images enter the viewport. Cache entries are bounded, not the byte size of individual images. This does not promise host-network cancellation.
- `history.ts` caps past snapshots at 50; freedraw normalization caps stored points at 16,384. A 2,000-rectangle timing run is recorded below; maximum-length freedraw performance is not established. The pen tool's transient buffer is also capped at 16,384; overflow reports one structured error per gesture, retains the last admitted stroke and preserves commit/cancel behavior. Maximum-length stroke performance remains unmeasured.

## Validation

Commands run from repository root:

```sh
npm test --workspace=drawfn
npm run typecheck --workspace=drawfn
npm run build --workspace=drawfn
PLAYWRIGHT_MODULE_PATH=/path/to/playwright BROWSER_EXECUTABLE_PATH=/path/to/chrome node drawfn/scripts/browser-acceptance.mjs
```

The npm workspace selector includes core and its two adapters. 70 core, 5 React and 6 Svelte tests passed; all three typechecks and builds passed. Chrome 154.0.8037.58 passed 49 browser assertions with zero page errors, including native cross-origin bitmap taint reaching the PNG encoding failure path. Receipts: `/tmp/drawfn-limits-tests.log`, `/tmp/drawfn-limits-typecheck.log`, `/tmp/drawfn-browser-limits.json`. Historical clean install, packed consumer/runtime declarations, React18/19/Svelte5 and production audit evidence remain in `pr-destination.md`; those are not represented as rerun by this change. No Python DrawFn implementation is present or required by this browser-only specification.

## Clear and text commit completion

Clear now records one snapshot and emits element removal events before selection/history/scene events. An empty clear does not create phantom history or events. Clearing dismisses provisional text so a delayed blur cannot restore deleted content. React hook and Svelte component/store expose the additive `resetHistory()` method; it clears only history. Svelte store mutations no longer overwrite fresh nested event updates with stale pre-clear state. Core and adapter regression tests cover these behaviors; README migration guidance identifies the changed clear and text event contracts.

The clear/text changes pass 74 core, 6 React and 7 Svelte tests, all builds/typechecks, and 52 actual Chrome154 browser assertions with zero page errors. The browser gate includes text-commit metadata, undo after clear, and content preservation after resetHistory. Logs: `/tmp/drawfn-history-tests.log`, `/tmp/drawfn-history-types.log`, `/tmp/drawfn-history-build.log`, `/tmp/drawfn-history-browser.json`.

## 2,000-element browser workload

`performance-acceptance.mjs` builds the actual core source and renders 2,000 visible filled/stroked rectangles in Chrome 154.0.8037.58 on Darwin arm64 / Apple M4 Pro. It dispatches one select drag with 60 pointer moves and permits a rendering frame between moves. It asserts the final displacement, exactly one undo snapshot, at least 60 render callbacks and zero page errors. This is an actual Canvas 2D workload, not mocked rendering.

The recorded run (`/tmp/drawfn-performance.json`) measured initial load 4.4 ms; 62 input handlers median 1.4 ms, p95 1.7 ms, maximum 2.3 ms; 61 render callbacks median 0.9 ms, p95 1.1 ms, maximum 1.6 ms. These are JavaScript input-handler/render-callback durations, not compositor presentation latency or a universal frame-rate guarantee. Image-heavy scenes, maximum-length pen strokes, other devices and browsers are not covered. No hardware-independent timing threshold is asserted.

```sh
PLAYWRIGHT_MODULE_PATH=/path/to/playwright BROWSER_EXECUTABLE_PATH=/path/to/chrome node drawfn/scripts/performance-acceptance.mjs
```

## SVG image portability

SVG export now resolves exported image sources through the configured host loader (or the same anonymous default loader used by the renderer), embeds PNG data URLs, and never falls back to an external href. Duplicate sources share loading and encoding. The scene elements, camera and background are snapshotted before asynchronous loading. Temporary canvases are zeroed after encoding and the temporary renderer is disposed on success/failure, including late image completions.

Before allocating image-encoding canvases, native dimensions must be positive integers no larger than 8192 per side and the sum of native pixels across unique assets must not exceed 67,108,864. This is an additional SVG embedding budget, distinct from exported viewport dimensions and the 64-source cache/request bound. Host loaders still own the cost of obtaining their returned assets; the library cannot cancel their requests. Loader failure uses `EXPORT_IMAGE_LOAD_FAILED`; native taint, invalid encoding or dimension/pixel rejection uses `EXPORT_RENDER_FAILED`. Capacity failure uses `SCENE_LIMIT_EXCEEDED`.

`core/__tests__/svg-images.test.ts` covers repeated sources, custom loader, rejected loader, tainted/null encoding, oversized assets, aggregate pixel budget, 65-source admission, disposal and concurrent scene edits. Chrome154 passed 54 assertions, including decoding the exported SVG into pixels with a custom private source, plus native cross-origin bitmap rejection without an href fallback. Receipts: `/tmp/drawfn-svg-tests.log`, `/tmp/drawfn-svg-types.log`, `/tmp/drawfn-svg-build.log`, `/tmp/drawfn-svg-browser.json`.

Final SVG checks: 82 core, 6 React and 7 Svelte tests pass; all builds/typechecks pass; Chrome154 has zero page errors.

## SVG output and transient pen bounds

The final SVG output is limited to 64 MiB of UTF-8 XML, counting repeated embedded data URLs and non-ASCII text. Fragments are byte-counted before retention and final joining; image URI expansion is checked before constructing each repeated image fragment. A duplicate 33 MiB encoded asset regression fails on its second reference with `EXPORT_RENDER_FAILED` rather than assembling a giant document. Native pixel checks happen after host-loader completion: callers must bound their loader's fetch/decode memory themselves; the SVG budget bounds generated output, not host decoding.

The pen buffer stops accepting points at 16,384 and sends only the first rejected point through existing validation for a single `SCENE_LIMIT_EXCEEDED` event. Subsequent moves neither grow the buffer nor emit repeated errors. `pen-capacity.test.ts` seeds a valid full stroke, then exercises 50 overflow events, commit, cancellation and a subsequent new stroke through real core/tool state; it avoids replaying quadratic setup snapshots, and is not a performance benchmark.

## Fresh package completion checks

After the final runtime changes, 85 core, 6 React and 7 Svelte tests pass, all package builds/typechecks pass, and Chrome154 passes 54 core browser assertions with zero page errors. Fresh isolated tarball consumers passed React18.3.1, React19.3.1 and Svelte5.57.2 with 42 actual browser lifecycle assertions, including undoable clear and explicit history reset. Strict TypeScript5.9.3 Node16/NodeNext declarations include the new resetHistory API. Nine runtime/SSR cases passed across Node18.18.0, Node20.20.2 and Node22.23.3. The isolated production audit reports zero advisories for 29 production dependencies.

Commands (repository root, trusted npm CLI supplied explicitly):

```sh
NPM_CLI=/absolute/path/to/npm/bin/npm-cli.js node drawfn/scripts/packed-consumer.mjs
NPM_CLI=/absolute/path/to/npm/bin/npm-cli.js PLAYWRIGHT_MODULE_PATH=/path/to/playwright BROWSER_EXECUTABLE_PATH=/path/to/chrome node drawfn/scripts/framework-browser-acceptance.mjs
```

Both independent consumers used matching tarballs:

| Package | SHA-256 |
| --- | --- |
| drawfn0.0.2 | ec6db7b9e29b4a0bfa9f81abb86f1d4d7a5c721f32cf6b093a2ec571b2385b1c |
| @drawfn/react0.0.3 | 2dd5a1acd3a9a2c229d46459fef9a80391b4641ea50ad4d8042380fec7527473 |
| @drawfn/svelte0.0.3 | 055dbb1c2a17a573ccf1bce37d089660e9f2b60b81c63764ec854fbaf8c41b42 |

Receipts: `/tmp/drawfn-final-tests.log`, `/tmp/drawfn-final-types.log`, `/tmp/drawfn-final-build.log`, `/tmp/drawfn-final-browser.json`, `/tmp/drawfn-final-packed-consumer.log`, `/tmp/drawfn-final-packed-framework.log`. Tarballs/results/audit/hashes were retained under `/tmp/drawfn-final-receipt-1f420siw`; both disposable consumer installation directories were removed and absence checked. The last README clarification about SVG output/decode limits was written during this validation; runtime builds were stable throughout. Hosted checks remain a separate outstanding gate.
