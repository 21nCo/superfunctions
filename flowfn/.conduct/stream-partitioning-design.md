# Durable stream partitioning

## Original requirement and current failure

SPEC.md identifies event streaming as P0 and explicitly lists partitioning. Its public example constructs `stream('orders', { partitions: 3 })` and publishes a `key` described as the partition key. TypeScript exposes `StreamOptions.partitions` but never reads it; `StreamImpl.publish` merely copies an explicit partition. Python's `StreamOptions` lacks the count. Current delivery cursors are per stream/group, so labels alone cannot provide independent partition progress or ordered keyed processing.

## First complete provider slice: PostgreSQL

Keep the existing append log, message IDs, global positions, chronological range/replay, and retention deletion semantics. Add an immutable stream policy and independent per-partition group progress. Reuse the existing group-row transaction lock and message receipt/renewal machinery; do not add another distributed lock service.

Explicit partition configuration must precede stored messages or groups. Existing populated streams retain their unpartitioned behavior; silently reassigning historical keys or changing counts is prohibited. Concurrent configuration/publish operations must share the same transactional stream authority. A reopened writer may adopt an existing policy, but a conflicting explicit count or unknown routing version fails before publication. Old binaries must be drained before enabling partitioned streams because they do not participate in this protocol.

Routing is SHA-256 over exact UTF-8 bytes, taking the first four digest bytes as an unsigned big-endian integer modulo the partition count. Persist the algorithm version. Explicit valid partition overrides key routing; absent keys use the message ID so unkeyed messages distribute deterministically for that publication. Reject invalid counts, out-of-range partitions, and malformed Unicode before persistence. TypeScript/Python fixed vectors must match; no normalization is implicit.

For partitioned groups, retain the group's original creation cutoff and track each partition's last claimed position independently. The claim transaction first handles recoverable existing deliveries, then selects the earliest eligible message from a partition with no unacknowledged delivery. Update that partition's cursor and create the receipt atomically. An active lease blocks later messages only in its partition; other partitions remain available. ACK advances availability; retry keeps the same partition blocked behind its oldest outstanding message. Lease expiry permits a successor receipt, with the old handler's signal aborted and acknowledgment fenced. This guarantees one authoritative delivery per partition/group, not cancellation of arbitrary uncooperative external effects.

Retention may remove messages and their delivery records under the existing explicit retention policy. A separate partition barrier without a payload foreign key retains only message identity, receipt and storage-clock expiry. It survives active-payload deletion until authorized settlement or expiry. Renewal cannot extend it after the delivery is deleted. Claim, renewal and settlement acquire the existing group lock before delivery and barrier mutations. There is at most one barrier row per touched partition/group; later claims replace expired rows. Per-partition positions remain monotonic across gaps. Global public IDs and offsets are retained; offsets are not renumbered per partition. Group counts count logical groups, and lag uses each partition's cursor plus pending receipts without duplication.

## Acceptance

Start with a native failing test for configured key routing/reopen. Then prove two independent PostgreSQL connections: a held message prevents its keyed successor, another partition progresses, close/retry and expired receipts recover the same message before later keys, stale ACK cannot release a successor, and reopen retains count/cursors. Test conflicting first configuration, invalid configuration/publish without partial writes, fromBeginning cutoffs, range/replay/retention, and legacy behavior. Native tests use owned loopback PostgreSQL and remove all owned processes/data afterward.

## Remaining original scope

This design is not completed implementation evidence. Memory, Redis, and Python need equivalent behavior and native/installed acceptance iteratively. Unsupported adapters must explicitly reject requested partitioning rather than silently store labels. D1/SQS/Kafka, full SDK/provider parity, deployment acceptance, and all unresolved performance targets remain open. No metadata-only implementation is considered complete partition support.
