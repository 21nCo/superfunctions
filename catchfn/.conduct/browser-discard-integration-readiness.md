# Browser discard integration

2026-10-20. Catch incorporates Watch commit `0526b7b6234ae79371a5fe9c3df45db839ab1bcf` by ordinary merge `ed1cd24527f95a2ac7856c9ee76cc2823cd1d577` onto Catch `259419bc5`. The integration adds the underlying browser transport discard API and generation fencing without changing Catch capture, retry, widget, retention, or synthetic/alert behavior. Catch does not expose a new consent API in this change.

Validation on the integrated tree:

- Rebuilt `@watchfn/browser` CJS/ESM/IIFE/declarations before rebuilding Catch.
- All103 Catch SDK tests pass, plus SDK/admin TypeScript checks and Catch CJS/ESM/declaration builds.
- `botfn-acceptance.mjs`: built SDK and Chrome through actual Watch HTTP/native SQLite, close/reopen, actual BotFn GitHub client against local HTTP fixture, replay deduplication, auth/route denial, verified widget links, bounded payload expiration and retained replay/status receipts pass.
- `watchfn-acceptance.mjs`: actual HTTP/native SQLite reopen, auth, canonical metadata, authenticated query, storage failure and retry pass.
- `browser-delivery-acceptance.mjs`: actual Chrome cross-origin delivery, same-ID503 retry, offline/CORS recovery, auth/redaction, lost-response at-least-once arrivals and explicit new-report choice pass.

The browser dependency is built from this integrated checkout. `CATCHFN_WATCH_CORE` points to the built sibling Watch core at identical source; the merge changes browser code only. All commands exited0 and acceptance finally handlers closed browser/server/database resources and removed their temporary files. No external provider issue or deployment was created.

Logs: `/tmp/catch-discard-{tests,browser-build,build,types,botfn-acceptance,watchfn-acceptance,browser-delivery-acceptance}.log`. Run existing commands from `query-streaming-integration-readiness.md` after rebuilding the browser dependency. The discard primitive itself is validated by39 Watch browser tests and actualChrome localHTTP in `watchfn/.conduct/browser-discard-readiness.md`.

These are local integration receipts, not hosted readiness or arbitrary remote retraction. Discard cannot retract a request already handed to the network. Existing at-least-once delivery, Watch API-key authority and original outstanding readiness gates remain unchanged.
