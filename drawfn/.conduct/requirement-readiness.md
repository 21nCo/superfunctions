# DrawFn requirement evidence

This inventory covers all 16 requirements and all 13 intent items in `specs/2026-03-27-audit-fix-ph067aw9-spec/`. The baseline is `7f66e306b`; the changes described below extend that implementation. Local functional evidence does not establish hosted CI, publication, deployment, or unconditional production readiness.

## Requirement mapping

Paths in the evidence column are relative to `drawfn/`. Vector names refer to `TEST_VECTORS.md` in the original specification directory.

| Requirement | Implementation and executable evidence | Qualification |
| --- | --- | --- |
| BOUNDARY-001 | `core/src/types.ts`, existing node tool and preview/click plumbing; `core/__tests__/readiness.test.ts` and browser node smoke; TV-BOUNDARY-001/002 | This change does not modify node-specific types/options/serialization. No Nucleus migration or external application integration is established. |
| SURFACE-001 | Core/React/Svelte manifests, canonical imports and package READMEs; TV-SURFACE-001/002 | Names remain `drawfn`, `@drawfn/react`, `@drawfn/svelte`, MIT. |
| SURFACE-002 | Package build/lint/test scripts and conditional exports; `scripts/packed-consumer.mjs`, `scripts/framework-browser-acceptance.mjs`; TV-SURFACE-003/004 | Packed matrix evidence is the baseline receipt in `pr-destination.md`, not a new packed run. Svelte root is ESM only and component subpaths ship Svelte source. |
| SCENE-001 | `normalizeSceneData`, `normalizeElement`, `applyLoadedScene` in `core/src/drawfn.ts`; `scene-load.test.ts`; TV-SCENE-001/002 | Unknown fields are dropped, metadata cloned, malformed scene keeps prior state. Non-positive grid sizes now fail before entering rendering loops. Missing IDs are generated; repeated normalization of missing-ID input does not promise byte-identical IDs. |
| SCENE-002 | Freedraw normalization, renderer and SVG local coordinates; `freedraw-normalization.test.ts`, browser pen smoke; TV-SCENE-003/004 | Legacy repair is restricted to the documented first-point corruption pattern. |
| HISTORY-001 | Gesture snapshots and completion in core; `interaction-history.test.ts`, cancellation in `readiness.test.ts`, browser drag/resize/rotation/undo; TV-HISTORY-001/002 | Gesture granularity is covered. Broader SPEC wording calls `clear` a committed mutation, but current `clear()` resets history; undoable clear remains a semantic gap. |
| EVENTS-001 | Core event methods; `selection-events.test.ts`, `camera-input.test.ts`, `text-editing.test.ts`; TV-EVENTS-001/002 | Text commits emit `sceneChanged` with add/update reasons. The declared `text-commit` reason is not emitted. |
| INPUT-001 | `tools/select-tool.ts`, geometry and pointer capture/window completion/cancellation; `selection-events.test.ts`, `renderer-rotation.test.ts`, browser interactions; TV-INPUT-001/002 | Single-pointer desktop evidence; not exhaustive touch/multi-pointer evidence. |
| INPUT-002 | Canvas-scoped keyboard handling, space restoration and cursor-anchored wheel zoom; `camera-input.test.ts`, `readiness.test.ts`, browser CSS-scaled interactions; TV-INPUT-003/004 | Text-entry/outside-canvas shortcuts are excluded; no cross-browser/mobile matrix is claimed. |
| TEXT-001 | `tools/text-tool.ts` create/edit/cleanup pipeline; `text-editing.test.ts`, browser focus/blur and CSS-scaled overlay; TV-TEXT-001/002 | Empty provisional text and destroy cleanup are covered; event reason qualification above still applies. |
| RENDER-001 | `renderer.ts` oriented bounds, locked rendering and zoom-normalized handles; `renderer-rotation.test.ts`, browser visual interactions; TV-RENDER-001/002 | No benchmark establishes the original 2,000-element interactivity target. |
| EXPORT-001 | Core PNG/SVG bounds, selection and error handling; `export-image.test.ts`, `image-capacity.test.ts`, actual browser decoded PNG pixels and native tainted-canvas failure; TV-EXPORT-001/002 | PNG uses the host loader. SVG still writes an image href rather than embedding host-loaded pixels; broad SVG loader parity/portable authenticated images remains open. |
| REACT-001 | `drawfn-react/src/use-drawfn.ts`, component and hook tests; TV-REACT-001/002 | Deep-equal echoes and constructor-option replacement covered; baseline packed React 18/19 evidence retained. |
| SVELTE-001 | Action/component/store sources and six tests; TV-SVELTE-001/002 | Supported peer is Svelte 5.57.2+, not original Svelte 4/5 target. Existing README records the intentional security-related restriction; this requirement is qualified, not silently satisfied for Svelte 4. |
| OBS-001 | Core result/error event/export rejection paths; scene/export tests and source has no console-dependent recoverable behavior; TV-OBS-001/002 | Native PNG encoder throws and null results now emit one structured `EXPORT_RENDER_FAILED` event and reject. Image-capacity rejections are deduplicated while a source remains blocked. |
| QA-001 | Root workspace tests/build/typechecks and repeatable browser/packed scripts; TV-QA-001/002 | Local gates pass as recorded below. Hosted PR51 JS run39142198276 is not green evidence; hosted workflow/billing completion remains a separate gate. |

