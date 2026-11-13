# catchfn

Console, network and breadcrumb collectors that record what happened in a
browser or Node process as versioned **evidence events**. The collectors run on
their own: no reporter client, widget or server is needed.

```ts
import { BreadcrumbCollector, ConsoleCollector, NetworkCollector, validateEvidenceEvent } from "catchfn";

const consoleCollector = new ConsoleCollector(100); // keeps the newest 100 events
const network = new NetworkCollector(20, { blockUrls: ["/health"] });
const breadcrumbs = new BreadcrumbCollector(50);

consoleCollector.start();
network.start();
breadcrumbs.addNavigation("/cart", "/checkout");

// Later: the last 30 seconds of evidence, oldest first across collectors.
const since = Date.now() - 30_000;
const events = [...consoleCollector.collect({ since }), ...network.collect({ since }), ...breadcrumbs.collect({ since })]
  .sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);

consoleCollector.stop();
network.stop();
```

## Evidence events v1

Every event has `schemaVersion: 1`, a `kind` (`"console"`, `"network"` or
`"breadcrumb"`), a `seq` capture-order number and a `timestamp` in epoch
milliseconds, plus the fields of its kind. The format is closed: extra fields
are invalid. Check an event with `validateEvidenceEvent(event)` (returns a list
of problems, empty when valid) or with any JSON Schema 2020-12 validator and
the exported `evidenceEventSchema`. Integer fields (`seq`, `timestamp`,
`status`) are safe integers in both, and nested records (`data`, header
records, objects in `args`) must be plain or null-prototype objects without a
callable `toJSON`.

| kind | fields |
| --- | --- |
| `console` | `level` (`log`, `info`, `warn`, `error`, `debug`), `args` |
| `network` | `transport` (`fetch`, `xhr`), `method`, `url`, optional `status`, `statusText`, `duration`, `requestHeaders`, `responseHeaders` |
| `breadcrumb` | `type` (`navigation`, `console`, `network`, `user`, `custom`), optional `message`, `data`, `category`, `level` (`debug`, `info`, `warning`, `error`) |

Captured events are frozen.

## Time-window queries

Each collector keeps its events in a fixed-size ring buffer (the constructor's
`maxSize`; `0` keeps nothing) and `collect({ since, until })` returns the
buffered events whose `timestamp` lies in the **inclusive** window, oldest
first. Either bound may be omitted, `since > until` matches nothing, and a
`NaN` or non-number bound throws a `RangeError`.

## Patching and `stop()`

`ConsoleCollector` wraps `console.log/info/warn/error/debug`; `NetworkCollector`
wraps `fetch` and `XMLHttpRequest.prototype.open/send`. Overlapping collectors
share one set of wrappers. `stop()` on the last running collector restores
exactly the functions that were replaced, but only where its own wrapper is
still installed: if another library wrapped them after `start()`, the catchfn
wrapper stays in that chain, passes calls through and records nothing.

The network collector never changes the application's request: the original
arguments pass through untouched (a `null` or `undefined` receiver of `fetch`
becomes `globalThis`), and observation never runs the application's
iterators, getters or conversions. The page's `fetch` and
`XMLHttpRequest.prototype.open` run first. Before they run, observation reads
only a string URL argument; it reads a `URL`, `Request`, `init` or headers
argument only after the call returns. `send` reads nothing from its arguments.
A native `fetch`, or a wrapper that calls one synchronously, has read the
request by then. Platform objects are read through the `URL`, `Request`,
`Response`, `Headers`, `XMLHttpRequest` and `EventTarget` getters and methods
captured when catchfn loads, so a getter or method that the page patches later
never runs. A `URL` argument whose string conversion runs application code
(an own or patched `toString`, or a `Symbol.toPrimitive`) is recorded as
`[UNREAD_URL]`, because the call may have changed it.

Known limit, deferred to SFNS-60 (SFNS-56 owner scope amendment of
2026-11-13): no script can tell a Proxy apart, so a stateful Proxy `init` or
headers object can observe the reads made after the call. Attribution can be
wrong after the input is consumed through a `fetch` installed before `start()`
that defers the native call, or through a reused `init` or `Request`,
including values an earlier wrapper changed.

`fetch` returns what the page's `fetch` returned. When the page's own `then`
returns another thenable, `fetch` returns that chained promise. It settles
with the same response or rejection reason, so an unhandled rejection stays
unhandled. Otherwise the page's value comes back unchanged, and observing it
never raises. This covers a value that is not a thenable, and a `then` that
cannot be read or called or that returns no other thenable. A stopped wrapper
reads nothing at all. What observation then records:

- Request headers are captured only from a platform `Headers` object (not a
  subclass), a plain array of `[name, value]` string pairs or a plain record of
  string data properties. Any other form (a generator, `Map.entries()`, an
  accessor, a custom iterator, a non-string value, more than 200 pairs) is
  not read and the request is recorded without `requestHeaders`.
- `init.method` and `init.headers` are read only from own data properties.
- The URL is read from a string, a platform `URL` or a platform `Request`;
  any other input is recorded as `"[UNREAD_URL]"` (`UNREAD_URL`), and a method
  that is not a string as `"[UNREAD_METHOD]"` (`UNREAD_METHOD`).

The captured URL goes through `redactUrl` and the captured headers through
`redactHeaders`.

## Serialization

Captured values are snapshotted under a closed set of forms:

- JSON primitives (strings, finite numbers, booleans, `null`) are kept;
- `Error` becomes `{ name, message, stack, ...own properties }`;
- plain objects and arrays are copied at most 5 container levels deep (deeper
  containers become `"[Max Depth]"`) with at most 200 keys or items each,
  a truncation marker included;
- a container that refers back to one of its ancestors becomes `"[Circular]"`;
- DOM nodes become `"<tag#id.class>"`;
- everything else becomes `String(value)`, or `"[Unserializable]"` when that
  conversion throws.

One entry is at most 10 KB of UTF-8 JSON; strings are cut and containers stop
early with a `"[Truncated]"` marker (the last array item, or a record key
whose value counts the omitted keys; `"[Truncated 2]"`, ... when the record
already holds that key). A console event's argument list is one
entry, and each argument counts its depth from 1. A breadcrumb's `data` and
`message`, and a network event's `url` and each header record, are entries.

## Redaction

- `redactUrl(url)` removes authority credentials, replaces sensitive query
  values (`token`, `key`, `secret`, `password`, `api_key`, `access_token`,
  `auth`, case-insensitive) with `[REDACTED]`, redacts a fragment that names a
  token, secret, password or API key, keeps relative URLs relative and returns
  `[REDACTED_URL]` for a URL it cannot parse.
- `redactHeaders(headers)` redacts `authorization`, `cookie`, `set-cookie`,
  `x-api-key`, `x-auth-token` and `x-access-token`, case-insensitive.
- `redactObject(value)` snapshots a value and redacts keys that name secrets,
  plus URLs under `url`/`href` keys; the redacted result keeps the 10 KB bound.
- `redactString(text)` masks card numbers.
