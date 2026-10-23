# Ordered history index and long-identity cursors

The prior history checkpoint bounded materialized rows but left database scan/sort
cost open. This checkpoint splits base/draft identities into exact shared-adapter
queries and supplies an explicit ordered-index migration descriptor/hook. First
pages perform two index seeks; continuation pages perform three disjoint ranges
per identity, at most six seeks and `6 * (limit + 1)` materialized candidates.
Total ordering and full snapshot/authorization contracts remain unchanged.

`getHistoryIndexDefinition()` supplies nonunique
`contentfn_revisions_history_v1(dataset ASC, docId ASC, timestamp DESC, rev ASC,
id ASC)`. `upgradeHistoryIndexSchema(hostAdapter)` invokes the host's normal
schema migration implementation. The host must verify existing same-name indexes
including directions and uniqueness, and reject a mismatch. It runs explicitly
on fresh/existing tables; no automatic DDL or parallel SQL query runtime is added.
The shared schema CLI cannot currently represent directions, so it does not
establish this migration's readiness. See server README for the actual DDL and
host contract.

New version-2 cursors bind the existing SHA-256 documentStorageId scope instead
of embedding unrestricted public IDs. This fixes valid long IDs producing their
own oversized/unusable cursor. Safe version-1 scoped cursors remain accepted;
unbound legacy cursors still reject. Cross-document/dataset denial remains.

Validation with Node 22.22.0:

- Focused history/index/keyset: 9 passed; strict server types passed.
- Full server: 210 passed, 2 external SQL tests skipped (32 passing files).
- Turbo ContentFn dependency build: 13 tasks passed.
- Normal npm 11 clean production packed install: zero audit vulnerabilities;
  installed real HTTP revision pages, long-ID paging, bound cursor denial,
  permission denial and exported migration failure propagation passed.
- Native SQLite populates 50,000 rows (40,000 unrelated and 10,000 requested
  history rows, with equal timestamps/revisions across draft/published versions).
  Repeated migration preserves all rows; incompatible same-name index rejects.
  First/next/deep pages return the expected mixed-direction/tie order. All 14
  actual generated SELECT query plans use the ordered index, with neither SCAN
  nor TEMP B-TREE:

```text
SEARCH contentfn_revisions USING INDEX contentfn_revisions_history_v1 (dataset=? AND docId=?)
SEARCH contentfn_revisions USING INDEX contentfn_revisions_history_v1 (dataset=? AND docId=? AND timestamp<?)
SEARCH contentfn_revisions USING INDEX contentfn_revisions_history_v1 (dataset=? AND docId=? AND timestamp=? AND rev>?)
SEARCH contentfn_revisions USING INDEX contentfn_revisions_history_v1 (dataset=? AND docId=? AND timestamp=? AND rev=? AND id>?)
```

Receipts: `/tmp/content-history-index-{focused,types,full,build,packed}.log`.

This is actual populated SQLite plan evidence, not a universal provider claim.
PostgreSQL/MySQL plans/online migration remain unverified. Unrestricted TEXT
public IDs also require a separate bounded-key index design before PostgreSQL
entry-size/MySQL byte-prefix constraints can preserve the same performance
contract for all IDs. Memory storage has functional behavior without physical
index acceleration. No live database migration, provider send or deployment.
