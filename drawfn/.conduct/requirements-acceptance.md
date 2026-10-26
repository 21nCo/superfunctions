# DrawFn requirements acceptance

Assessed against the existing March 27 REQUIREMENTS.md bundle and current public core/React/Svelte READMEs, rather than treating the historical January audit as current behavior. Current task authorization explicitly included implementing the existing node callbacks; this supersedes the older bundle's restriction against node integration changes. Serialized node fields and node tool options remain compatible.

| Existing requirement | Evidence and disposition |
| --- | --- |
| SURFACE-001/002 | Canonical names, MIT files, root workspace registration, shipped exports, package build/test/typecheck scripts; actual packed Node16/NodeNext type consumers and framework browser compilation. Svelte is explicitly ESM-only with patched Svelte >=5.57.2 peer baseline; core/React retain CJS. |
| SCENE-001/002 | Normalization and load tests cover version/shape/limits, unchanged state on invalid loads, legacy freedraw repair and canonical coordinates. Non-serializable element metadata now returns INVALID_SCENE. Pen creation starts with local coordinates including tap strokes. |
| HISTORY-001 | Gesture tests and real canvas drawing cover one-step commits. Pointer cancellation restores the snapshot without adding history. Content undo/redo retains the non-undoable camera. |
| EVENTS-001 | Selection/events tests cover content, selection, history, camera, clear/load/reorder/undo/redo. Binding tests use sceneChanged, with controlled echo suppression. |
| INPUT-001/002 | Selection geometry, outside-canvas pointer completion, cancellation, wheel anchoring, focus-scoped shortcuts, text-target exclusions, and locked deletion tests. Chrome covers move/resize/rotate, pan/zoom and CSS-scaled coordinates. |
| TEXT-001 | New/existing text share the commit pipeline; blur/destruction cleanup tested. Actual browser opening-click focus and typed commit pass, including CSS scaling. |
| RENDER-001 | Rotation/locked-render unit tests and browser transforms. Async images repaint only live renderers; dimensions repaint without scene/history events and observers disconnect on destroy. |
| EXPORT-001 | Host loader, image rejection and empty selection tests; decoded Chrome PNG dimensions/pixels cover camera/scale/fit/transparency. SVG attributes/text escape correctly. Pressure/taper affect exports; canvas uses the same stroke options. |
| REACT-001 | Controlled/uncontrolled and scene callback unit tests; isolated packed React18/19 consumers cover instance replacement, retention, resize and cleanup. |
| SVELTE-001 | Action/components/store build and tests plus packed Svelte5 browser/SSR/declaration consumers. Store attachment reads existing undo/redo state and detaches prior subscriptions. |
| OBS-001 | Recoverable errors use result/event/promise channels, including non-serializable metadata and failed node preview callbacks. Constructor missing-context failures remain exceptions. |
| QA-001 | Repeatable package-local checks, root-workspace checks and persistent core/framework/packed acceptance scripts. |

No remaining concrete mismatch was identified within these enumerated acceptance clauses after the fixes and checks. This is bounded evidence, not a claim that all possible interactions or legacy framework combinations were exercised. Touch gestures beyond pointer parity, multi-canvas asset sharing, richer text styling, and framework application-specific bundler configurations remain outside the original bundle. SVG image URLs remain external references; custom bitmap loaders transfer fresh bitmap ownership to the renderer. The secure Svelte baseline intentionally excludes Svelte 4, which remains affected by upstream runtime advisories.
