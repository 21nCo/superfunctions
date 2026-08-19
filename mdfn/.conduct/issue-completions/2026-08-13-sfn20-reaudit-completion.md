# Issue Completion: SFN-20 Re-audit Remediation

## Metadata

- Timestamp: 2026-08-13T10:07:46Z
- Local date: 2026-08-13
- Agent: Codex
- Model: GPT-5 Codex
- Launcher: Codex Desktop
- Workspace: isolated `mdfn-SFN-20` worktree
- Branch: `codex/mdfn-SFN-20`
- Baseline commit: `6ccdc260f47501ed6100505c5cf7bdc646b6df6a`
- Base ref: `sf-next/next` at `8dddd865ee9b86571c70db87efd918152cf682fb`
- Issue: [SFN-20](https://linear.app/21n/issue/SFN-20/build-mdfn-as-the-superfunctions-markdown-authoring-platform)
- Re-audit: [SFN-20 MDFN Worktree Re-audit](https://linear.app/21n/document/sfn-20-mdfn-worktree-re-audit-2026-08-13-b05adb48aa62)
- Workflow: `execute-issue`

## Status

PASS

All fourteen findings in the SFN-20 re-audit are remediated and covered by executable regression tests. This report supersedes the previous SFN-20 completion report.

## Finding Closure

1. Canonical document replacement now computes a minimal source edit and maps selection and sidecar anchors through the precise changed range.
2. The source editor delegates undo and redo exclusively to the MDFN controller; CodeMirror no longer maintains a competing history.
3. Visual projection preserves inline opaque syntax, references, definitions, and assets instead of flattening or dropping them.
4. Collaboration sessions send a dependency-complete initial Yjs state before incremental updates.
5. Offline queue compaction retains in-flight updates and removes only the exact update acknowledged by the transport.
6. Protected comment, suggestion, review, and audit state requires explicit collaboration authorization and cannot be changed by generic server updates.
7. Server list authorization is applied per document before pagination; Markdown writes and restores map current sidecar anchors instead of replacing editorial state with stale history.
8. ContentFn storage and the CmsFn widget persist and validate the versioned Markdown content envelope; legacy strings upgrade under the schema profile and historical profiles remain authoritative.
9. Extension commands, keymaps, input rules, paste rules, plugins, structured visual hooks, sanitizer hooks, cleanup, and certification manifests are executable through the stable adapters.
10. Compatibility certification compares rendered semantics for all 652 CommonMark 0.31.2 cases and an authoritative GFM corpus, in addition to exact no-edit preservation.
11. Durable asset syntax is first-class and carries provider, asset, document, and version identity; FileFn exposes a framework-neutral authoring upload handler.
12. Svelte and Solid snapshot every async mount input synchronously and react to controller, read-only, label, file handler, error handler, and editor-ref changes.
13. React, Svelte, and Solid authoring chrome now provides contextual slash, selection, and block controls plus comment reply/resolve, suggestion creation/decision, document version restore, and asset insertion workflows.
14. The package-graph verifier enforces the layer matrix, public/facade rules, declared and exported imports, exact internal versions, export sources/targets, framework peer placement, metadata, cycles, release inventory, and negative controls using parsed imports.

## Verification Evidence

### Complete MDFN gate

Command:

```sh
npm run verify:mdfn
```

Result:

- PASS: package graph for 24 packages, with 17 stable and 7 optional packages plus negative controls.
- PASS: all 24 package build, typecheck, test, and pack commands.
- PASS: clean packed React, Svelte, and Solid consumer production builds, SSR builds, SSR execution, ESM/CJS imports, and peer isolation.
- PASS: all three framework examples typecheck and build.
- PASS: 12 example-app browser workflows: React, Svelte, and Solid across Chromium, Firefox, WebKit, and mobile Chromium.
- PASS: browser keyboard, clipboard policy, composition, file drop, adapter parity, accessibility, and cleanup checks.
- PASS: 652/652 CommonMark semantic fixtures and all authoritative GFM fixtures.

Browser artifacts: `mdfn/examples/test-results/2026-08-13T10-13-07-483Z` (generated and ignored).

### Ecosystem regression gates

- ContentFn server typecheck: PASS.
- ContentFn server tests: PASS, 112/112.
- CmsFn Studio typecheck: PASS.
- CmsFn Studio tests: PASS, 51/51. The suite retains existing React test `act` warnings.
- `node scripts/verify-mdfn-package-graph.mjs`: PASS.
- `git diff --check`: PASS.

## Verification Boundary

No registry publication, remote CI, deployment, push, pull request, or Linear status mutation was requested or inferred from local evidence.

## Blockers

None for SFN-20 local completion.
