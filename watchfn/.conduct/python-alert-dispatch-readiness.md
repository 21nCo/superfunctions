# Python durable alert notification dispatch

The database-backed Python alert manager now has explicit, host-driven dispatch
for its stored webhook and Slack incoming-webhook obligations. It uses the existing
shared adapter, atomic transaction predicate updates and Watch storage owner loop.
There is no new database abstraction or background scheduler.

## Delivery and reconciliation contract

A due job is claimed by revision CAS with a unique token, lease expiry and attempt
increment before I/O. HTTP runs outside database transactions; completion verifies
the same revision/token and an unexpired lease. Success atomically stores a receipt
and decrements the alert's pending count. Routing credentials are removed from the
receipt, while notification context remains. An interrupted local completion keeps
the original lease and pending obligation.

Timeouts, disconnects, unexpected provider responses and expired claims become
`dead/unknown` and are never automatically replayed. The pending count stays
reserved. Definite rejection and exhausted safe retries become `dead/rejected` and
also retain the count. Explicit operator reconciliation (`delivered` or `dismissed`,
with actor and reason) releases it once. A repeated terminal acknowledgement is a
no-op. Provider responses/errors and adapter SQL parameter errors are not returned
or persisted in public status.

Only pre-send connection failures and Slack429 with a valid bounded Retry-After
value can automatically retry. Retry delay respects both exponential backoff and
Slack's header. A stable Idempotency-Key is included, but no provider deduplication
guarantee is assumed. Webhook success is HTTP2xx; Slack success requires HTTP200
and bounded literal `ok`. Slack uses its configured incoming-webhook channel.
TLS verification remains enabled; redirects/environment proxies are disabled.
HTTP response bodies are not used as error messages. Slack responses use bounded
raw bytes without decompression. Calls are cooperatively deadline-bounded; process
suspension, a blocking database adapter, or synchronous runtime work cannot receive
a hard wall-clock guarantee from asyncio cancellation.

The shared `watchfn_alert_runtime` table has one unique namespace owner marker.
Python dispatch/reconciliation requires `python-v1`; TypeScript dispatch/dismissal
requires `ts-v1`. Both fail closed on incompatible/missing schema ownership before
provider sends or counter changes. The first insert atomically establishes ownership;
TypeScript rereads committed ownership after a losing insert. Stop pre-marker
versions before migration: they cannot honor this protocol. Changing/removing the
marker while obligations or receipts remain is unsupported.

## Validation

Owned loopback HTTP endpoints and real file SQLite cover delivery receipt/reopen,
lost response without replay, independent worker claims, expired claims, Slack
Retry-After and exhaustion, timeout privacy, missing-sender no-claim behavior,
shutdown during an active request, cursor traversal, incompatible protocol before
actual HTTP, and successful provider delivery followed by local receipt failure.
TypeScript native SQLite covers foreign-owner rejection and concurrent first-owner
convergence alongside the existing lifecycle/lease suite.

- Focused Python dispatcher: 10 passed (5.12s).
- Focused TypeScript public manager: 24 passed (1.31s runner duration).
- Normal Python CI entrypoint: 148 passed; wheel and source archive built.
- Full TypeScript suite, one worker: 239 passed across25 files; `tsc --noEmit`
  and ESM/CJS/declaration builds passed.
- Fresh five-wheel installed consumer: 148 passed (6.99s), imports confirmed from
  site-packages; the Watch wheel's `dispatch` extra installed its HTTP dependency.
- `git diff --check` passed. Fixtures removed owned servers, database handles and
  temporary installed environments. The source venv was removed after validation.
  No owned runners remain. `.conduct` evidence is tracked; no ignore rules changed.

An earlier concurrent host run had two TypeScript5s fixture timeouts and a Python
50ms timeout before the fixture saw any request. A concrete SQLite first-owner
read-to-write upgrade race was fixed. The final focused run used a quiet serial
window, unchanged production deadlines, and one Vitest worker. The timeout test
now accepts zero or one initial request and verifies no later replay; the separate
shutdown fixture proves interruption after the server has received a request.

## Remaining original requirements and operational limits

- Email/PagerDuty remain pending without claims; no custom sender callback is
  accepted as if it were bounded. Public configured metadata reflects optional
  built-in HTTP-client availability, not verified connectivity.
- Hosts must traverse `nextCursor` and then restart from the beginning on a later
  cycle. Otherwise unavailable channels can occupy the first page indefinitely.
- Terminal receipt retention is unbounded. Per-alert pending capacity is bounded,
  but total historical database size is not. Receipt deletion/alert removal needs
  a separate retention contract; disable alerts meanwhile.
- Credentials before settlement and retained notification context are plaintext
  at rest. Protect database/backups and shared adapter logging.
- Each instance serializes its storage operations through the dispatch page; stop
  prevents subsequent sends and drains the active bounded HTTP operation. Custom
  blocking adapters remain outside that deadline guarantee.
- Transition callbacks, calculated-value notification context, complete provider
  parity and original full readiness remain open. Standalone legacy channel helper
  retry behavior is unchanged and is not this durable protocol. No public HTTP
  alert-management endpoints or tenant filtering are added.
- No external provider sends, deployment or publication were performed.

Provider contracts: [Slack incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks)
and [Slack rate limits / Retry-After](https://docs.slack.dev/apis/web-api/rate-limits/).
