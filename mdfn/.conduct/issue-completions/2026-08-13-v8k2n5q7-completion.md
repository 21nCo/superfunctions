# Issue Completion: SFN-20 MDFN Full Audit Remediation

## Metadata

- Timestamp: 2026-08-12T19:07:27Z
- Local date: 2026-08-13
- Agent: Codex
- Model: GPT-5 Codex
- Launcher: Codex Desktop
- Workspace: isolated `mdfn-SFN-20` worktree
- Branch: `codex/mdfn-SFN-20`
- Baseline implementation commit: `98f29edd5b4a6498e0d0fc4ea29ccd6faab599f9`
- Base ref: `sf-next/next` at `8dddd865ee9b86571c70db87efd918152cf682fb`
- Issue: [SFN-20](https://linear.app/21n/issue/SFN-20/build-mdfn-as-the-superfunctions-markdown-authoring-platform)
- Audit: [SFN-20 MDFN Worktree Full Code Audit](https://linear.app/21n/document/sfn-20-mdfn-worktree-full-code-audit-2026-08-12-f970c018366c)
- Workflow: `21n/work-linear-issue@1.0.1`

## Status

PASS

The audit findings and the incomplete acceptance surfaces identified by the audit are remediated in the isolated worktree. The pre-remediation implementation was committed before fixes, as requested. This completion report supersedes the earlier SFN-20 completion report.

## Audit Finding Closure

### 1. Unknown and disabled syntax preservation

- Unknown and disabled directives and frontmatter remain opaque with their exact source bytes and diagnostics.
- No-edit serialization preserves the original document; directive parsing no longer absorbs unrelated blank-line-separated content.

### 2. Extension identity through the visual editor

- The DOM schema uses an atomic `extension_block` node containing the extension type, attributes, semantic content, raw source, and text.
- DOM projection and extraction preserve extension identity instead of reducing extension nodes to paragraphs.

### 3. Unsafe visual URLs

- Core, Markdown, DOM, renderer, paste, and asset paths use the shared URL inspection policy.
- Unsafe, obfuscated, protocol-relative, control-character, whitespace, and backslash variants are inert in visual output while their original source remains recoverable.

### 4. Extension rendering trust boundary

- Extension render hooks return a structured render tree, never an HTML string.
- Rendering enforces tag and attribute allowlists, escapes text/attributes, revalidates URL-bearing attributes, and rejects invalid render results.

### 5. Snapshot/source binding

- Snapshots use a deterministic SHA-256 source hash and include the document/schema binding.
- Snapshot restore reparses current Markdown and rejects forged, stale, schema-mismatched, or document-mismatched cached state.

### 6. One history and selection authority

- The ProseMirror-local history path was removed.
- The MDFN controller is the canonical source for history, selection, versioning, undo, and redo across visual/source/framework surfaces.

### 7. Collaboration metadata validation

- Existing remote metadata is validated and never overwritten.
- Each update is size checked and authorized, then applied to an isolated candidate Yjs document.
- Document ID, schema, content profile, protocol, extension set, Markdown, and the complete sidecar must validate before live application.

### 8. Transactional server fallback

- Durable mode requires an adapter with transaction support; memory/test hosts must request ephemeral mode explicitly.
- Version checks, idempotency receipt checks, document writes, immutable revisions, update compaction, and deletion cleanup execute atomically.

### 9. DocsFn canonical parsing

- DocsFn now projects blocks from the canonical MDFN parse instead of reparsing the same Markdown through a separate block parser.
- Canonical diagnostics and unsafe-link decisions are retained; component islands remain an explicit DocsFn concern.

### 10. CmsFn Markdown profile fidelity

- The Studio widget passes the exact dialect, raw HTML policy, schema version, and extension list.
- Known callout/diagram extensions are mapped explicitly; an unknown configured extension fails closed.

### 11. Real adapter parity

- The browser gate mounts vanilla, React, Svelte, and Solid adapters together, applies the same insert/undo/redo vector, compares traces, and verifies cleanup.
- Mounted unit tests cover each framework adapter and each complete component shell.

### 12. Directive boundaries

- Directive parsing terminates at the correct source boundary and does not consume following blank lines or unrelated blocks.
- Regression coverage verifies exact preservation.

### 13. Published extension subpaths

- CommonMark, GFM, callout, diagram, and directives are explicit build inputs and package exports for both ESM and CJS.
- Packed consumers import all five subpaths.

### 14. Runtime support matrix

- MDFN and the touched DocsFn, ContentFn, and CmsFn consumers consistently declare Node `>=20 <25`.
- Framework packages publish browser and Node SSR entry points without exposing browser-compiled modules to Node.

## Acceptance Surface Completion

### Authoring UI and framework neutrality

- Framework-neutral models cover primary/selection/floating toolbars, slash commands, mode switching, link/table/file controls, outline, diagnostics, comments, suggestions, review state, and audit history.
- React, Svelte, and Solid render the same authoring model with UIFn, while vanilla DOM shares the same controller and command semantics.
- Responsive, focus-visible, high-contrast, and reduced-motion styling is included.

### Editorial, collaboration, and recovery

- Core supports comment creation/reply/resolve, suggestion creation/accept/reject, review transitions, and immutable audit entries.
- The full sidecar is validated at local state, transaction, server, and collaboration trust boundaries.
- Collaboration includes offline queues, reconnect flushing, compaction, rejection audit events, presence, and teardown.
- Server/client APIs cover document/version CRUD, version restore, sidecar/audit, editorial workflows, and collaboration append/read/compact.

### FileFn and content migrations

- The FileFn bridge uses the real client contract, authorizes every operation, binds references to a document, excludes delivery URLs from durable references, validates resolved URLs, and emits structured render nodes.
- The memory asset provider is explicitly limited to tests/examples.
- ContentFn persists the full Markdown profile and supports lossless string/envelope upgrades plus diagnostic rich-content migrations. Unsupported migration values are retained as inert encoded comments, including circular/non-JSON input.

### Browser, packaging, SSR, fuzz, and performance

- Real browsers cover keyboard editing, shared paste sanitization, composition events, Unicode insertion, DataTransfer file drop, accessibility attributes, mounted adapter parity, and cleanup.
- React hydration/Strict Mode, Svelte mounted runtime, and Solid mounted runtime are executable tests.
- Framework tarball consumers complete production builds, SSR builds, SSR execution, ESM/CJS imports, and peer-isolation checks.
- All 652 official CommonMark 0.31.2 examples parse and byte-preserve.
- A deterministic 128-document malformed/Unicode fuzz corpus passes.
- A document above 200 KiB parses, exact-serializes, and securely renders under the five-second development budget.

## Verification Evidence

### Complete MDFN release gate

Command:

```sh
npm run verify:mdfn
```

Result:

- PASS: package graph, 24 packages total, 17 stable and 7 optional.
- PASS: 24/24 builds.
- PASS: 24/24 typechecks.
- PASS: 24/24 test commands; 65 focused MDFN tests.
- PASS: 24/24 package dry-runs.
- PASS: packed React, Svelte, and Solid production builds.
- PASS: packed React, Svelte, and Solid SSR builds and runtime execution.
- PASS: published ESM/CJS entry points and all five certified extension subpaths.
- PASS: Chromium, Firefox, WebKit, and mobile Chromium browser flows.

The Firefox and WebKit runs validate the shared clipboard sanitizer and insert the same safe plaintext because those engines do not accept the synthetic clipboard event used by the headless harness. Chromium and mobile Chromium execute the synthetic clipboard event itself. This distinction is reported by the gate rather than hidden.

### Ecosystem regression gates

Commands and results:

- `npm run build --workspace=docsfn/core`: PASS with pre-existing circular re-export warnings.
- `npm test --workspace=docsfn/core`: PASS, 148 tests.
- ContentFn core build/typecheck/test: PASS, 8 tests.
- ContentFn server build/typecheck/test: PASS, 112 tests.
- CmsFn core build/typecheck/test: PASS, 24 tests.
- CmsFn server build/test: PASS, 31 tests.
- CmsFn Studio build/typecheck/test: PASS, 50 tests; tests emit existing React `act` warnings.
- `node scripts/verify-mdfn-package-graph.mjs`: PASS.
- `git diff --check`: PASS.

## Verification Boundary

`npm run typecheck --prefix cmsfn/server` still reports pre-existing typing debt across its test fixtures and unrelated audit, operation, publishing, release, logging, and status-client modules. The MDFN integration in that package builds and its complete 31-test runtime suite passes. This standalone baseline is recorded as an unrelated repository condition and is not presented as a passing command.

No registry publication, remote CI, deployment, push, or pull request was requested or inferred from local evidence.

## Files and Systems Changed

- MDFN core, Markdown, render, extensions, DOM/source, adapters, complete framework chrome, testing, collaboration, client/server, FileFn, ContentFn, facade, and documentation packages.
- DocsFn canonical Markdown projection.
- ContentFn Markdown schema/storage integration and two existing typecheck defects encountered by the downstream gate.
- CmsFn core/server/studio MDFN widget integration and mounted coverage.
- Root workspace/lockfile plus package graph, packed-consumer, and real-browser verification scripts.

## Blockers

None for SFN-20 local completion.
