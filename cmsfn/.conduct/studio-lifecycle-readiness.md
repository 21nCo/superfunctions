# Studio draft/published lifecycle — 2026-10-23

## Contract and prerequisite

Original CMS DOC-003 requires clear edited/viewed perspective, draft editing, and publish/unpublish. The original spec does not require a merged draft-over-published list; ContentFn explicitly defines separate perspectives. This checkpoint uses complete producer-side queries for each view, with opaque pagination, instead of joining capped client pages.

Required ContentFn prerequisite: `fdd2678a244c208a713e3df729f5907fcca960d1` (ordinary merge into the CMS task branch; sf-next PR #56). It adds typed draft CFQL, bound cursors, distinct `query.drafts` authorization, and atomic revision-checked `docs.fork`. Existing unbound query cursors require a first-page restart. Production policies must authorize editor draft actions explicitly.

## Behavior

- App defaults to Drafts; Published is a separate selector view. Changing dataset/view/list closes the editor. Lists reset pagination and ignore late responses from the previous scope.
- Published documents are read-only. Explicit Create/open draft sends the displayed source revision. Stale sources fail without creating a draft; refresh retrieves the latest source. Collisions never overwrite a winning draft and read it only through the separately authorized draft-get route.
- Draft edits and workflow metadata patches use the returned draft ID and revision. Generation/scope guards prevent an old document load or completed operation from replacing the current view.
- Publication state is loaded authoritatively; a denied/error read is not treated as unpublished. Draft controls expose Publish/Publish changes and Unpublish as appropriate. Published views expose only Unpublish. Successful operations refresh current revision/state; denied publish leaves published data unchanged.
- Read/network failures settle into existing error states instead of unhandled promise rejections. Workflow errors surface visibly; mutation controls prevent concurrent UI submissions. Failed publication transport requests explicitly ask the user to refresh to verify outcome.

## Validation

Node20.20.0, npm11.21.0, Turbo2.6.1.

- Normal `npm ci --workspace=@cmsfn/studio --workspace=@cmsfn/server --include-workspace-root=false` passed. This larger workspace/development graph reports 16 advisories (5 moderate, 8 high, 3 critical); it is distinct from the clean production consumer below.
- Real combined Turbo Studio+server dependency build: 31 successful tasks (27 cached in the final build receipt). Studio strict types passed.
- Full Studio suite: 60 tests across 14 files. New cases cover source-revision fork requests/collision read, denied winner read, denied publication-state read, late dataset document response, and late perspective list response. Existing workflows, editor CAS, Markdown, audit, preview, media, collaboration, and limits remain included.
- Fresh normal local-tarball install of complete Studio plus actual CMS/Content servers and dependency closure: zero production audit advisories. Normal consumer tooling install also audits clean. Strict installed NodeNext JSX/CommonJS type readers and ESM/CommonJS SSR exports pass without skipLibCheck.
- Native Chromium143.0.7499.4 mounts the complete exported App at `/studio`, with both actual server APIs mounted under one host origin and separate owned memory adapters. It verifies no-config boot, desk, complete draft discovery, published read-only view, real draft save CAS, concurrent conflict/refresh, stale-source fork denial, explicit fork, authorized collision winner preservation, workflow approval, publish, republish, role denial, unpublish retaining draft, and dataset switching. The run makes54 API requests; publication responses and resulting actual ContentFn state are asserted, with no browser page errors.

Reproduce after the combined build and matching producer build:

```sh
python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root /path/to/built/content-checkout
```

The helper installs full packages and runs `studio-browser-acceptance.mjs`, not a copied UI subset. Owned browsers, servers, adapters and temporary consumer directories are cleaned after validation; logs remain `/tmp/cms-lifecycle-*` and screenshot `/tmp/cms-studio-browser.png`.

## Remaining original acceptance work

This is not whole-Studio completion. Singleton navigation, integration of all audit/release/operational panes into the shell, and broader product acceptance remain open. Native Safari, live identity providers, deployments and production authentication/CORS configuration were not exercised. The host must configure server-side authorization; browser config carries no service credentials. ContentFn external PostgreSQL/MySQL service gates remain separately open; the producer prerequisite proves native SQLite CAS/rollback and this browser checkpoint proves owned HTTP with actual package APIs.
