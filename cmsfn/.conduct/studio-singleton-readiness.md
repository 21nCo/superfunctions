# Studio singleton navigation checkpoint

Singleton desk buttons now open the fixed document in the selected Drafts or Published perspective. Clicking a singleton selects its declared dataset only when that dataset is present in the host configuration. Invalid or unavailable navigation fails before a request. The editor requires the declared document type before exposing content or mutation controls. Existing ContentFn authorization governs reads, draft forks and saves; missing and denied reads remain errors and never implicitly create a document.

The published view remains read-only and uses the existing explicit Create or open draft flow. Both perspectives retain revision checks, workflow/publication controls and dataset isolation. Singleton navigation returns to the desk rather than an unrelated list. No producer contract or dependency changes were needed.

## Validation

- `npm run typecheck -w ./cmsfn/studio`: passed.
- `npm test -w ./cmsfn/studio`: 65 tests in 15 files passed, including full App navigation, same-ID cross-dataset saves, unconfigured dataset no-request behavior, missing/denied reads and type mismatch.
- `npx --yes turbo@2.6.1 run build --filter=@cmsfn/studio... --filter=@cmsfn/server...`: 31 successful tasks, 30 cached; Studio JavaScript and declarations rebuilt.
- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness`: passed using ContentFn prerequisite `fdd2678a244c208a713e3df729f5907fcca960d1` and normal npm 11 installs of real packed packages. The production install audited 174 packages with zero advisories; adding consumer tooling audited 185 packages with zero advisories. These counts describe the isolated consumer, not the monorepo dependency graph.
- Installed strict NodeNext JSX/CommonJS consumers and ESM/CommonJS server rendering passed. Chromium 143.0.7499.4 loaded the complete installed App and exercised 75 actual API requests against the installed ContentFn and CmsFn servers. Existing list, conflict, draft/published, fork, workflow, publication and role-denial checks remained enabled.
- Native singleton coverage proved published read-only navigation, explicit existing-draft opening, independent same-ID saves in production and staging, actual producer permission denial without body exposure, missing document without create/fork/patch, wrong-type refusal and unconfigured dataset without any HTTP request.

Local receipts: `/tmp/cms-singleton-types.log`, `/tmp/cms-singleton-tests.log`, `/tmp/cms-singleton-turbo-build.log`, `/tmp/cms-singleton-packed.log`, `/tmp/cms-singleton-production-audit-final.json`. The acceptance helper closes its browser and servers; its isolated install was removed after retaining the audit receipt.

## Remaining scope

Full audit/release/operational shell integration, native Safari and deployment acceptance remain open. Singleton navigation does not provision missing documents. Host authentication, configured dataset policy and server authorization remain deployment responsibilities. No deployment, release or provider send was performed.