## Intent mapping

| Original intent | Coverage |
| --- | --- |
| 1: detailed specification in `.conduct` | Existing SPEC/REQUIREMENTS/TEST_VECTORS and this explicit completion inventory. |
| 2: address original audit issues | Requirement rows map the original scene, gesture, rendering, wrapper and packaging defects; remaining qualifications are stated. |
| 3: DrawFn-only scope | Core, adapters, package tests/scripts and function documentation; no shared package modifications. |
| 4: production single-user flows | Local browser interactions and lifecycle coverage; performance, hosted CI and qualified semantics remain gates. |
| 5: packaging/docs consistency | SURFACE-001/002. |
| 6: scene/serialization/freedraw | SCENE-001/002. |
| 7: history/events | HISTORY-001 and EVENTS-001, with clear/text-reason qualifications. |
| 8: selection/input | INPUT-001/002 and EVENTS-001. |
| 9: text editing | TEXT-001. |
| 10: rendering/image/export | RENDER-001 and EXPORT-001; authenticated SVG qualification retained. |
| 11: controlled/uncontrolled wrappers | REACT-001 and SVELTE-001; original Svelte 4 target remains excluded. |
| 12: release verification | QA-001 and both SURFACE requirements; hosted status separate. |
| 13: no Nucleus migration | BOUNDARY-001. |

## Added bounds and lifecycle behavior

- PNG and SVG reject non-finite, zero/subpixel, or over-8192 output dimensions before creating an export canvas/string. Padding and scale are included. Exactly 8192 is accepted. PNG browser encoding failures use the structured error path.
- Direct additions and provisional text admission cannot grow a scene beyond 2,000 elements; rejected additions do not create history or content events. Scene loading already enforced this cap.
- Renderer capacity counts unique cached and pending image sources together, with a maximum of 64. Repeated URLs share a request. Capacity errors are emitted once per blocked source, not each render. Existing admitted images remain available; this is deterministic admission, not LRU eviction.
- A rendered scene releases cached sources absent from that scene. Removed pending requests retain their reservation until settlement because the host loader has no cancellation API. Their late bitmaps are closed; when capacity becomes available, a still-blocked source is scheduled again. Destroy closes loaded and late assets and suppresses completion callbacks.
- Preloading more than 64 distinct sources rejects with `SCENE_LIMIT_EXCEEDED` before invoking loaders. A scene may contain more than 64 image elements if they share sources; source admission can depend on which images enter the viewport. Cache entries are bounded, not the byte size of individual images. This does not promise host-network cancellation.
- `history.ts` caps past snapshots at 50; freedraw normalization caps stored points at 16,384. No new benchmark establishes interactive performance at either maximum. The pen tool's transient point buffer is not separately capped; sustained input after the persisted-point limit remains a performance/lifecycle qualification.

## Validation

Commands run from repository root:

```sh
npm test --workspace=drawfn
npm run typecheck --workspace=drawfn
npm run build --workspace=drawfn
PLAYWRIGHT_MODULE_PATH=/path/to/playwright BROWSER_EXECUTABLE_PATH=/path/to/chrome node drawfn/scripts/browser-acceptance.mjs
```

The npm workspace selector includes core and its two adapters. 70 core, 5 React and 6 Svelte tests passed; all three typechecks and builds passed. Chrome 154.0.8037.58 passed 49 browser assertions with zero page errors, including native cross-origin bitmap taint reaching the PNG encoding failure path. Receipts: `/tmp/drawfn-limits-tests.log`, `/tmp/drawfn-limits-typecheck.log`, `/tmp/drawfn-browser-limits.json`. Historical clean install, packed consumer/runtime declarations, React18/19/Svelte5 and production audit evidence remain in `pr-destination.md`; those are not represented as rerun by this change. No Python DrawFn implementation is present or required by this browser-only specification.
