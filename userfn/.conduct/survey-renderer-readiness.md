# Survey renderer acknowledgement checkpoint — 2026-10-23

The existing renderer discarded its final question and consumed a local count
without service submission. Endpoint-configured rendering now waits for the
verified durable survey receipt. While pending, controls are disabled and a
status region says the response is being submitted. Success says `Response saved`
only after acknowledgement. Failure retains the UI and offers an explicit retry
without a success claim. No-endpoint compatibility mode says `Response recorded
locally`; even an empty survey now requires an explicit Submit click.

The renderer uses a separate HTTP-service instance capped at one request attempt
per click, with the configured timeout. Direct SDK submission retains its
configured automatic retry policy. Thus a renderer identity/consent transition
cannot leave an automatic retry loop sending later requests. An already-started
request can still commit; withdrawal/dismissal cannot undo it.

One immutable JSON answer payload/key is retained per local identity and survey
within the client. Dismiss/reopen uses the original answers and key, including
after unknown outcomes. Concurrent callbacks share the pending operation and
record one acknowledged local response. The bounded map holds at most100 entries;
new submissions fail before sending when full, and no uncertain entry is evicted
to allocate a new key. Successful reconciliation removes the entry. The retained
payload is bounded to64KiB, and raw server/network exception text is not shown.

Identity/reset changes dismiss survey nodes and invalidate presentation callbacks;
consent transitions retain the existing messaging epoch fence. A late receipt is
retained for the original owner but cannot update a stale or different user's UI.
Returning to that owner and explicitly retrying can reconcile the stored receipt
without another request. Transport credentials are captured on construction;
local identify does not change authenticated server identity. Create a new client
for different server credentials. This does not migrate an uncertain attempt
across credentials or claim reload recovery.

Question handling now agrees with the implemented service for CSAT defaults1–5,
NPS0–10, scalar choice values, required text, and omitted optional unanswered
questions. Extremely large or invalid scale ranges fail closed instead of
creating an unbounded button loop. Branching and richer templates remain open.

## Validation

- All234 TypeScript SDK tests pass, including existing consent, survey cap and
  transport cases. New tests prove immutable same-key reopen, single concurrent
  acknowledgement, identity/consent fences with late receipt reconciliation,
  the100-entry fail-closed limit and local mode without HTTP.
- Full TypeScript SDK typecheck and CJS/ESM/declarations build pass.
- `typescript/scripts/verify-survey-renderer.mjs` uses actual Chrome154.0.8037.58,
  the built SDK/service and an owned SQLite database. It drops the first response
  after commit, checks error UI and identical-key retry with one persisted row,
  confirms boolean choice/CSAT handling, prevents duplicate-click requests,
  withdraws consent/changes identity during a delayed acknowledgement, and proves
  no stale UI resurrection. Original-owner reconciliation does not resend a known
  receipt. After reload the authoritative service still rejects another response
  at its configured cap. Local empty-survey mode requires a click and reports only
  local recording. No Python runtime source changed.

Receipt:
`{"passed":true,"browser":"154.0.8037.58","lostAckSameKey":true,"persistedResponses":2,"epochFences":true,"typedChoicesAndCsat":true,"explicitLocalMode":true,"reloadJournal":false}`

Commands from the repository root:

```sh
npm --prefix userfn/typescript test
npm --prefix userfn/typescript run typecheck
npm --prefix userfn/typescript run build
USERFN_PLAYWRIGHT_MODULE=/path/to/playwright node userfn/typescript/scripts/verify-survey-renderer.mjs
```

Logs: `/tmp/user-survey-renderer-{tests,types,build,native}.log`. Browser context,
HTTP server, SQLite connection and temporary database/bundle directory are closed
and removed by the fixture. No deployment, push or external provider delivery.

## Remaining original scope

This is durable service acknowledgement with in-memory renderer reconciliation,
not full durable UI readiness. Reload/tab close/client replacement loses pending
keys and answers; a persistent, identity-owned answer journal and offline recovery
remain necessary for that guarantee. The renderer tells users to keep the page
open when acknowledgement is unknown. Server caps remain authoritative but cannot
replace a lost idempotency key for every multi-response policy. Display admission,
per-tenant submission limits, Python survey engine, WatchFn outbox/analytics,
branching/templates and broader original readiness remain open.

## Browser UUID capability follow-up

Survey attempts and durable campaign reservations now use the existing uuid v4
implementation instead of requiring crypto.randomUUID. Browser builds retain
cryptographic getRandomValues entropy; no Math.random fallback is introduced.
The immutable key/retry and journal semantics remain unchanged.

Validation:18 focused SDK tests, strict SDK types and CJS/ESM/declaration build
pass. Actual Chrome154.0.8037.58 acceptance disables crypto.randomUUID before
loading the built browser bundle while preserving getRandomValues. Survey
submission/lost-ack retry, original-owner reconciliation and native SQLite caps
pass, and a locally intercepted campaign reservation carries a valid UUIDv4.
The first test command selected sibling workspaces and admin had no matching
tests; the successful command uses the exact ./userfn/typescript workspace.
Logs: /tmp/user-uuid-tests.log, /tmp/user-uuid-types.log,
/tmp/user-uuid-build.log and /tmp/user-uuid-native.log. The owned browser,
localhost server and temporary SQLite directory were closed/removed. This does
not add reload-safe survey journaling or certify additional browser versions.
