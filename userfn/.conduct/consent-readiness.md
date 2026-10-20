# Consent boundaries for analytics and messaging

Authority: original `spec.md` privacy requirement to honor do-not-track and
application consent before analytics/messaging. This checkpoint adds runtime
policy, not consent collection, legal interpretation, remote erasure or a claim
that other original privacy requirements are complete.

## Policy and compatibility

TS `consent: {analytics?, messaging?}` and Python `ConsentOptions` preserve enabled
behavior when a category is omitted. Explicit false denies; patches validate all
fields before changing state. Forwarded `doNotTrack`/`do_not_track` true vetoes
both categories. TS additionally checks live navigator/window DNT values `1` and
`yes`. Application grants cannot override that browser signal. DNT is observed
at API, send and interaction boundaries, not continuously or retroactively.
Identity reset preserves policy. Python reads no implicit request globals.

Flags continue evaluating synchronously, signed config remains available, and
explicit feedback remains an application action. Exposure denial does not enqueue
or increment overflow counters. React/Svelte selections carry the consent epoch
from their evaluation: delayed effects cannot emit an old selection after
withdrawal/regrant. No old selection is replayed just because consent is granted.

## Delivery and UI lifecycle

The ordinary Watch merge `0526b7b6234ae79371a5fe9c3df45db839ab1bcf` supplies
`BrowserClient.discardPending` and discarded-count/error contracts. UserFn reuses
that transport, checks consent before serialization and before actual sends,
and generation-fences stale completion/error updates. Revocation also invalidates
an admission in progress even when the current queue is empty. Python owns its
HTTP queue and cancellation task; generation checks cover entry, network return,
context exit and flush completion, including cancellation-ignoring providers.
A per-drain withdrawal signal rejects old flush callers promptly even when a
provider suppresses task cancellation; the old task remains observed and cannot
mutate the new queue. Tests assert rejection before releasing the ignored request.

Queued/in-flight-owned entries are discarded and counted. An old pending flush
reports withdrawal; later empty flush succeeds. New events after regrant use a
new queue; stale acknowledgements cannot remove them. No remote retraction is
claimed: actual acceptance demonstrates a handed-off request can still persist
at Watch after local abort. Already acknowledged events are not erased.

Messaging checks run before campaign/survey eligibility and again at callbacks.
The renderer owns a set of active message/survey roots and their timers; revocation
removes only those elements. Detached old buttons cannot navigate, dismiss or
advance a survey after regrant. Explicit feedback forms and other client instances
are retained. Existing analytics/render logging placeholders are gated, not
converted into completed analytics or widget implementations.

## Evidence

- Dedicated TS/Python consent tests: independent categories, default/forwarded/live
  DNT, validation atomicity, reset, discarded vs dropped, regrant, stale framework
  selections, serialization reentrancy, and cancellation-ignoring async provider
  context entry/exit and network return.
- `service/scripts/verify-consent-watch.mjs`: built SDK + actual Watch authenticated
  HTTP + SQLite, Python real HTTP subprocess and Chrome154. Confirms unsent and
  failed retained events never reach storage after revocation/regrant; separately
  confirms the possible persistence of a request already handed off. Exercises
  owned modal/survey teardown, detached callbacks, another client's UI, explicit
  feedback form retention and live browser DNT before a scheduled send.
- Existing framework packed acceptance also consumes the new policy types and
  confirms SSR denial preserves flag values without exposure delivery.

Final validation: 210 TypeScript SDK tests, 182 Python tests on source Python3.9
and a fresh installed Python3.12 wheel, 18 native service tests, SDK/service/admin
typechecks, shared eight checks, dual-format build, fresh React18/19 package
SSR/hydration and compiled Svelte acceptance. Actual Watch exposure/reopen and
renderer adversarial-browser regressions also pass.

Run after building the Watch browser package, User SDK and existing Watch core:

```sh
npm run build --workspace @watchfn/browser
npm run test --workspace userfn/typescript
npm run typecheck --workspace userfn/typescript
npm run build --workspace userfn/typescript
PYTHONPATH=userfn/python/src python3 -m pytest userfn/python/tests -q
node userfn/service/scripts/verify-consent-watch.mjs
```

The script supports `USERFN_WATCH_CORE`, `USERFN_PLAYWRIGHT_MODULE`,
`USERFN_CHROME_PATH` and `USERFN_PYTHON` local overrides. It cleans browsers,
servers and SQLite fixtures. Consent collection/persistence remains application-owned.
Original requirements still open include full redaction/allowlists, per-user/per-tenant
quotas, moderation, durable messaging/surveys, other UI components/accessibility
and the remaining product milestones.
