# Reference picker integration

REF-001 requires deterministic, bounded candidate previews, type/filter selection and
canonical saved references. The previous picker queried ContentFn directly with a
permissive UI read flag, accumulated pages, omitted nested object configuration and kept
old dataset candidates while a replacement request was pending. Three initial focused
regressions failed for missing filtering, retained old-scope data and empty-type queries.

The full Studio now discovers candidates through `/cmsfn/references/query`. The CMS
server validates the configured dataset, resolves roles once and requires `doc.read` for
every requested type before capability or producer requests. Trusted upstream credentials
come from a server callback. Query perspective, projection and ordering are fixed; browser
input cannot request full/private fields. Candidate labels are text and bounded to 160
characters, non-string titles fall back to name/ID, and invalid type/draft/duplicate IDs
or conflicting dataset metadata fail closed. The producer scopes query rows by dataset;
CMS binds that authorized dataset to its response rather than claiming row-level
cryptographic provenance.

Pages replace the previous page and support a type selector and case-sensitive
ID/title/name filter. Input changes clear prior candidates, cursor and search scope.
Responses are bounded to 2 MiB and oversized pages retry the same cursor with progressively
smaller limits down to one within a ten-second query deadline. Oversized single previews
fail explicitly. ContentFn owns cursor validation; changing query scope with an old
cursor is rejected. Pagination is not a snapshot under concurrent writes.

Standalone Studio requires explicit `references.authorization: 'contentfn'`, delegating
subject/dataset/type checks to its producer query policy. Missing policy denies discovery;
a configured CMS API always wins. UI read flags cannot authorize server access.

Nested object reference fields retain their literal schema keys and sibling data.
Picker ownership follows document scope. The dialog renders outside field labels using
a portal, with a stable open-button accessible name, initial focus and focus return on
close/selection/Escape. This corrects an accessibility defect found by the installed
browser when a wrapping label incorporated all dialog controls into the outer button
name. ContentFn still validates canonical references on save, including deleted targets.

## Validation

Node 20.20.0:

- Initial focused reproduction: three failures in `/tmp/cms-reference-baseline.log`.
- Owned HTTP reference tests: two passed, covering role/type/dataset boundaries,
  trusted credentials, fixed projection, HTML denial, adaptive oversized pages and
  conflicting metadata. Roles are loaded once even for multiple requested types.
- Final `npx turbo run typecheck test build --filter=cmsfn --filter=@cmsfn/server
  --filter=@cmsfn/studio`: 37 tasks successful (31 cached); core 46 tests / four files,
  server 130 / 22, Studio 119 / 23. All package types and ESM/CJS declaration builds pass.
  Studio coverage includes denied/default-unconfigured discovery, stale dataset and
  document ownership, page replacement, filter/type clearing, foreign/draft identities,
  portal control naming and focus return. Existing media coverage passes after sharing
  its bounded metadata transport.
- The first broad npm workspace selector also selected unrelated CMS admin before its
  dependencies were built and failed there; exact Turbo package selection above is the
  scoped validation. The first broad server run exposed a compatibility regression in
  generic error mapping; HTTP status precedence is now explicitly enabled only for the
  reference route, preserving existing operation envelopes.
- Initial installed browser receipt failed on the genuine label/dialog naming defect;
  that failed receipt is retained separately from corrected validation.

The final `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root
/Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness` run passed with 32
normally installed local packages, Chromium 143.0.7499.4 and 230 actual HTTP interactions.
It covers 25 published candidates across two pages, filtering, nested canonical reference
save with sibling and asset preservation, permission revocation before producer access,
changed-filter cursor denial, denied dataset and rejection after deleting the selected
target. It also verifies dialog naming/Escape focus return and the full existing App
matrix. Strict installed TypeScript reference/configuration consumers and ESM/CJS exports
passed. Production-only installation audit reported zero vulnerabilities; the separately
installed browser tooling also reported zero. The producer uses owned memory database
and test asset storage here, not deployed durable hosting. Disposable consumers were
removed after preserving logs/audit receipts; no owned HTTP/browser/test process remains.

Receipts are `/tmp/cms-reference-{baseline,server-focused,studio-focused,validation,
validation-final,validation-portal,packed,packed-final}.log`. Array-item reference/media
editing remains required editor work. Native Safari and deployed host authentication,
CORS and durable asset hosting are not established by this local Chromium/owned-server
fixture. No Python Studio implementation is introduced.
