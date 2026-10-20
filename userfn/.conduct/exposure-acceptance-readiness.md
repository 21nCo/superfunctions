# UserFn exposure boundary acceptance

2026-10-20. `service/scripts/verify-exposure-watch.mjs` exercises the built
TypeScript SDK in Node and actual Chrome, the Python SDK with httpx, the dedicated
UserFn signed-configuration HTTP router, the actual Watch HTTP router, and native
SQLite through the shared Kysely adapter. Both services wrap the incoming adapter
with their schemas internally; the fixture does not supply `adapterSchema`.

## Result

The local acceptance passes with Chrome 154.0.8037.58 and 21 persisted events.
Closing the Watch instance and SQLite connection, constructing new instances from
the same file, and performing an authenticated Watch query preserves all 21
payloads exactly. This is real file-backed close/reopen evidence, not reuse of an
in-memory adapter.

The assertions cover:

- Signed configuration publication and refresh before evaluation in Node, Python
  and Chrome. Equal-valued variations retain the selected variation/rule IDs,
  including production environment overrides. Only the requested flag emits;
  prerequisite evaluation emits no extra event. Default variation, default value
  and unavailable fallback provenance survive the HTTP/database boundary.
- Canonical `track`/`userfn.flag_exposure` envelopes, application/environment and
  identified-user ID. No flag values, private traits, configuration credential or
  Watch credential appear in stored payloads.
- An actual Watch 401 retains the event and never persists an unauthorized write.
  A fixture HTTP 503 retains the original event ID. Renaming the actual SQLite
  events table causes a real storage failure/503; restoring it and explicitly
  retrying stores the retained event once. The expected Watch storage failure is
  also observed through its flush API.
- Node and Python requests to a delayed real HTTP endpoint have a 25 ms configured
  deadline, reject within the one-second acceptance bound, and retain the queue.
  The delayed fixture notices the disconnected response before writing. This
  does not imply that an arbitrary server can undo a request after client timeout.
- Queue capacity one produces an observable drop counter and explicit flush error
  in both SDKs while the retained event is delivered. Concurrent flush calls
  coalesce. Successful close fences later capture, and failed Python close leaves
  retained events and a closed admission state.
- Destroying the connection after Watch commits but before its acknowledgement
  produces two persisted rows with the same stable event ID after explicit retry.
  Ordinary Watch event ingestion is at least once; this check deliberately does
  not claim server-side deduplication or exactly-once delivery.

## Reproduction

Build the UserFn service and SDK plus their shared dependencies and current Watch
core/browser packages first. The script uses the local built Watch core by
normal default. When a scoped install cannot build optional Watch framework
adapters, `USERFN_WATCH_CORE` may point to an artifact built from the identical
merged Watch source. `USERFN_PLAYWRIGHT_MODULE` and `USERFN_CHROME_PATH` allow use
of an already-installed Playwright module and Chrome binary. Python requires the
config/exposures optional dependencies (`cryptography`, `httpx`).

The recorded run used:

```sh
USERFN_PLAYWRIGHT_MODULE=/Volumes/Dev/n/superfunctions/node_modules/playwright/index.mjs \
USERFN_WATCH_CORE=/Volumes/Dev/n/worktrees/superfunctions/watchfn-sf-next-readiness/watchfn/typescript/dist/index.mjs \
node userfn/service/scripts/verify-exposure-watch.mjs
```

The Watch artifact was built at `f41abe310`, already merged into this UserFn
branch. The script creates temporary SQLite/configuration/bundle files and removes
them and closes all servers, databases and the browser on completion. The Python
boundary here executes source through `PYTHONPATH`; fresh wheel and npm package
checks are recorded separately in `flag-exposure-readiness.md`.

## Limits and remaining gates

Authentication for signed configuration uses an explicit trusted fixture subject,
not live AuthFn issuance. Watch authentication is the actual configured API-key
path, but this key also authorizes queries and is not an ingestion-only or
per-tenant credential. Browser deployments require a trusted application proxy or
appropriate isolation when exposing the full Watch key is unsuitable. The app
name is configuration, not a tenant security boundary.

This is local loopback HTTP and native SQLite evidence, not hosted TLS/network,
remote provider, multi-process load, crash/power-loss or deployment validation.
The Chrome scenario is same-origin; it does not establish arbitrary cross-origin
Watch deployment policy. Queues remain bounded and in memory, so process/tab loss
can lose undelivered events. Clients trust a successful HTTP status from the
configured endpoint; they do not verify a durable acknowledgement signature or
accepted-count receipt. Consent/privacy administration, durable offline queues,
load/retention policy and the other original UserFn product requirements remain
open. See `flag-exposure-readiness.md` for the implementation scope.
