# Studio package and native browser checkpoint — 2026-10-23

## Change

The complete `@cmsfn/studio` package participates in the root npm/Turbo workspace. It builds against actual `cmsfn` and ContentFn 0.2.0 exports, with no sibling source aliases. The authorized Content prerequisite merges preserve sf-next PR #56. Studio no longer advertises a nonexistent `cmsFn` schema initializer or depends on the unused server runtime. Import/require exports select their corresponding declaration format.

React/react-dom are host-owned React 18 peers with development copies for package checks. A fresh packed consumer previously selected React 19 for its host adapters and nested React 18 for Studio, causing a null `useMemo` dispatcher before boot. The peer contract prevents that split. Linked workspace tests also deduplicate React through Vite; the installed browser acceptance uses no React aliases or copied UI modules.

Native acceptance found another concrete failure: the editor loaded `drafts.editable` but patched `editable` with its draft revision. Save and conflict reapply now target the returned document ID with the matching revision. Unit regression covers both paths; actual HTTP acceptance proves the draft changes and stale revisions leave concurrent changes intact.

The collaboration refetch test now installs its HTTP fixture, awaits initial/refetch results, and asserts request counts; previously it issued real DNS requests to `cf.test`, producing unhandled rejections after teardown.

## Validation

Node 20.20.0; npm 11.21.0; pinned Turbo 2.6.1 (matching root lock).

- Normal `npm ci --workspace=@cmsfn/studio --include-workspace-root=false` passed. The development/workspace graph reports 14 advisories (5 moderate, 6 high, 3 critical); this checkpoint does not claim that graph is vulnerability-free.
- `turbo run build --filter=@cmsfn/studio... --dry=json` selected the real dependency task graph. Actual build completed 27 build tasks, including MDFN/UIFn and Studio JS/declarations. Some selected Probe task records have no build command; they are not counted as successful builds.
- Studio strict `tsc --noEmit` and 54 tests across 13 files passed. No checks/tests were excluded to obtain this result.
- Fresh normally installed local tarballs include the full Studio, its complete runtime closure, and the real ContentFn server. Production-only npm audit: zero advisories. Adding normal esbuild/Playwright/TypeScript consumer tooling also audited clean.
- Chromium 143.0.7499.4 mounted the whole exported App at `/studio`: missing configuration, boot, desk navigation, actual ContentFn list, draft save with revision, concurrent conflict and refresh, and dataset switch. Twelve actual ContentFn HTTP requests; no page errors. Browser/server/database closed afterward.
- Strict installed-consumer NodeNext JSX and CommonJS type readers passed without `skipLibCheck`; ESM/CommonJS SSR imports both render the exported App.

Reproduce after building the dependency closure and matching Content producer:

```sh
python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root /path/to/built/content-checkout
```

The helper prints its disposable directory for inspection and cleanup. It requires a cached Playwright Chromium matching 1.57.0. It packs complete build outputs with lifecycle scripts disabled (builds are performed separately), installs with ordinary npm, audits production before tooling, then executes `studio-browser-acceptance.mjs`. No remote provider or user browser profile is involved.

Logs are retained under `/tmp/cms-studio-*`; screenshot `/tmp/cms-studio-browser.png`.

## Remaining original acceptance gaps

This is a packaging and bounded editor checkpoint, not full Studio readiness. The actual browser also reproduces: published-only documents cannot load a nonexistent draft, draft-only documents are absent from the published CFQL list, and App passes no publication state to expose Unpublish. Producer-side perspective semantics and coherent Studio lifecycle integration remain necessary. No client-side partial aggregation is claimed complete.

Singleton desk navigation and wiring all audit/release/operational panes into the complete shell remain separate original product acceptance work. Native Safari, deployments, live providers, and production authentication configuration were not validated here. Server-side authorization remains mandatory; browser configuration cannot supply service secrets.

The subsequent lifecycle checkpoint is documented in `studio-lifecycle-readiness.md`; it supersedes the three reproduced draft/publication gaps above.
