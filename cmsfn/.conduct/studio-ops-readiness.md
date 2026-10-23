# Studio import/export and authorization checkpoint

## Original requirement and chosen scope

OPS-001 is P0: authorized import/export with dataset isolation; its acceptance explicitly says cross-dataset import attempts are denied or fail deterministically. ContentFn separately supports environment promotion and explicitly documents importing an archive into another target dataset. CMS therefore now defaults to same-dataset restores. A trusted server `authorizeCrossDatasetImport(req, { sourceDataset, targetDataset })` callback may explicitly authorize a migration after target `audit.read` and configured-dataset checks. Missing, false or throwing policy denies it. Artifact source metadata is untrusted provenance; the separately authorized request dataset remains the write target. This preserves the default CMS requirement without removing ContentFn's intentional migration capability.

## Behavior

The existing routes allowed missing role configuration and used an unbounded parser. Real HTTP baseline tests reproduced anonymous export/import and implicit cross-dataset import. Both routes now fail closed on missing, denied or failed identity resolution. They reuse the shared bounded JSON parser: 64 KiB export request and 25 MiB import request. Structural archive checks precede forwarding; actual ContentFn remains authoritative for deep schema/document validation and atomic import. Explicit server-owned `contentfnOpsHeaders` resolves only after local authorization, without implicitly copying browser credentials. Callback failures are sanitized.

Upstream export responses are bounded to 25 MiB and import responses to 64 KiB, with a 30-second timeout and redirects rejected. An import timeout does not establish rollback. The UI reports uncertain import outcomes and does not automatically retry. Oversized archives fail instead of being truncated; larger archive streaming/job support is not established here.

The complete App now exposes Import / export for the configured selected dataset. Export provides the entire compact JSON archive as a download and read-only text, replacing the previous 500-character truncation. Import shows an explicit target, overwrite semantics, success or error. Pending operations cannot double-submit. Dataset changes clear old archives/results and ignore prior completions. Blob URLs are revoked when replaced or unmounted. No browser configuration contains upstream service credentials.

## Evidence

- Baseline HTTP regressions: `/tmp/cms-ops-before.log` reproduces both missing-identity forwarding and default migration success before correction.
- `npm test -w ./cmsfn/server`: 107 tests/18 files passed. New HTTP cases cover missing/throwing/denied identity, default migration denial, explicit migration callback, target permission precedence, sanitized callback errors, malformed bodies/artifacts and oversized export/import requests without producer calls.
- `npm test -w ./cmsfn/studio`: 82 tests/18 files passed, including complete artifact/download, success, scoped late export, malformed JSON no request and import uncertainty without duplicate submissions.
- Server and Studio `npm run typecheck` passed. Turbo Studio/server dependency build: 31 tasks successful, 29 cached; both changed packages rebuilt with declarations.
- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness` passed with real ContentFn `fdd2678a244c208a713e3df729f5907fcca960d1`. The complete installed App ran in Chromium 143.0.7499.4 with 118 actual API requests, retaining earlier authoring, singleton, audit and release checks. New acceptance downloaded a complete archive, changed then restored a document, rejected duplicate malformed snapshots without mutation, denied migration by default, enabled only explicit prod-to-staging migration, checked both source and target values, and denied operations after role revocation. The real producer required the trusted server header for HTTP import/export.
- Fresh normal npm 11 packed production install: 174 packages audited, zero advisories; adding consumer tooling: 185 packages, zero advisories. Strict installed NodeNext JSX/CommonJS consumers and ESM/CommonJS server rendering passed. These are isolated consumer audit results, not monorepo-wide audit results.

Receipts: `/tmp/cms-ops-{server-tests,studio-tests,server-types,studio-types,build,packed}.log` and `/tmp/cms-ops-production-audit-final.json`. Owned browser/server processes close in fixture cleanup, and the isolated installation is removed after receipt collection. No provider send, ContentFn edit, deployment or push occurred.

## Remaining original scope, classified

- Scheduled publishing is required by SPEC invariant 8. REL-001's optional target time means individual releases may be manual; it does not make scheduler support optional. Current runtime stores `publishAt` but has no due-release executor. Studio states this limitation and exposes no false scheduling control.
- STATUS-001 requires startup and relevant per-request capability checks. The current capability client runs only through GET `/cmsfn/status`; startup/operation enforcement remains open.
- DESK-001 history is P1 SHOULD with a concrete deterministic revision-list acceptance criterion; no history pane exists. Its diff UI is explicitly optional.
- Preview and media are already mounted inside the document editor. Broader native feature acceptance remains open; they are not absent navigation surfaces.
- Native Safari, deployment authentication/session/CORS policy and external database/service acceptance remain separate gates. Large-archive streaming/background job integration is not claimed by this bounded synchronous path. Whole-CMS readiness remains incomplete.
