# ContentFn SQL service acceptance

2026-10-18. Local PostgreSQL 17 and MySQL 8.4.11, Kysely adapter from the current shared DB prerequisite, explicit default JSON-text codec. Disposable localhost containers; no cloud deployment or publication.

The opt-in `server/src/__tests__/sql-services.integration.test.ts` accepts `CONTENTFN_TEST_POSTGRES_URL` and `CONTENTFN_TEST_MYSQL_URL`. Install `pg` and `mysql2` in the test environment, or set `CONTENTFN_SQL_DRIVER_ROOT` to a separate directory containing their package.json/node_modules. The targets must be empty disposable databases. The test creates ContentFn tables, drops only the tables it created, and closes the adapter. MySQL migration strings use LONGTEXT, preserving unrestricted IDs and JSON above TEXT's 65,535-byte limit.

Coverage: 120KiB Unicode documents, 1,000-character Unicode IDs, case/accent/trailing-space distinct IDs, exact-ID patch/deletion isolation, draft publication and stale revision rejection, validation rollback, simultaneous revision CAS, persisted HTTP idempotency across server recreation, query/history/export and dataset cleanup. These tests exercise live engines, not mocked SQL generation. Native JSON mode and every third-party adapter are not established by this matrix.

Live MySQL exposed a collation defect: document lookups used the unbounded public-ID string while physical identities already used SHA-256. The default collation merged distinct IDs such as Post/post. Document CRUD, publish/unpublish, restore, import, references and expansion now select the existing exact physical identity. No schema version or public ID limit changed.

The first cold PostgreSQL run hit its 30-second setup timeout while MySQL initialized concurrently. After readiness, both live engines passed. A prior schema-discovery unit test timed out during dynamic module loading under local I/O contention; imports are now collected before the test begins, preserving the test's original five-second runtime allowance.

Delivery remains dependent on shared prerequisites: DB0.4.0 schema/codec/Kysely fixes, HTTP0.3.1 router export, admin0.1.5/MCP0.0.6 chain, and the workspace's storage/Markdown packages. This origin-based implementation worktree is not the eventual sf-next delivery branch: replay ContentFn changes on sf-next/next and reconcile prerequisites/lockfile before creating its draft. Prior packed/browser evidence predates this exact-ID change and must be refreshed for final release acceptance.
