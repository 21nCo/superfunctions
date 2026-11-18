# catchfn

Console, network, breadcrumb, error and WebSocket collectors that record what happened in a
browser or Node process as versioned **evidence events**. The collectors run on
their own: no reporter client, widget or server is needed.

```ts
import { BreadcrumbCollector, ConsoleCollector, ErrorCollector, NetworkCollector, WebSocketCollector, validateEvidenceEvent } from "catchfn";

const consoleCollector = new ConsoleCollector(100); // keeps the newest 100 events
const network = new NetworkCollector(20, { blockUrls: ["/health"] });
const breadcrumbs = new BreadcrumbCollector(50);
const errors = new ErrorCollector(50);
const sockets = new WebSocketCollector(100);

consoleCollector.start();
network.start();
errors.start();
sockets.start();
breadcrumbs.addNavigation("/cart", "/checkout");

// Later: the last 30 seconds of evidence, oldest first across collectors.
const since = Date.now() - 30_000;
const events = [consoleCollector, network, breadcrumbs, errors, sockets]
  .flatMap((collector) => collector.collect({ since }))
  .sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);

consoleCollector.stop();
network.stop();
errors.stop();
sockets.stop();
```

## Evidence events v1

Every event has `schemaVersion: 1`, a `kind` (`"console"`, `"network"`,
`"breadcrumb"`, `"error"` or `"websocket"`), a `seq` capture-order number and a `timestamp` in epoch
milliseconds, plus the fields of its kind. The format is closed: extra fields
are invalid. Check an event with `validateEvidenceEvent(event)` (returns a list
of problems, empty when valid) or with any JSON Schema 2020-12 validator and
the exported `evidenceEventSchema`. Integer fields (`seq`, `timestamp`,
`status`, `lineno`, `colno`, `size`, `code`) are safe integers in both, and nested records (`data`, header
records, objects in `args`) must be plain or null-prototype objects without a
callable `toJSON`.

| kind | fields |
| --- | --- |
| `console` | `level` (`log`, `info`, `warn`, `error`, `debug`), `args` |
| `network` | `transport` (`fetch`, `xhr`), `method`, `url`, optional `status`, `statusText`, `duration`, `requestHeaders`, `responseHeaders` |
| `breadcrumb` | `type` (`navigation`, `console`, `network`, `user`, `custom`), optional `message`, `data`, `category`, `level` (`debug`, `info`, `warning`, `error`) |
| `error` | `source` (`error`, `unhandledrejection`), `message`, optional `name`, `stack`, `filename`, `lineno`, `colno`, `value` |
| `websocket` | `type` (`open`, `message`, `close`, `error`), `url`, optional `direction` (`sent`, `received`) and `size` (messages), `code` and `wasClean` (close) |

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
iterators, getters or conversions (except the fulfilled value's `then` read
described below). The page's `fetch` and
`XMLHttpRequest.prototype.open` run first. Before they run, observation reads
only a string URL argument, or a platform `URL` argument through the `href`
getter captured when catchfn loads. The `URL` is read only where that
getter's brand check runs no Proxy trap, which a probe checks at load.
Browsers and current Node check an internal slot, which runs none. On Node
18.17 the brand check runs a trap, so there a `URL` argument is recorded as
`[UNREAD_URL]`. A `Request`, `init` or headers
argument is read only after the call returns, and `send` reads nothing from
its arguments. A native `fetch`, or a wrapper that calls one synchronously,
has read the request by then. The application's own arguments and results
are read through the `URL`, `Request`, `Response`, `Headers`, `Promise`,
`XMLHttpRequest` and `EventTarget` getters and methods captured at load, so a
patch the page makes to those later never runs on them. Two exceptions:

- An `XMLHttpRequest` defined or replaced after catchfn loads has its getters
  captured when `start()` installs the wrappers.
- Redacting the captured URL string after the call uses the live `URL` and
  `URLSearchParams` API (see Redaction), so a page that patches it can run
  code at that point.

Known limit, deferred to SFNS-60 (SFNS-56 owner scope amendment of
2026-11-13): no script can tell a Proxy apart, so a stateful Proxy `init` or
headers object can observe the reads made after the call. Attribution can be
wrong after the input is consumed through a `fetch` installed before `start()`
that defers the native call, or through a reused `init` or `Request`,
including values an earlier wrapper changed.

When the page's `fetch` returns a plain platform `Promise` (not a subclass,
with no own properties, while `Promise.prototype.constructor` and
`Promise[Symbol.species]` are still the platform's), `fetch` returns a
promise derived from it through the `Promise.prototype.then` captured at load
(SFNS-56 owner amendment of 2026-11-14). It settles with the same value or
reason one microtask later and carries the application's rejection handling:
a rejection the application leaves unhandled is reported once, with the
original reason, and a handled one is not reported. Observation records
`status`, `statusText`, `duration` and response headers from it and never
raises. Only that promise's identity changes. Two limits follow from deriving
a native promise, and no script can avoid them:

