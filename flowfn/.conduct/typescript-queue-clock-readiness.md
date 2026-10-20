# Storage-clock queue delays (TypeScript)

2026-10-20. `SPEC.md` requires relative delayed jobs and retries (queue examples
at lines 180 and 284, retry behavior at 1299 onward). New Redis and PostgreSQL
creation/re-enqueue now derive timestamps and due times from their storage clock,
and claims compare against that authority and record storage-side processedOn.
Redis samples TIME inside the existing Lua operation. PostgreSQL samples one
materialized clock per insert/claim statement; claim persistence replaces the
previous separate databaseNow query. Lease token validation is unchanged.

The original code failed all four native ±one-hour producer-skew cases:
`/tmp/flowfn-clock-before.log`. The new contract tests ordinary/deduplicated
creation, fast worker non-claim before due, slow worker claim after due, and a
leased re-enqueue under opposite producer skew. Creation/retry/claim timestamps
are checked against the unmocked clock of the local container host.

Validation from worktree root:

- `node flowfn/typescript/scripts/provider-acceptance.mjs`: build and 65 native
  Redis 7/PostgreSQL 16 cases pass, `/tmp/flowfn-clock-native-final.log`.
- `npm test -w @flowfn/core`: 157 pass, 65 provider-dependent cases skipped;
  `/tmp/flowfn-clock-source-tests.log`.
- `npm run lint -w @flowfn/core`: pass;
  `/tmp/flowfn-clock-source-types.log`.
- `npm run typecheck:tests -w @flowfn/core`: pass;
  `/tmp/flowfn-clock-test-types.log`.

The provider runner created unique loopback-bound containers and removed/read back
only those containers. No `flowfn-acceptance-*` containers remain. Unrelated
services were not changed.

Existing stored absolute schedules and record layout are preserved, including
legacy Redis index reconstruction. An older producer's already-skewed schedule
needs explicit re-enqueue to start a new relative delay. Storage-server clock
jumps, completion/retention timestamp authority and full performance requirements
remain separate gates. These are functional local-provider results, not hosted
or throughput acceptance. Python parity is a separate implementation slice.
