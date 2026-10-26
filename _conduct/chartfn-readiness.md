# ChartFn readiness progress

Snapshot 2026-10-15. Fresh origin/dev 5c0276d2e10d5d91472d9dde4347a651db048a62; source local next 523c66ae8cf981ff8331d56386cec1f81c704182, ChartFn identical to upstream next. GitHub account thyaravind checked all 24 open PR file lists; none cover ChartFn. Isolated branch codex/chartfn-readiness-20261015. Nothing published or deployed.

Ported core/React/Svelte and root workspace/lock. Test scripts now terminate; lint runs typechecking. Vitest 4.1.11 selected. Core/React exports distinguish ESM/CommonJS declarations; Svelte uses svelte-package declarations and separate SSR entry with external runtime. React/Svelte lifecycle repairs update in place and replace on API/adapter changes. Three React and two Svelte tests pass, including StrictMode. Both typechecks pass. Actual SSR render passes with matched React runtime; root workspace has unrelated React19 and binding test dependency React18, so packed consumer identity checks remain required.

Adapters are being repaired and tested in native Chrome. Historical inherited phase reports are not current evidence. Remaining: integrated adapter checks, Carbon rendering, packed consumers and declarations/SSR, dependency audit, complete explicit requirements mapping and public docs.


## Integrated checkpoint

- Current core51, React3 and Svelte2 tests pass; all source/typechecks/builds pass.
- Native Chrome154 vendor acceptance149 assertions/zero page errors after ECharts upgrade to6.1.0. Exact graph marks and decoded nonblank exports are checked.
- Isolated local tarball consumers pass ESM/CJS imports, actual React/Svelte SSR without browser mount and TypeScript5.9 Node16/NodeNext declaration consumption. Svelte declaration barrel uses a JS-shaped type-only specifier so Node resolution finds Chart.svelte.d.ts while browser runtime retains .svelte.
- Initial isolated runtime audit found GHSA-fgmj-fm8m-jvvx in ECharts<6.1.0. Upgraded to^6.1.0; final isolated npm audit --omit=dev reports zero advisories (127 production,5 development dependencies; /tmp/sf-chartfn-runtime-audit-final.json).
- CI discovery recognizes all3 packages with real lint/test/build scripts. Hosted CI has not run. Framework real-browser runtime matrix is in progress.
- API005 wording reconciled with explicit handle signatures, preserving render/validation envelopes and imperative handle throw/reject behavior.
