# Studio perspective prerequisite — 2026-10-23

CMS DOC-003 requires explicit draft/published perspective and editing/publication operations. No merged preview-list contract was found in the CMS original SPEC/phases; Content SPEC428–432 explicitly defines draft-only reads and permits unsupported raw perspective.

Added typed CFQL `perspective: 'published' | 'draft'`, default published. The storage table is selected before filter/order/page/projection. Draft authorization is `query.drafts`, reached through the same HTTP and direct API dispatcher. Draft references prefer drafts then published fallback; published queries cannot expand drafts. Dataset/perspective/filter/types/order/projection are bound into new opaque cursors. Existing unbound cursors fail with `QUERY_INVALID` and require a first-page restart rather than silently crossing scope.

Added `docs.fork({dataset,id,ifRev})` on server/client/HTTP, with distinct `docs.fork` authorization. It captures the published document, checks the supplied revision, and conditionally updates that row to its same revision within the mutation transaction, acquiring the source row lock before draft insertion. Zero matched rows denies with `REV_CONFLICT`. The published content/revision remain unchanged. Draft creation uses the existing unique-key check, revision/event persistence, and transaction rollback; the common dispatcher records `docs.fork` audit atomically. New system identity/revision/timestamps replace published ones and `_publishedAt` is removed. Application content metadata remains content; this generic producer does not infer CMS workflow policy.

Existing drafts are never overwritten; collision details contain only ID, not existing content. A consumer must use the separately authorized docs.get route to load the winner. Fork alone does not authorize arbitrary existing draft reads.

Validation:

- Node22.22 native full server: 205 passed, 2 pre-existing external SQL integration skips.
- Core21 tests and client5 tests passed; strict server/client types and core/server/client builds passed.
- Native SQLite verifies source conditional update/lock path, successful fork, unchanged published content, stripped publication field, and duplicate refusal.
- Focused cases cover exact draft pagination; wrong dataset/perspective/filter/order and legacy cursor denial; malformed perspectives; denied/throwing policies; draft reference fallback; stale source; concurrent fork collision; source CAS loss; revision-write rollback with no draft/audit; distinct HTTP fork permission; missing/malformed revision; existing-content confidentiality.
- Fresh normally installed full local producer/client closure: zero production npm advisories. Actual client → owned Node HTTP tests exercise query authorization/pagination, source-CAS fork, stale revision/collision, system-field isolation, and audit. Fixture: `draft-perspective-http.mjs`. Strict installed NodeNext ESM/CommonJS consumer type readers pass with no skipLibCheck.

Logs: `/tmp/content-perspective-*`. No external provider, deployment or database was used. PostgreSQL/MySQL lock behavior remains covered by implementation semantics but their existing native service acceptance gates were not run here; SQLite is the native database proven in this checkpoint. This prerequisite does not itself complete Studio lifecycle integration or its broader remaining UX requirements.
