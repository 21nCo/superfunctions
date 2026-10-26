# Packed framework browser acceptance

Validated 2026-10-15 in Chrome 154.0.8037.58 using locally built and packed `drawfn@0.0.2`, `@drawfn/react@0.0.3`, and `@drawfn/svelte@0.0.3`.

The script `drawfn/scripts/framework-browser-acceptance.mjs` creates a separate npm consumer for each runtime and installs the actual local package tarballs. Its bundle resolves framework dependencies solely from that consumer. The installed Svelte compiler compiles the packaged component entrypoint.

| Framework | Exact runtime | Assertions | Browser errors |
| --- | --- | ---: | ---: |
| React / React DOM | 18.3.1 | 12 | 0 |
| React / React DOM | 19.3.1 | 12 | 0 |
| Svelte | 5.57.2 | 12 | 0 |

Each consumer performs a real pointer drawing gesture, observes scene-change callbacks, checks exact red pixels after a dimension-prop resize, replaces the constructor overlay root and verifies scene retention plus a new `onReady` instance, loads a controlled scene, invokes the node preview and click callbacks, decodes a fitted PNG export, and unmounts. Replaced and unmounted instances must all be disposed. React runs inside StrictMode.

The distributed `.svelte` source is preprocessed during the package build; consumers compile it without requiring a dependency preprocessor. The supported Svelte peer range now starts at 5.57.2, which contains the upstream security fixes missing from Svelte 4. Browser pixel checks also cover the core canvas-dimension observer, which repaints after backing dimensions clear the native canvas.

Run after building all three packages:

```sh
PLAYWRIGHT_MODULE_PATH=/path/to/node_modules/playwright \
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node drawfn/scripts/framework-browser-acceptance.mjs
```

The exact installed consumers and machine-readable results for this run are retained at `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/drawfn-framework-matrix-kawIt2/results.json`.

This is real local browser evidence for the tested framework versions and package entrypoints. It does not establish every bundler configuration, framework patch version, or browser engine.
