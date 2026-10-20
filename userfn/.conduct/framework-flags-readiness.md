# Framework flag subscriptions

Original requirements: `spec.md` SDK `useFlag`, React/Svelte helpers and flag-based
UI E2E. This checkpoint implements flag helpers, not messaging/survey/feedback
framework components or the entire original platform.

## Contract

`UserFnClient.observeFlag` owns stable immutable selection snapshots and explicit
tracking. A successful local definition/segment/identity change or atomic verified
config application publishes a new revision. Invalid flag definitions, failed
refresh and verified 304 reuse preserve the previous snapshot. Listeners are
isolated; a fixed error message reports a failed subscriber without leaking its
exception text. Unsubscribe is idempotent and prevents pending callbacks in the
current publication sweep. Repeated subscriptions of the same callback release
independently. Reentrant subscriber setters invalidate conditional-fetch identity:
the transport caches a verified ETag only if its generation remains unchanged
after applying the snapshot; actual SQLite/HTTP tests prove a later refresh fetches
the full signed config rather than reusing 304 over locally overridden state.

A snapshot captures the evaluated value, actual rule/variation/reason and the
then-current identity ID. `track(snapshot)` uses that selection rather than
re-evaluating changed state. Weak maps/sets preserve provenance and deduplicate
only the same observation snapshot without retaining old revisions permanently.
An identity reset or A→B→A creates a fresh selection. Snapshots are not global
analytics deduplication keys. Existing synchronous `getFlag` behavior is retained.

`userfn/react` exports `UserFnProvider`, `useUserFn` and `useFlag`, with optional
React 18/19 peer compatibility. `useSyncExternalStore` observes updates; committed
effects emit exposures. Server rendering and abandoned/suspended rendering do
not emit; development StrictMode effect replay does not duplicate a selection.
Changing provider client releases the old subscription. The server/bootstrap
snapshot must match browser initial state for hydration; isolate SSR clients by
request.

`userfn/svelte` exports `flagStore` implementing Svelte's readable-store contract
without importing Svelte. Browser subscription delivery tracks its snapshot;
server subscription does not. Consumers of the same store share snapshot tracking.
A new store/remount is a new observation. Svelte auto-unsubscribe cleans up on
component removal; failed initial delivery also removes its subscription.

Neither adapter owns the client's config polling or transport close/flush. They
do not promise viewport-based impressions. Caller mutation of an input trait or
segment object is not an update API; call identify/setSegments. Snapshot values
are frozen and keep the public FlagValue union rather than deriving an unsound
remote value type from the fallback.

## Reproducible evidence

- `typescript/src/__tests__/flag-observation.test.ts`: stable/deep-frozen values,
  no read exposure, snapshot ownership, delayed commit attribution, subscriber
  cleanup/failure isolation, Svelte SSR and failed initial delivery.
- `service/scripts/verify-frameworks.mjs`: fresh npm tarballs with normal npm
  resolution; vanilla ESM/CJS and Svelte-store imports with React/Svelte absent;
  React 18.3.1 and 19.3.1 ESM/CJS SSR, strict declaration consumption without
  skipLibCheck; actual compiled Svelte 5 SSR and browser component.
- Chrome 154: hydration without mismatch, StrictMode single initial exposure,
  abandoned Suspense render without exposure, actual signed config HTTP refresh,
  local flag/segment updates, identify/reset/A→B→A, bad-signature/304 preservation,
  replacement/unmount, and continued caller-owned transport after unmount.
- HTTP exposure receiver in this script is a fixture. Actual Watch storage,
  authentication, failure/retry and SQLite reopen remain separately covered by
  `verify-exposure-watch.mjs`; no production-host or visibility claim is made.

Current validation also passes all 203 SDK tests, 18 native service tests, nine
admin tests, SDK/service/admin typechecks and the dual-format SDK build. The
existing actual Watch HTTP/SQLite/Chrome acceptance passes with 21 persisted
events after reopen against the merged Watch source. Python source is unchanged
in this browser-framework slice.

Run after building the SDK and existing service/shared dependencies:

```sh
npm run test --workspace userfn/typescript
npm run typecheck --workspace userfn/typescript
npm run build --workspace userfn/typescript
node userfn/service/scripts/verify-frameworks.mjs
```

`USERFN_NPM_CLI`, `USERFN_PLAYWRIGHT_MODULE` and `USERFN_CHROME_PATH` may point to
locally installed executables/modules. Fixtures, browser, servers and fresh
consumer directories are cleaned up. Framework versions are resolved within the
advertised React majors, so the script reports the actual versions used.

Remaining original requirements include durable messaging/surveys, other UI
components/accessibility, consent and DNT policy, bounded offline persistence,
roadmap/changelog and performance/cross-browser acceptance. These helpers do not
close those gates or unspecified targeting operators.
