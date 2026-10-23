# Durable campaign admission and reconciliation

This checkpoint addresses `.conduct/spec.md` lines 65–69: per-user/per-session campaign caps and persisted client delivery state reconciled with a service. It does not implement organization-wide distributed quotas, time-window/cooldown policy, campaign CRUD, offline display, or the separate submission rate-limit requirements.

## Authority and accounting

The service wraps its database adapter with `getUserFnSchema()` internally. Apply the added `userfn_message_counters` and `userfn_message_receipts` schema before enabling messaging. Transactions are mandatory. A host `messaging.resolvePolicy(authSession, campaignId)` supplies enabled/perUser/perSession limits; client campaign metadata never authorizes a delivery. The verified tenant and user actor identify a user. API-key/service actors cannot impersonate users through SDK `identify` or request bodies. A host `resolveSession(authSession)` supplies the verified application session: shared auth's `id` is not assumed to be a browser session ID.

`POST /messages/:campaignId/reserve` and `/shown` require bearer scope `userfn:messages:write`, an empty JSON object and a stable `Idempotency-Key`. Reservations atomically update user/session counters and insert an identity-bound receipt. Conditional counter updates and unique receipt IDs handle concurrent service instances. A replay returns the same committed receipt; another campaign/session under the same key returns409. Explicit zero denies; omitted limits are uncapped (counter storage is bounded by safe integer precision). Counters include admissions made while limits were omitted so later limits do not erase history. Disabled/missing campaigns deny new admissions; disabling also prevents a pending admitted receipt from authorizing a later render.

Capacity is consumed before presentation. Unknown presentation, consent withdrawal after admission, failed rendering and lost clients do not refund it. This can underdeliver but prevents uncertainty from admitting extra messages. `shown` confirms an already reserved display without consuming capacity again. Receipts and lifetime counters have no automatic expiry: deleting them resets protection and requires a host retention/migration decision.

## Client lifecycle and migration

TypeScript `trigger` now returns `Promise<void>`; applications should `await client.trigger(...)` and handle failure. Configure `messaging: { storageKey: 'stable-authenticated-session' }` with the existing service endpoint and bearer credential. Browser storage defaults to localStorage; a custom `MessageStorage` is available for controlled runtimes. Use a distinct stable namespace for each authenticated application session/user. The journal contains local identity and opaque receipt keys, not bearer credentials. Browser delivery requires Web Locks to serialize tabs sharing that journal; unavailable locks/storage fail closed. Non-browser custom storage is serialized within a client; hosts must serialize clients sharing it.

Existing trigger flow performs durable admission whenever configured. Campaigns declaring caps fail closed without durable configuration rather than advertising instance-local caps as durable. The old `caps.global`/Python `global_cap` field remains a deprecated local-engine compatibility field; migrate service policy to explicit `perUser`/`perSession` and SDK metadata to `perUser`/`session` (Python `per_user`/`session_cap`). No tenant-wide interpretation is invented. Service policy is the enforcement source and must be configured for every campaign.

The journal saves `pending` before HTTP, `presenting` before UI handoff, and `shown` before confirmation. Lost admission ACKs replay the same key after reload. A `presenting` entry reports `uncertain` and is never redisplayed automatically; an application must investigate it rather than silently deleting/retrying it. A `shown` entry retries confirmation on a later trigger without redisplay. `getMessageDeliveryStatus()` exposes this state. Journals are bounded to100 campaigns/64KiB; unavailable/full/corrupt storage fails closed. Identity changes and consent withdrawal/regrant fence pending rendering. Existing unsupported banner/tooltip rendering remains outside this checkpoint; it does not receive a false shown confirmation.

Python's existing synchronous `trigger` now reserves before returning the highest-priority campaign when configured with `messaging_state_path`. The host owns a private path per authenticated session/user. Atomic mode0600 writes, fsync and POSIX file locking coordinate processes. Call `confirm_message_shown(campaign.id)` only after actual presentation. `get_message_delivery_status()` exposes pending/uncertain/shown reconciliation. A restarted client never hands off an uncertain campaign twice. Socket timeouts bound individual network operations; a total slow-stream deadline remains open. POSIX locking is required for this private file implementation.

## Evidence

Final local runs after the admission and transport follow-ups: 219 SDK tests, 185 Python tests, and 29 service/native tests pass. SDK/admin/service TypeScript checks and SDK/service builds pass. The built Chrome/Python acceptance reports all three browser reload, native SQLite and Python reconciliation checks passed.

- Native HTTP test uses two independent SQLite connections and service instances, racing distinct and duplicate keys; checks user/session/tenant isolation, stable replay, conflict denial, explicit zero/disabled/missing policy, oversized/spoofed requests, shown confirmation and SQLite close/reopen.
- Actual Chrome test drops an admission ACK after the SQLite commit, reloads the page, verifies exact-key replay and one modal, then reloads again and observes the durable cap. Python clients exercise private journal restart, no repeated handoff, shown confirmation and cap enforcement against that same real service.
- SDK regression tests cover malformed receipt denial, missing durable configuration, persisted pending/shown replay, uncertain presentation and consent withdrawal/regrant during admission.

