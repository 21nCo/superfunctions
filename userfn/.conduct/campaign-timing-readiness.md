# Durable campaign schedule and cooldown checkpoint — 2026-10-23

Original `.conduct/spec.md` line65 requires campaign start/end schedules and
cooldowns alongside per-user/per-session caps. Line74's per-time-window cap is a
survey requirement and remains open. This checkpoint does not redefine campaign
lifetime caps as rolling quotas or complete UserFn production readiness.

## Contract and authority

Service `MessagingPolicy` and TypeScript `Campaign` now accept optional
`schedule: {startAt?, endAt?}` and `cooldownMs`. Python exposes
`CampaignSchedule(start_at?, end_at?)` and `Campaign.cooldown_ms`. UTC epoch
milliseconds match existing delivery timestamp and refresh status conventions.
Start is inclusive; end is exclusive. Omitted boundaries are open. Times and
cooldowns must be nonnegative integers within the JavaScript Date range;
start must precede end. Cooldown zero is explicit no-delay behavior.

The service's verified tenant/user/campaign identity owns cooldown across
sessions. Its trusted policy remains authoritative; SDK metadata does not
increase permission. Admission consumes cooldown and lifetime/session capacity
in the same transaction. Confirmation does not consume again, move the cooldown
start, or refund uncertain/failed rendering. Counter and timing CAS plus unique
receipt insertion serialize independent service instances. Backward server time
relative to the last reservation denies new admissions.

New timing tables preserve the original receipt's end bound. Replaying an
admitted key checks the current schedule and original expiry without consuming
again. Extending the campaign cannot revive an expired key. Denied keys remain
denied; clients create fresh keys on a later trigger. `shown` continues to
reconcile an existing side effect after expiry, disablement or retirement.

Both SDKs require durable configuration for temporal campaigns. The service
returns `expiresAt`, and the SDK checks it after admission and again after writing
its durable presentation fence, before rendering/handoff. Temporal metadata
requires an expiry-bearing response; missing expiry leaves the pending journal
recoverable. Existing uncertain presentation and consent/identity fences remain.
Durable clients do not locally filter away expired campaigns before reconciling
pending or shown journal entries.

## Migration and boundaries

Apply `userfn_message_timing` and `userfn_message_receipt_timing` from
`getUserFnSchema()` before enabling this service version. Existing tables need no
column changes; lifetime counters/receipts are retained. All new admissions save
timing even when the policy omits cooldown, supporting later policy changes.
Historical counters without timestamps conservatively start a full cooldown on
the first cooldown request and deny that request. Old receipts without timing
cannot re-authorize a temporal campaign, but their shown acknowledgement remains
valid. No timing rows or receipts are automatically deleted or refunded.

All service instances and SDK hosts need synchronized trusted wall clocks.
Admission and immediate presentation/handoff are guarded; this does not cancel
already visible UI or control a Python host that delays presentation after the
SDK returns. Campaign CRUD/bootstrap, richer triggers, dismissal behavior,
offline delivery, survey window caps and the broader original readiness scope
remain unfinished.

## Validation

- SDK: **222 tests passed**; SDK/service TypeScript checks passed.
- Python: **188 tests passed**, normal development `mypy .` passed32 source files
  in `/tmp/user-temporal-venv` (Python3.12.12, normal editable `.[dev]` install).
- Service: **10 unit +20 native tests passed**.
- SDK and service builds passed.
- Focused native HTTP/SQLite fixture uses two independent database connections
  and services, actual concurrent requests, exact start/cooldown/end boundaries,
  separate users/sessions, shown confirmation without cooldown extension,
  close/reopen, clock regression, original-expiry replay under widened policy,
  and historical timing migration. Existing cap receipt/race coverage remains.
- Built SDK in real installed Chrome plus Python3.10 against the real owned
  HTTP/SQLite service passed stable dropped-ACK replay, reload/restart fencing,
  and new cooldown-after-confirmation checks in both languages. Command:
  `USERFN_PLAYWRIGHT_MODULE=/Volumes/Dev/n/worktrees/superfunctions/browsefn-sf-next-readiness/node_modules/playwright/index.mjs node userfn/service/scripts/verify-messaging-browser.mjs`.
  The explicit existing Playwright module was necessary because this worktree
  does not install Playwright locally; no dependency metadata changed.
- `git diff --check` passed. Fixtures clean up Chrome, HTTP listeners, SQLite
  connections and temporary journals/databases in `finally` blocks.

Receipts: `/tmp/user-temporal-{sdk,types,python,mypy,native-all,service-unit,sdk-build,service-build,browser}.log`.
No external provider sends, deployment, release, base merge or push occurred.
