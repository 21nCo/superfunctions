# Studio manual release integration and concurrent additions

The complete Studio App now exposes Releases for the selected configured dataset. A named release can be created, populated with canonical draft IDs and published through the actual CmsFn endpoints. Duplicate additions remain idempotent. Each published document and each failure is shown individually in server order. Publishing remains best-effort: one document's workflow/permission failure does not prevent later eligible documents from publishing.

Server `release.manage`, per-document `doc.publish` and workflow gates remain authoritative. Missing API configuration is explicit. Dataset changes remount the scoped session, immediately removing old metadata and ignoring previous requests' completions. An imperative pending guard prevents duplicate submissions. Responses must have the expected release/dataset identity and field shapes. Denial removes metadata and mutation controls. Network or malformed mutation responses report an uncertain outcome with no automatic retry; refresh/check is required before trying again.

## Concurrent add correctness

The prior read-modify-write storage operation lost one of two simultaneous additions and could acknowledge both competing additions at the 500-document boundary. A deterministic baseline test reproduced both failures with separate Kysely adapters/connections to one real SQLite file, synchronizing their initial reads.

Add now atomically matches dataset, release ID and observed `updatedAt`, then updates membership and the token together. The next timestamp is strictly greater than the stored timestamp even within one clock millisecond. Invalid, noncanonical or exhausted stored ISO timestamps fail closed. A lost compare-and-swap retries at most eight times, rechecking duplicate membership and capacity each time; exhaustion returns `CONFLICT`. The schema does not change. Existing valid ISO timestamp rows need no backfill.

Only add currently modifies release membership after creation. Publish reads its membership snapshot and writes no release membership/status, so it cannot overwrite a concurrent addition. A document added after publication captures that snapshot belongs to a future manual publish attempt. Any future release mutation must participate in the same monotonic token contract. Mixed deployments with old unconditional writers are not fenced: drain/upgrade old writers before relying on concurrent-add guarantees. Native JSON-column migration limitations from the existing storage contract remain unchanged.

## Validation

- `npm test -w ./cmsfn/studio`: 78 tests across 17 files passed. New cases exercise create/add/canonical IDs, complete partial results, pending submission lock, uncertain transport without retry, ignored old-dataset mutation completion, denial and foreign-dataset refusal.
- `npm test -w ./cmsfn/server`: 103 tests across 17 files passed. New native SQLite tests prove two independent writers preserve both additions and permit only one final capacity slot; duplicate addition and dataset isolation remain intact. Memory tests prove concurrent updates with a fixed clock, strict timestamp validation/overflow refusal and bounded conflict retries.
- Studio and server `npm run typecheck` passed.
- `npx --yes turbo@2.6.1 run build --filter=@cmsfn/studio... --filter=@cmsfn/server...`: 31 successful tasks, 29 cached; server and Studio outputs/declarations rebuilt.

- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness`: complete installed App acceptance passed against actual ContentFn head `fdd2678a244c208a713e3df729f5907fcca960d1`. Chromium 143.0.7499.4 executed 108 actual API requests, retaining all earlier authoring/singleton/audit coverage. Release navigation created a batch, added canonical IDs with an idempotent duplicate, published the later approved draft after the earlier blocked draft failed, verified actual published ContentFn state, switched datasets without carrying results and proved server role denial removes metadata/controls.
- Normal npm 11 packed production installation audited 174 packages with zero advisories; adding consumer tooling audited 185 with zero. Strict installed NodeNext JSX/CommonJS consumers and ESM/CommonJS server rendering passed. This is an isolated production-consumer audit, not a monorepo dependency audit.
- `/tmp/cms-release-shell-packed.log` retains the complete install/browser/consumer receipt. Its private install, browser and servers were cleaned; production audit retained as `/tmp/cms-release-shell-production-audit-final.json`. Native SQLite fixtures close both connections and remove their temporary database directories.

 Baseline regression receipt: `/tmp/cms-release-cas-before.log`; corrected focused receipt `/tmp/cms-release-cas-after.log`; full receipts `/tmp/cms-release-{shell-tests,server-tests,shell-types,server-types,shell-build}.log`.

## Remaining original requirements

Automatic release scheduling is still unimplemented: stored `publishAt` does not schedule work, and Studio explicitly says so rather than exposing a false scheduling control. Remaining operational shell surfaces, native Safari and deployment acceptance remain open. No release deployment, remote provider send or push was performed. ContentFn source and shared dependencies are unchanged.