Local validation commands: SDK Vitest and TypeScript; service typecheck/build and `test:native`; Python pytest with the existing config/exposure optional dependencies; built `scripts/verify-messaging-browser.mjs` with the installed Playwright module and real Chrome. These are local receipts, not provider or deployment evidence. The unrelated AuthFn acceptance suite requires the unavailable `@superfunctions/oauth-storage` package in this sparse checkout and is reported separately.

## Admission selection and reconciliation follow-up — 2026-10-22

A service-denied high-priority campaign now allows the SDK to consider the next
eligible campaign. Previously durable mode skipped local cap filtering but only
attempted the first candidate, so a permanently capped or disabled campaign
starved lower-priority messages. Both SDKs distinguish explicit denial from a
pending, uncertain, or previously shown receipt. Uncertain presentation still
stops the trigger and is never automatically retried. Transport errors also stop
selection rather than treating unknown admission as denial. Consent and identity
are checked again between candidates and before any survey fallback.

Both SDKs recheck consent/identity after persisting the presentation fence and
before render/handoff. Python file persistence can release the GIL; a concurrent
identity change during that operation must not hand the old user's message to
the host. Custom browser storage can also invoke application callbacks while
saving. If authority changes during this save, the consumed reservation remains
uncertain and no presentation occurs; there is no unsafe refund.

Existing shown receipts can be confirmed after the host removes a campaign's
policy. Only reservation requires the current campaign policy. Confirmation still
requires the verified user, session, matching campaign/key, and an existing
receipt, and never creates a reservation or consumes more capacity. Removed
campaigns continue to deny all reserve requests.

Regression evidence includes failures before these changes for both SDK priority
selection, both post-save presentation gates, and native HTTP/SQLite confirmation
after policy removal. The full suites and SDK/service typechecks and builds pass.
The built real Chrome reload, SQLite, and Python restart fixture also passes.
Logs are `/tmp/userfn-inspect-sdk-tests.log`, `/tmp/userfn-inspect-python-tests.log`,
`/tmp/userfn-inspect-native-final.log`, `/tmp/userfn-inspect-service-tests.log`,
and `/tmp/userfn-inspect-browser.log`. Native service validation uses Node20.20.0,
matching this checkout's existing SQLite binding. No dependencies were changed.
These remain local checkpoint guarantees, with the original open requirements
and deployment gates above unchanged.

## Messaging bearer transport

Both SDKs require HTTPS before initializing durable messaging. Plaintext HTTP is
rejected by default before any bearer request. An explicit local-test-only option
is available: TypeScript `messaging.allowInsecureHttp: true`, or Python
`messaging_allow_insecure_http=True`. This follows signed-config transport policy
without changing feedback or exposure transport configuration. The native browser
and Python fixture explicitly opts into its owned loopback HTTP server.

The TypeScript regression failed before the change because an HTTP constructor
accepted the bearer credential. Final validation includes 219 SDK tests, 185 Python
tests, SDK typecheck/build, and the built Chrome/SQLite/Python restart fixture with
its explicit local opt-in. Logs: `/tmp/userfn-https-sdk-tests.log`,
`/tmp/userfn-https-python-tests.log`, `/tmp/userfn-https-sdk-types.log`,
`/tmp/userfn-https-sdk-build.log`, and `/tmp/userfn-https-browser.log`.

## Python development check prerequisite

The normal `.[dev]` extra now includes the existing HTTP/config feature test
libraries (`httpx` and `cryptography`, using the same constraints as their feature
extras). Runtime dependencies remain unchanged. The durable trigger explicitly
narrows an absent local identity before reading its ID. An isolated Python3.10
installation of this checkout's `.[dev]` passes `python -m mypy .` across32 source
files and all185 tests, without suppressing missing imports or changing checker
settings. Receipts: `/tmp/user-merge-dev-mypy.log`, `/tmp/user-merge-python.log`.

## Shared/Watch prerequisite integration — 2026-10-22 evening

Ordinary merges preserve the User implementation while incorporating Watch's
public alert manager and Shared prerequisites through `c0ce24b30`. Normal scoped
npm11 lock regeneration adds only the SDK's nested React18 development types,
required alongside Shared's root React19 tools. Scoped `npm ci --dry-run` passes
without peer bypass flags. Existing installed native bindings were preserved;
this is a resolution check, not a fresh whole-worktree installation.

Post-merge validation passes219 SDK tests,19 native service tests,10 service unit
tests,185 Python tests, SDK/service types/builds and the normal Python development
mypy check. Fresh packed consumers pass real Chrome hydration/SSR with React18.3.1
and19.3.1 plus compiled Svelte, strict declarations, identity changes and signed
refresh. Existing sparse node_modules remain distinct from the new root React19
lock graph; the fresh consumer matrix supplies runtime compatibility evidence.
Receipts: `/tmp/user-merge-*.log`. Original feature/deployment gaps remain open.


The later [campaign timing checkpoint](./campaign-timing-readiness.md) adds
authoritative campaign start/end schedules and reservation-based cooldowns.
The earlier time-policy exclusion describes the original cap checkpoint; survey
per-time-window caps remain a separate original requirement.
