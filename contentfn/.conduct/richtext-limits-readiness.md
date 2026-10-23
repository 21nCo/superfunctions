# Producer richtext block limits

CmsFn LIMIT-001 defines a default maximum of 5,000 blocks per richtext field. ContentFn
previously validated portable block/span keys and mark allow lists but imposed no block
count, allowing direct writes to bypass Studio prechecks. `limits.maxRichtextBlocks` now
resolves to 5,000 by default and accepts a positive safe integer override. Status exposes
that resolved value. Schema-driven validation applies it to nested objects and array
alternatives on create, patch, fork, restore, manual publication and scheduled publication.
Read normalization remains uncapped so existing content can be inspected and corrected.

Import uses a separate limit-only traversal before mutation. Archive revision records
carry snapshots but no historical schemas, so only richtext declarations in the archive's
latest schema can be classified. Unknown/removed historical fields and arbitrary JSON
remain compatible; this is not a global richtext/archive-array cap. Later restore and
publication always validate against the current schema and configured limit. Import
transaction recursion preserves the configured override. No existing document or snapshot
is truncated. Failed content writes do not append revision/event/audit records.

Validation on Node 22.22.0:

- Focused two-test suite covers exact 5,000/5,001 default boundary, invalid configuration,
  nested paths and unknown historical JSON. A real SQLite fixture reopens with a lower
  configured limit, then rejects HTTP-router create/patch/import and API publish/fork/
  restore/scheduled publication. Revision/event/audit counts and existing content remain
  unchanged; no rejected import dataset is created. A correction within the limit and
  subsequent publish succeed.
- `npx turbo run typecheck test build --filter=@contentfn/server`: 15 successful tasks
  (10 cached), 212 server tests passed and two existing provider tests skipped. Types and
  ESM/CJS declarations pass.
- Normal npm 11 isolated nine-package production installation reported zero audit
  vulnerabilities. Installed real loopback HTTP verifies configured status, canonical
  marks, nested create/patch denial, unchanged revision, atomic import denial and valid
  publication. The first fixture omitted explicit draft perspective on docs/get and
  failed DOCUMENT_NOT_FOUND; the corrected fixture passed in the same normally installed
  consumer. The failed receipt remains separate.

Commands/receipts: `/tmp/content-richtext-{focused,types-final,validation,packed,
packed-final}.log`; packed driver is `contentfn/.conduct/publish-idempotency-packed.py
contentfn/.conduct/richtext-limits-packed.mjs`. Production audit is retained as
`/tmp/content-richtext-production-audit.json`. The owned installed consumer was removed
and read back absent; no owned fixture processes remain. No live provider/deployment
claims or universal historical-schema classification are made.
