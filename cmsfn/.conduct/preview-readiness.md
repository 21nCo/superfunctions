# Studio preview lifecycle and scoped transport

PREVIEW-001 requires actual draft preview, token minting, and ContentFn realtime updates.
The prior implementation reproduced three failures: a resolver could send a token to a
foreign origin, a document switch temporarily reused the previous token, and expired
tokens remained visible. `/tmp/cms-preview-baseline.log` records all three failing tests.

The corrected issuer uses trusted configuration for audience and bounded lifetime, signs
version 2 claims with dataset and normalized document scope, and rejects missing or
unavailable authorization. The exported target verifier checks signature, expected
trusted audience, requested dataset/document, and strict expiry. Legacy unaudienced
tokens are intentionally rejected; the issuer and target require coordinated upgrades.

The complete Studio now validates destination origin before minting, bounds token
response reads, disallows token endpoint redirects, renews before expiry, and clears
frames on scope change, denial, failure or timeout. Explicit request deadlines also
handle transports that ignore abort. Expiry is independent of request cancellation.

HTTP(S) realtime configuration uses the real `/contentfn/events` route with browser
cookie credentials. WebSocket configuration remains a host-owned transport option.
Document subscriptions use the actual stored draft ID, because ContentFn routes by exact
ID; token scope uses the base ID. Incoming events must match dataset and document. Native
EventSource cannot attach custom bearer headers; header-authenticated hosts need a
same-origin proxy. Cross-origin deployments require explicit credentialed CORS/cookies.

The installed fixture uses the entire packaged App, real CMS and Content HTTP handlers,
a real token-verifying preview target, and cookie-authorized SSE. It requires a draft
patch to refresh within 2.5 seconds before token renewal could mask a broken subscription.
It also exercises token renewal, scope denial, permission revocation and unsafe resolver
rejection. The fixture uses the shared memory adapter; this browser path does not claim
SQLite or other database persistence evidence.

The preview target remains responsible for avoiding credential-bearing URL logs,
redirects and third-party resource leakage. Native Safari and deployed host/proxy
acceptance remain separate original readiness gates. No Python Studio implementation is
introduced by this browser-specific slice.

Validation completed on Node 20.20.0:

- `npm run typecheck -w ./cmsfn/server` and Studio equivalent: passed.
- `npm test -w ./cmsfn/server`: 128 tests / 21 files passed.
- `npm test -w ./cmsfn/studio`: 101 tests / 21 files passed.
- `npx turbo run build --filter=@cmsfn/studio... --filter=@cmsfn/server...`:
  31 build tasks passed; final Studio rebuild after event-ID correction passed.
- `python3 cmsfn/.conduct/studio-packed-acceptance.py --producer-root
  /Volumes/Dev/n/worktrees/superfunctions/contentfn-sf-next-readiness`: normal npm 11
  installation of 32 packed local packages, Chromium 143.0.7499.4 full App acceptance,
  183 HTTP interactions, strict installed TypeScript consumer and ESM/CJS exports passed.
  The strict consumer also checks the exported verifier and claims types.
- Production-only dependency audit: zero vulnerabilities. Browser development tooling
  installation also reported zero; these are separate installation/audit scopes.

Receipts: `/tmp/cms-preview-server-types-final.log`,
`/tmp/cms-preview-studio-types-final.log`, `/tmp/cms-preview-server-full.log`,
`/tmp/cms-preview-studio-full.log`, `/tmp/cms-preview-build.log`,
`/tmp/cms-preview-studio-build-final.log`, `/tmp/cms-preview-packed.log`,
`/tmp/cms-preview-packed-types.log`, `/tmp/cms-preview-production-audit.json`.
Earlier typecheck failures were new test literal inference and a closure narrowing issue;
both were corrected before the final passing checks. The initial three failing behavioral
reproductions remain recorded separately from the passing regression suite.

The disposable installed consumer was removed after receipt retention; no owned browser,
HTTP server or test process remains.
