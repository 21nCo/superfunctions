# Studio media workflow

MEDIA-001 (P0, original requirements 145–154 / plan phase 08) requires real upload,
deterministic browsing and canonical insertion. Initial regressions reproduced reading
an oversized File before checking its limit, overcounting padded base64, and ignored
disabled asset controls. All three failures are in `/tmp/cms-media-baseline.log`.

The media library checks File.size before reading, validates exact decoded base64 length,
uses bounded metadata transport, replaces deterministic offset pages and clears data on
scope changes or permission revocation. Network requests have explicit deadlines;
unknown provider error strings are not displayed. Filename text cannot become markup.

Nested object asset fields previously omitted media picker options entirely. They now
carry literal schema key segments into immutable insertion, preserving siblings without
splitting dotted keys. Prototype keys and array traversal are rejected. Picker state is
bound to the loaded document and cleared on reload/navigation; stale callbacks cannot
insert into a different document. Array-item media editing remains a separate editor gap.

Producer authorization and byte limits are exercised through actual ContentFn HTTP and
programmatic contracts. The installed full-App fixture configures a persistent test
InMemoryStorageBackend instance and checks uploaded bytes, metadata pages and saved
canonical document references. This proves the browser/transport/producer contract, not
durable filesystem/cloud asset hosting. Offset pagination does not provide snapshot
stability under concurrent insertions/deletions.

Validation completed on Node 20.20.0:

- `npm run typecheck -w ./cmsfn/studio`: passed.
- Focused media regression suite: 16 tests passed, including malformed metadata,
  late cross-dataset results, denial, page replacement, literal nested keys, prototype/
  array rejection, and open-picker document switch with a late response.
- `npm test -w ./cmsfn/studio`: all 110 tests / 22 files passed.
- `npm run build -w ./cmsfn/studio`: passed, including ESM/CJS declarations.
- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root
  /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness`: normal npm 11
  installation of 32 local packed dependencies, Chromium 143.0.7499.4 entire App,
  198 HTTP interactions, strict installed consumer and ESM/CJS exports passed.
  Media assertions include 53 assets across two deterministic pages, an accepted
  16-byte producer upload and rejected 17-byte upload, no browser request for an
  oversized File, exact stored uploaded bytes, nested canonical reference persistence
  with a sibling edited while the picker is open, permission revocation, and navigation
  to another dataset/document without carrying the old picker.
- Production-only install audit: zero vulnerabilities. The separately installed browser
  tooling also reported zero. No server implementation changed in this slice.

Receipts: `/tmp/cms-media-{baseline,focused,types-final,full,build,packed}.log` and
`/tmp/cms-media-production-audit.json`. The disposable packed consumer was removed after
retaining receipts, and all owned browser/HTTP/test processes completed.

Reference-picker completion, array-item media editing, native Safari and deployed host
acceptance remain separate original readiness work; no Python Studio implementation is
introduced.
