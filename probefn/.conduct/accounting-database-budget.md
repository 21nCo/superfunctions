# Pager-enforced accounting database budget — 2026-10-23

Original STORAGE-002 and SPEC limits require configurable per-run artifact caps
(default2GiB), explicit failure/rollover and no silent truncation. The existing
run scan accounts payload lengths and staged writes, but excludes the shared
SQLite accounting database and opaque browser scratch. This checkpoint bounds
one previously unbounded component; it does not redefine or complete the original
aggregate physical disk requirement.

`ArtifactStoreOptions.caps.maxAccountingDatabaseBytes` is an optional, additive
shared-artifact-root budget, default16MiB. It limits the main `.quota.sqlite` file,
not each run. Values must be safe integer bytes at least64KiB. The byte budget is
rounded down to whole SQLite pages. Every cooperating connection sets and checks
`PRAGMA max_page_count` inside its exclusive writer transaction. The minimum
accepted byte budget is persisted and reapplied after reopening and after
reacquiring the writer lock; another writer's larger configuration cannot raise
it. The existing per-run payload cap is unchanged.

Existing accounting schemas migrate in place without changing stored run limits.
An existing database already larger than a newly configured budget fails explicitly
without truncation or deletion. Choose a sufficient budget before first use of a
new artifact root; raising an already accepted minimum requires a separately
managed migration, not deleting accounting/evidence files. The default may reject
an existing database larger than16MiB; configure an adequate initial value for
such a legacy root before its first upgraded write.

Real SQLite FULL failures become `E_STORAGE_CAP_EXCEEDED` with
`details.budget='accounting-database'`. Transactions roll back; existing evidence
is preserved. DELETE rollback journaling remains enabled and transient journal
cleanup is checked. A failed operation that already wrote an artifact before a
later metadata error can leave that evidence on disk; this does not imply rollback
of filesystem side effects. The next writer rescans persisted files.

SQLite documents the pager maximum and the distinction between database pages and
journal retention in its [PRAGMA reference](https://www.sqlite.org/pragma.html#pragma_max_page_count).
A database page cap is not an OS quota. Filesystem allocation/metadata, active
rollback-journal peak, browser profiles, trace/video scratch and non-cooperating
external writers remain outside this bound. No polling-based scratch monitor is
presented as a hard limit. A whole-process/volume guarantee still requires an
appropriate bounded filesystem/OS facility or bounded producer API.

Native pressure fixture:65,659-byte configured budget yielded65,536-byte database
and65,536 allocated bytes on this host.125 new ownership rows were committed before
SQLite itself rejected growth; the rejected transaction did not add a row. Reopen
with a1MiB configuration retained the lower budget. Existing artifact contents and
SQLite integrity remained intact, and no journal/WAL/SHM file remained. Two
independent processes using64KiB and1MiB configurations both hit the persisted
64KiB limit. Invalid sizes and too-small limits for existing databases are rejected;
a legacy schema retains its prior17-byte run cap. Owned fixture directories and
worker processes are cleaned up. Tests use native file SQLite, not injected FULL.

Commands:

```sh
# From probefn/
node ../node_modules/vitest/vitest.mjs run packages/storage/test/accounting-database-cap.test.ts
# From monorepo root
turbo run build typecheck test --filter=@probefn/workspace --filter=@probefn/admin
```

Initial native results:3 cases passed in571ms; the final suite additionally includes
legacy-schema preservation. Logs `/tmp/probe-accounting-cap.log` and
`/tmp/probe-accounting-full.log`. No dependency, Python or deployment changes.

Final validation:186 integration tests in36 files (all four accounting cases),
four admin tests, strict types and all17 build/check tasks passed. The installed
13-tarball consumer also passed its Chromium143/Playwright1.57 workflow, scoped
admin persistence, CLI/MCP reports and strict declarations with production audit0
(`/tmp/probe-accounting-installed.log`). Its owned HTTP PID80047 was absent after
stop and temporary installation removed. No owned validation processes remain.
