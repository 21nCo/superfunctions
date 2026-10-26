# Carbon adapter acceptance

Date: 2026-10-15. Worktree: `chartfn-readiness`. Carbon runtime: `@carbon/charts`
1.27.21. Browser: headless Chrome 154.0.8037.58. These are local acceptance results;
no deployment or publication occurred.

## Implemented corrections

- Direct imperative Carbon constructors replace the asynchronous nested React
  root. Mount failures are synchronous; successful updates replace the chart,
  while failed validation/construction leaves the previous chart intact. Disposal
  destroys the vendor instance and removes only its owned holder, idempotently.
- Multi-series bars use GroupedBarChart. Combo uses ComboChart with explicit
  per-series mappings: first series bar and subsequent series line by default;
  declared bar/line/area types override defaults. Repeated dataset names receive
  distinct names rather than silently sharing a Carbon group.
- Linear and scatter X coordinates are numeric point indices, matching ChartSpec
  across adapters. Category labels remain labels, not coerced coordinates.
- Pie/donut group by slice labels, with series-name prefixes for multiple series,
  preventing each complete series from collapsing into a single slice.
- Light/dark map to Carbon white/g100. Passthrough Carbon options retain precedence.
- Optional SVG/PNG exports serialize the actual `svg.layout-svg-wrapper`, not a
  toolbar icon. Computed SVG styles are embedded, dimensions validated, and PNG
  rasterization returns the requested dimensions. Separate HTML title/legend/
  toolbar content is outside this explicitly documented plot export.

## Verification

`npm test -- --run __tests__/carbon-adapter.test.tsx` from `chartfn/`: **8 passed**.
Tests cover combo mapping, numeric axes, pie slices, theme/passthrough, grouped
bars, type replacement/idempotent disposal, failed-update preservation and invalid
export dimensions. `npm run typecheck` passes. Integrated core suite passed
**51 tests** at the validation snapshot before final browser selector tightening;
focused tests and typecheck were repeated afterward and passed.

The persistent `chartfn/scripts/browser-acceptance.mjs` now tests Carbon alongside
Chart.js and ECharts without removing the prior adapter coverage. Latest result:

```json
{"browser":"154.0.8037.58","checks":149,"pageErrors":[]}
```

All seven Carbon chart types are mounted using the real vendor library and CSS.
Assertions check actual graph marks: six grouped bars, three bars plus a line
for combo, six slices for multi-series pie/donut, and six finite-coordinate scatter
dots. All types export parseable SVG and nonblank PNG at 320x200, then replace type
and theme, and dispose without leftover owned DOM. Assertions inspect the graph
SVG, excluding toolbar icons. An early generic SVG check was strengthened after
it exposed that toolbar icons could otherwise give false-positive export proof.

Reproduce on this machine from the worktree root:

```bash
PLAYWRIGHT_MODULE_PATH=/Volumes/Dev/n/superfunctions/node_modules/playwright \
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node chartfn/scripts/browser-acceptance.mjs
```

The script hosts a temporary loopback page, bundles current source, loads Carbon
CSS, uses a clean headless browser context, and closes browser/server on exit.
Chrome acceptance does not establish Safari/Firefox behavior, every arbitrary
passthrough override, or full HTML-container screenshot fidelity.