- Resolving the derived promise reads the page value's `then`, as resolving
  any promise does. A platform `Response` has none, unless the page adds one
  (on the response, `Response.prototype` or `Object.prototype`); a callable
  one is then adopted.
- Only handlers on the returned promise count. A rejection handled solely on
  the page's own promise (by a `fetch` wrapper installed before `start()`, or
  on a shared promise) is reported as unhandled if the caller drops the
  returned promise.

Any other result (a custom thenable, a `Promise` subclass, a promise with own
properties, or any promise once the page replaced Promise's `constructor` or
species) is returned unchanged, its `then` is never called by catchfn, and
it is recorded when the call is made, without `status` or `duration`. A
stopped wrapper reads nothing at all. What observation then records:

- `init.headers` is captured only from a platform `Headers` object (not a
  subclass, and only while neither it nor `Headers.prototype` has a replaced
  iterator), a plain array of `[name, value]` string pairs or a plain record
  of string data properties. Any other form (a generator, `Map.entries()`, an
  accessor, a custom iterator, a non-string value, more than 200 pairs) is
  not read and the request is recorded without `requestHeaders`. The headers
  of a `Request` input and of the response are read from the platform's own
  header list, so a replaced `Headers` iterator does not affect them. On a
  runtime whose `Headers.prototype.forEach` runs the iterator (Node 18.17,
  probed at load), no headers are recorded while the iterator is replaced.
- `init.method` and `init.headers` are read only from own data properties.
- The URL is read from a string, a platform `URL` (only where the load-time
  probe found its `href` brand check trap-free) or a platform `Request`;
  any other input is recorded as `"[UNREAD_URL]"` (`UNREAD_URL`), and a method
  that is not a string as `"[UNREAD_METHOD]"` (`UNREAD_METHOD`).

The captured URL goes through `redactUrl` and the captured headers through
`redactHeaders`.

### Errors

`ErrorCollector` adds `error` and `unhandledrejection` listeners to the
global (the window, or a worker's global scope) and removes them on the last
`stop()`; it replaces nothing and never cancels an event, so the page's own
handlers and the browser's console report run as before. Where the global is
not an event target (plain Node) it records nothing. The listeners go on
through the `EventTarget` methods captured at load, or, where the global is
not a platform event target but has its own `addEventListener` (a test
environment such as Vitest's jsdom, which copies a window's members onto
Node's global), through that method. There a running collector counts as a
page error listener, so the environment no longer fails a test on an
uncaught error while it runs.

- An uncaught error is read from a platform `ErrorEvent` through the getters
  captured at load: `message` is the browser's text (`"Uncaught Error: boom"`)
  when it has one, `filename` goes through `redactUrl`, and `lineno` and
  `colno` are kept. An `error` event that is not an `ErrorEvent` (one the page
  dispatches itself) is ignored.
- An unhandled rejection's reason is read through the captured
  `PromiseRejectionEvent` getter or, without that class, from the event's own
  `reason` data property.
- A thrown value or reason that is an `Error` gives `name`, `message` and
  `stack`, serialized as one entry; reading them can run the error's own
  getters, as for a console argument. Any other value is serialized into
  `value`, and `message` holds it as text (a string as is, anything else as
  its JSON). A cross-origin `"Script error."` has no value.

### WebSockets

`WebSocketCollector` replaces the global `WebSocket` with a `Proxy` of the
page's class (statics, `prototype`, `instanceof` and subclassing keep
working) and wraps `WebSocket.prototype.send`; the last `stop()` restores
both where its own wrapper is still installed, as above. Only sockets
constructed while a collector runs are observed: the constructor adds
`open`, `message`, `close` and `error` listeners before the page can add its
own, and those listeners stay on the socket after `stop()` but record
nothing. A class that extended `WebSocket` before `start()` constructs
through the page's own class and is not observed.

- Messages record their direction and their size in bytes: a string's UTF-8
  length, or the size of an `ArrayBuffer`, typed array, `DataView` or `Blob`
  through the platform getters captured at load. Another payload type is
  recorded without `size`. The payload itself is never recorded.
- A `send()` the socket rejects (still connecting) throws as before and is
  not recorded.
- `url` is the socket's own `url` attribute through `redactUrl`. A close
  event records `code` and `wasClean`, through the `CloseEvent` getters
  captured at load or, on a runtime without a global `CloseEvent` (Node 22),
  through the getters of the event's own prototype. Its `reason` is not
  recorded.
- Node's built-in `WebSocket` reports a refused handshake with an `error`
  event and no `close` event; the collector records what the runtime emits.

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
`message`, a network event's `url` and each header record, an error event's
`message`, `filename` and thrown value (an `Error`'s name, message and stack
together, or `value`), and a websocket event's `url`, are entries.

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
