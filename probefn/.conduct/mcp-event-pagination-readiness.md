# Bounded MCP event pagination

Console, network and page-error tools now expose canonical `limit`/`cursor`
schemas and return event payloads, matching physical provenance and explicit
`nextCursor`. Default 100/max 1000; serialized data object limited to 1 MiB including
keys, arrays, provenance and cursor. The MCP wrapper adds formatting and duplicates
the bounded data in text/structured content; the 1 MiB limit is not a wire-frame
limit. Single oversized records fail with `E_STORAGE_CAP_EXCEEDED`.

The streaming iterator can resume at a signed physical position. No complete
event array is created by these tool handlers. Pages seek past old segment
contents; complete numeric directory discovery remains O(number of segments).
Byte lookahead returns the prior accepted cursor so the next page rereads every
unreturned record. All writer-supported JSON values survive, including null,
scalars and arrays. Physical blank lines remain part of provenance numbering.

Cursors use a process-local HMAC key and bind repository, sink, segment inode,
position, observed size/mtime and prior emitted record hash. Anchor identity and
size/mtime are also checked, including when resuming a later segment. Replacement,
shrinkage, same-size modifications and guarded-record rewrites fail closed.
Historical files must remain append-only; edits to older unguarded content combined
with growth are outside this contract. This is neither a snapshot nor arbitrary
concurrent-mutation protection. Cursors expire when the MCP process restarts.
An unterminated final JSON record is readable; later extension invalidates its
cursor. Follow cursors to null even for short/empty pages.

Validation includes numeric 12-segment traversal, null/scalar/array payloads,
physical provenance, sparse blank lines, UTF-8 records at byte-page boundaries,
no skipped lookahead, oversized record rejection, malformed/cross-sink cursors,
complete append traversal, replacement/truncation/guarded rewrites, unterminated
records, missing/corrupt rollover, canonical MCP tool schema bounds, actual MCP
cursor continuation and cross-tool rejection. Full unified suite 143 tests across 31 files and strict TypeScript checks pass.
The final targeted run passes 15 tests across pagination and actual MCP tools,
including direct iterator guard ranges and default page size. Strict TypeScript
checks pass after these additions. The 160,000-event scan also passes with a 64 MiB
V8 heap after guard hashing was added. Commands are run from `probefn` with the repository Vitest/TypeScript
binaries; exact final counts are recorded in the checkpoint report.

Remaining gates: the compatibility array collector and final report output still
retain output-sized memory. Report streaming/export, retained snapshots and
restart-persistent cursors are not implemented. Guard hashing adds per-record CPU
to streaming aggregations; no throughput improvement is claimed. Browser/platform, packaging,
external artifact accounting, hosted providers and other existing original
readiness gates remain open.
