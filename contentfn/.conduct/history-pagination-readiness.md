# Document history pagination prerequisite

CMS DESK-001/TV-DESK-PANES-001 requires the real ContentFn `docs.history`
revision list, newest first, with denied readers receiving no revision content.
The existing producer returned full snapshots but loaded every dataset revision.

History now scopes every revision query by dataset and both base/draft document
identities. The total order is timestamp DESC, revision ASC, storage identity ASC.
The shared flat-predicate adapter uses three disjoint keyset ranges with at most
`limit + 1` rows each; merged pages return at most the requested limit. Version-1
cursors bind dataset/base document; legacy unbound cursors require first-page
restart. Authorization remains before storage access. Returned snapshots are
cloned so native memory callers cannot mutate persisted history or restore input.
The existing draft/published snapshot response shape and restore endpoint remain.

Validation with Node 22.22.0 (matching the checkout's native SQLite ABI):

- `npm test -w ./contentfn/server`: 208 passed, 2 external SQL tests skipped.
- `npm run typecheck -w ./contentfn/server`: passed.
- `npx --yes turbo@2.6.1 run build --filter=@contentfn/server...`: 13 tasks passed.
- Native SQLite test uses two connections contributing equal timestamp/revision
  snapshots; traverses single-row and mixed timestamp two-row pages, checks all
  bounded query predicates, rejects crossed dataset/document and legacy cursors,
  and verifies denial before reads. Memory regression preserves history/restore
  after a caller mutates a returned snapshot.
- `python3 contentfn/.conduct/publish-idempotency-packed.py
  contentfn/.conduct/history-packed.mjs`: normal npm 11 production install,
  zero audit vulnerabilities, installed real HTTP create/patch/publish/history,
  all five resulting snapshots across pages, bound cursor denial and permission
  revocation. Publication records both locked draft and published snapshots; an
  initial fixture incorrectly expected four and was corrected to five.

Receipts: `/tmp/content-history-{full,types,build,packed}-final.log`.

This bounds materialization, not database work: existing revisions tables lack a
supporting document-history index, so scan/sort cost remains open. README provides
a candidate nonunique index. Actual supported-adapter migration/query-plan
validation remains a required performance readiness follow-up. No external SQL
service, live deployment, provider send or complete CMS history acceptance is
claimed by this producer checkpoint.
