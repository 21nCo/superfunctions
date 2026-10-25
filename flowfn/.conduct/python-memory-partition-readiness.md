# Python Memory stream partition checkpoint

## Requirement and baseline

`flowfn/SPEC.md` identifies stream partitioning as P0 (stream capabilities, lines355–366), alongside consumer groups, acknowledgement, replay and retention. The published TypeScript Memory, Redis and PostgreSQL implementations use `sha256-utf8-u32be-v1`. Python previously accepted `partitions` through its options dictionary but ignored it; `PublishOptions.partition` was metadata rather than an ownership boundary.

Against source ancestor `963620651fca736ad5792f3c2b24d2c78c8ccf54`, the first two tests in `tests/test_memory_stream_partitions.py` both failed: the Unicode-key publications had `partition=None`, and two same-partition messages entered concurrent callbacks. This checkpoint implements the Python Memory provider slice. It does not complete Python Redis/PostgreSQL parity or original performance gates.

## Behavior

- A Memory adapter retains an immutable stream count after configuration. Used legacy publication/group state cannot convert, even after payload trim. An unconfigured reopened handle adopts the same adapter's policy; a contradictory cached-handle request fails.
- Exact UTF-8 SHA-256 routing, first unsigned big-endian32 bits modulo count, matches the six TypeScript routing vectors (empty, Greek, composed/decomposed accent, Japanese, emoji). Invalid counts, malformed Unicode and invalid explicit indices fail before publication.
- Sparse per-group cursors and independent receipt barriers allow different partitions/groups to progress. Global IDs and retained history remain shared. A million configured partitions allocates only encountered progress/barriers.
- Receipts use the existing `LeaseExpiry` and `run_with_lease` primitives. Active callbacks renew; returned manual callbacks stop renewing and expire at their last confirmed deadline. Current ACK/NACK or unsubscribe releases ownership; stale callbacks cannot settle a successor. Consumer ownership uses a unique token, not reusable consumer names.
- Configured retention deletes payloads independently of live receipts. A trimmed delivery cannot renew; renewal failure cancels its callback but preserves the original barrier until expiry or authorized settlement. No hidden retry payload copy survives trim. Unsubscribe awaits callback cancellation and then releases only that consumer instance's receipts, including the renewal-failure waiting path.
- Explicit partition requests on unsupported adapters reject before publication, group creation or retention calls. Redis/PostgreSQL tests replace those methods with forbidden-I/O assertions and use no provider connections.

## Validation

Final validation on October25,2026:

- `PATH="$task_env/bin:$PATH" node scripts/ci-run-python-package.mjs flowfn/python`: normal editable `[dev]` install, wheel/sdist build, Ruff, strict whole-tree mypy88 files,117 tests passed/126 skipped (7.52s). Skipped cases are not accepted evidence; no Redis/PostgreSQL services were launched in this slice.
- Fresh isolated wheel on Python3.9.6:26 partition tests passed (2.71s), strict installed-consumer typing passed.
- Fresh isolated wheel on Python3.11.14:26 partition tests passed (3.05s), strict installed-consumer typing passed.
- Both installed imports were verified under their isolated environment prefixes, outside the source checkout. Both consumer environments were removed by the fixture and absence checked. All test/type/build processes exited0.
- TypeScript runtime is unchanged; the routing vectors reproduce `typescript/src/stream/partition.test.ts`. Existing TypeScript native/performance results are not reattributed to this Python slice.
- No package/lockfile dependency changes, external services, containers, provider sends, or deployments.

Reproducible isolated wheel acceptance: `python flowfn/.conduct/verify-python-memory-partitions.py`. It builds a fresh wheel, installs normal development extras into independent Python3.9/3.11 environments outside the checkout, verifies import origin, runs the contract suite and strict consumer typing, then removes the owned temporary consumers.

## Remaining requirements and operational boundaries

Memory state is process-local and disappears on process termination. Python Redis/PostgreSQL partitioning remains required and deliberately fails closed for explicit configuration. Cross-language durable-store interoperability is not established: existing Python provider schemas/key layouts differ from TypeScript.

Unconfigured Python Memory retains its older pending-payload protection and lacks the new manual receipt expiry. Those are unresolved parity requirements, not a waiver or a claim that legacy behavior meets the complete stream contract. Existing range/replay APIs and their preexisting semantics are unchanged. Cancellation-resistant callbacks can delay shutdown, and fencing cannot undo external effects from expired callbacks. No service-provider acceptance or Python performance claim is made here.
