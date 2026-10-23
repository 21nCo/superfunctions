# Studio audit shell integration

The complete App now exposes Audit events and Webhook deliveries beside its configured desk. Both use the selected configured dataset and the real CmsFn audit endpoints. Missing CmsFn API configuration is an explicit unavailable state. Server `audit.read` authorization remains authoritative; the UI does not infer roles from configuration or bypass either producer or consumer policies.

The audit loader clears prior data immediately when its endpoint, dataset or permission scope changes, aborts superseded requests and ignores late results even if a transport ignores cancellation. A later-page permission denial clears already displayed metadata and cursors and shows No access. Network, malformed-envelope, malformed displayed metadata and wrong-dataset results show a generic retryable error without raw upstream error details. Pages are limited to the requested 20 rows; cursor strings are validated and immediate non-advancing cursors rejected. Refresh starts over; a failed next page retries its cursor without replacing preceding records.

Events render identifiers, action/time and authoritative target/document IDs only. Deliveries show webhook/event IDs, status, attempts and known/unknown time. They do not render destination URLs, provider error text or document bodies. Empty results are explicit. Server ordering and opaque pagination are preserved.

## Validation

- `npm run typecheck -w ./cmsfn/studio`: passed.
- `npm test -w ./cmsfn/studio`: 73 tests across 16 files passed. Added full App navigation/dataset/cursor tests, absent-API no-request state, ignored late responses, denial after an authorized page, retry after a network failure, malformed metadata and wrong-dataset refusal.
- `npx --yes turbo@2.6.1 run build --filter=@cmsfn/studio... --filter=@cmsfn/server...`: 31 successful tasks, 30 cached; Studio JavaScript and matching declarations rebuilt.
- Installed full App acceptance uses real packed CmsFn/ContentFn packages with ContentFn head `fdd2678a244c208a713e3df729f5907fcca960d1`, normal npm 11 installation and a private Chromium 143.0.7499.4 profile. Production installation audits 174 packages with zero advisories; consumer tooling audits 185 with zero. These are isolated consumer counts, not a monorepo audit claim.
- Native browser acceptance retains the complete authoring and singleton lifecycle, then navigates audit pages, consumes all event pages and compares IDs/order against the actual producer result. It consumes all queued delivery metadata and compares event IDs/order against the real dataset-wide producer query. Dataset switching clears prior deliveries, staging returns its own empty queue, and actual CmsFn role denial removes records for both panes. Document bodies and destination/signing secrets never appear in the audit UI. There are 91 actual API requests. Webhooks remain queued; no delivery/provider send is performed.
- Strict installed NodeNext JSX/CommonJS consumers and ESM/CommonJS server rendering pass.

Commands/receipts: `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness`; `/tmp/cms-audit-shell-{types,tests,build,packed-final}.log`. An initial fixture expected exactly 25 seeded deliveries, overlooking the existing authoring fork's additional creation event. The final fixture compares against actual producer records instead of that fixed count; the initial failure remains in `/tmp/cms-audit-shell-packed.log`. Isolated installs and owned browser/server processes are cleaned after verification; audit receipts are retained in `/tmp`.

## Remaining requirements

This closes the audit navigation/metadata viewer slice, not all Studio operational requirements. Release navigation, remaining operational surfaces, native Safari and deployment acceptance remain open. Production hosts must configure authentication, upstream audit identity and schema 4 webhook history readiness/backfill; those deployment responsibilities are unchanged. No ContentFn source changes, deployment, release or push were performed.
