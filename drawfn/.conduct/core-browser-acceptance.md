# DrawFn core browser acceptance

Validated 2026-10-15 in Chrome 154.0.8037.58. The persistent `drawfn/scripts/browser-acceptance.mjs` bundles the actual core source and performs 47 assertions with no page errors:

- Rectangle, ellipse, arrow, and pen gestures create elements and support undo/redo. Canceled shape gestures roll back without an undo entry, and pen taps paint a visible dot.
- Pointer selection moves, resizes, and rotates a rectangle.
- Text editing receives focus on the opening gesture and commits typed text on blur.
- Image and node tools place their configured content; scene JSON round-trips. Async node previews populate missing data, node clicks invoke the hook, and node drags do not.
- Pan and wheel zoom change the camera. CSS-scaled canvas pointer coordinates and pan deltas map to the backing dimensions; wheel anchoring and the text overlay retain their client positions.
- Keyboard deletion affects only the focused canvas; input undo does not change either canvas.
- PNG bytes are decoded by Chrome and checked for dimensions and exact pixels, covering distant world coordinates, fit-content, transparency, viewport camera, and scale.
- SVG parses without injected elements and preserves escaped style strings and fitted background coordinates.
- The shipped vanilla example imports its built package and local dependency, then draws through its toolbar.

Run from the worktree root:

```sh
PLAYWRIGHT_MODULE_PATH=/path/to/node_modules/playwright \
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node drawfn/scripts/browser-acceptance.mjs
```

All 52 core unit tests and TypeScript checking pass. Focused unit tests also cover bitmap disposal before and after pending load completion, idempotent cleanup, export option validation, and camera validation, canvas dimension repaint without scene/history events, and observer cleanup. Browser tests use a local clean headless browser; they do not establish cross-browser or deployed application behavior.
