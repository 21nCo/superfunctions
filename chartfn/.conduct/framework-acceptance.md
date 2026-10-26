# Packed framework browser acceptance

Validated 2026-10-15 with Chrome 154.0.8037.58 and the built ChartFn 0.0.3 packages, including ECharts 6.1.0.

`chartfn/scripts/framework-browser-acceptance.mjs` packs the core and both bindings, installs each framework configuration into its own temporary npm consumer, and bundles imports resolved from those consumers. Svelte uses the installed consumer compiler on the packaged component. This avoids borrowing the workspace's React instance or source bindings.

| Consumer runtime | Mounts | Updates | Disposals | Browser errors |
| --- | ---: | ---: | ---: | ---: |
| React / React DOM 16.8.6 | 2 | 1 | 2 | 0 |
| React / React DOM 16.14.0 | 2 | 1 | 2 | 0 |
| React / React DOM 18.3.1 | 3 | 1 | 3 | 0 |
| React / React DOM 19.3.1 | 3 | 1 | 3 | 0 |
| Svelte 5.57.2 | 2 | 1 | 2 | 0 |

Each consumer mounts a real ECharts bar chart, updates it to a line chart with new values without remounting the binding, removes the API and verifies canvas cleanup, restores the API, and unmounts. All React consumers use StrictMode; React 18/19 also exercise its effect replay. Each successful run verifies the actual vendor chart options, canvas presence/removal, balanced mounts/disposals, and absence of page errors.

The first React 16.8.6 packed run exposed an automatic JSX runtime import unavailable before React 16.14. The Chart component now uses `React.createElement`, preserving the advertised React >=16.8 contract. Its rebuilt package passed the complete matrix, the three React unit tests, and TypeScript checking. No Svelte source change was needed.

Run after building the core and bindings:

```sh
PLAYWRIGHT_MODULE_PATH=/path/to/node_modules/playwright \
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node chartfn/scripts/framework-browser-acceptance.mjs
```

Both environment overrides are optional when Playwright and its browser are installed normally. The script prints and retains its isolated consumers and `results.json`; this run's evidence directory was `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/chartfn-framework-matrix-0EX3sF`.

This matrix exercises bindings with ECharts; the separate vendor browser script covers the seven chart types and all three adapters. It does not claim coverage of every React patch release or framework-specific application bundler.
