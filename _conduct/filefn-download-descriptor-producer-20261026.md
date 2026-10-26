# FileFn bounded download descriptor producer prerequisite

Origin/dev source commit: `22511b003854532a7cb665de4d39d8394df916d4`.
Isolated checkout: `/Volumes/Dev/n/worktrees/superfunctions/filefn-download-descriptor-dev-20261026`.
Branch: `codex/filefn-download-descriptor-dev-20261026`, based on freshly fetched origin/dev `9205cbd3ac4372c5964acae1c41622d3dee8a707`.

## Behavior

Adds public `downloadDescriptor(fileId, {versionId?, signal?, timeoutMs?, maxResponseBytes?})` returning `{url, headers?}`. Actual existing FileFn router binds explicit version to the service's getVersionChecked path. Relative proxy URLs and safe custom raw-segment IDs are preserved; the method does not fetch descriptor destinations or invent returned version fields. Existing string download APIs remain unchanged.

The new request uses the existing client transport and canonical envelope logic, with a bounded reader and one attempt/no redirect following. Default whole-operation deadline is10s; default response limit64KiB, configurable ceiling16MiB. Descriptor URL limit16,384characters; headers at most64 entries/16KiB name+value bytes, valid header syntax. Raw provider bodies, signed URLs, arbitrary authentication errors and caller abort reasons do not escape in thrown error text.

Cancellation captures the original signal and removes its listener even when options are mutated. Auth callbacks that synchronously abort and later reject remain observed; no later fetch starts. Invalid signal shapes are rejected before allocation, and failed listener registration clears the timer. Arbitrary host auth callbacks/custom fetch code cannot be forcibly stopped; this is explicitly documented. Existing raw-segment server routes do not percent-decode custom IDs, so the new method rejects identities the URL parser rewrites rather than silently changing the lookup.

## Actual acceptance

- Node20 source full client suite: **82 tests /11files**, including **15 new native descriptor tests**. Receipt `/tmp/filefn-descriptor-full-terminal.log`.
- Types and normal build passed: `/tmp/filefn-descriptor-types-terminal.log`, `/tmp/filefn-descriptor-build-terminal.log`.
- Native tests use real loopback HTTP/fetch, actual FileFn router/file route/auth code and a controlled file-service result fixture. They demonstrate explicit version routing, authenticated descriptor header preservation, legacy string compatibility, custom IDs, exact byte boundary, chunked excess-body cancellation, stalled headers/body deadline, external/pre-abort, no redirect following/no retry after socket drop, malformed metadata/header bounds, error privacy, auth late rejection, mutation cleanup and invalid-signal timer cleanup.
- This fixture does **not** instantiate the complete FileFn database/storage backend. Real FileFn SQLite/local-storage upload→download and durable Ci binding/recovery remain the next integration requirement.
- Fresh normal npm11 installed tarball consumer under Node22.22: ESM live HTTP descriptor/version/headers/legacy/timeout; CJS dynamic import; strict TypeScript5.6 declaration consumer; production audit0. Receipt `/tmp/filefn-descriptor-packed-terminal.log`.
- Early focused invocation had an incorrect config path and terminated before tests. Earlier successful78/81-test checks were superseded by final terminal validation after signal cleanup corrections. No test/gate was weakened.

Temporary packed consumer/server connections and borrowed node_modules symlink were removed. Source worktree clean after explicit six-file commit. No dependency/rootlock/version/.gitignore edits; no .conduct content in origin commit; evidence lives only in readiness tracker. No live providers, deployment or package release. Source and packed runtime checks do not close Ci FileFn integration, full FileFn service/native provider acceptance, or the original17-function readiness goal.

## Publication

Draft origin/dev PR: https://github.com/21nCo/superfunctions/pull/258
Published exact `22511b003854532a7cb665de4d39d8394df916d4` from `codex/filefn-download-descriptor-dev-20261026` with active `thyaravind`. Before publication, origin/dev still matched9205cbd and no branch/PR existed for the new head; the branch is exactly one scoped commit ahead. Live readback verified exact head, branch, dev base, draft status, title and complete authored body. Repository automation appended its footer; preserved unchanged. Source worktree remains clean and no owned processes remain. This tracker receipt is not part of the origin PR.
