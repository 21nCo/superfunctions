# WatchFn Python

The Python HTTP routes reuse the shared `superfunctions.http` and
`superfunctions.auth` contracts. Install `watchfn[fastapi]` or `watchfn[flask]`
and pass a WatchFn instance to the corresponding adapter factory. Start the
instance before ingestion and stop it during application shutdown.

```python
from watchfn import WatchFn
from watchfn.adapters.fastapi import create_fastapi_router

watch = WatchFn("application", auth={"provider": server_auth_provider})
app.include_router(create_fastapi_router(watch, prefix="/watch"))
```

`server_auth_provider` implements the shared asynchronous `AuthProvider` and
returns an `AuthSession` or `None`. Providers should treat HTTP header names
case-insensitively because adapter header dictionaries preserve different casing.
The provider owns authentication deadlines, revocation, rotation and credential
verification. WatchFn validates the shared session and checks exact scopes:

- `watchfn:ingest` permits POST `/ingest`.
- `watchfn:query` permits POST `/query`.

Authentication runs before WatchFn reads the body. Absent/malformed/expired
sessions return401, missing scopes return403, and provider exceptions return a
sanitized503. Expiry must be timezone-aware. Wildcards do not grant authority.
A provider takes precedence over any legacy `apiKey`; there is no fallback.
Legacy `auth={"apiKey": "server-secret"}` grants both operations and must stay
server-side. `api_key` is also accepted. Empty keys, unknown auth fields,
malformed providers, configured credentials with `enabled=False`, and
`enabled=True` without credentials reject construction. Omitting auth retains
unauthenticated compatibility. GET `/health` remains public.

These scopes do not filter tenant/app data or enforce session `resource_ids`.
A query-scoped principal can read all retained events in this WatchFn instance.
Use trusted storage separation for mutually untrusted tenants. Programmatic
calls remain trusted host APIs.

## Implemented storage and payload contract

HTTP storage currently supports `storage="memory"` only. POST `/ingest` accepts
one event, a list, or `{"events": [...]}` with1–500 events. Each event has a
nonblank `name`, optional object `properties` and `context`, and optional
`type="track"`. Unsupported fields/types reject the entire batch before writes.
The request limit is8MiB and each JSON event limit is64KiB. HTTP202 with
`{"accepted": count}` means the batch has been added to the bounded memory store;
it does not mean durable persistence. A stopped instance or storage error returns
503. The default memory store retains the latest1000 events, including events
from programmatic collectors; older events may be evicted immediately as new
batches arrive. Memory admission is serialized with background batch writes.

POST `/query` accepts `{}`, or `{"metric": "event.name", "limit": 100}`. `metric`
filters the exact event name and `limit` selects the latest matching events
(1–1000, default1000) in insertion order. Query flushes the existing synchronous
batcher before taking a protected snapshot. The response is `{"results": [...]}`
with JSON timestamps. Request bodies are limited to64KiB; results exceeding8MiB
fail with503 instead of returning partial data. Unsupported query fields reject
with400. No aggregation, time-range query or TS QueryEngine parity is claimed.

The shared Request protocol exposes buffered `body()`, not a streaming iterator.
Declared length is checked before reading and actual bytes before JSON parsing,
but the host/proxy must enforce transport memory and request-time limits. WatchFn
also does not bound time spent in a custom auth provider or a blocked batch flush.

Database HTTP operations explicitly return503 because the existing Python
database implementation is incomplete. Schema-backed asynchronous database
storage, database querying, issue status/bug-report integration, alert lifecycle,
tenant filtering and broader TypeScript parity remain required follow-up work.
No HTTP success is synthesized for those unsupported paths.

## Validation

Run the normal repository Python CI entrypoint:
`node scripts/ci-run-python-package.mjs watchfn/python`.
With `uv` installed, `python watchfn/python/scripts/verify-http-wheel.py` builds
four local wheels, installs them in an isolated environment and runs tests through
the actual shared FastAPI and Flask adapters. It removes the temporary consumer
and uses no external service. The tests exercise framework HTTP stacks in-process;
they do not certify a deployed server or proxy's transport limits.
