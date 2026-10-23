# Combined native reporter acceptance

2026-10-23. The existing BotFn acceptance now runs the built CatchFn browser SDK
through the full reporter path against local HTTP/native SQLite and the actual
BotFn GitHub HTTP client with an isolated local provider fixture. No provider
request leaves the fixture and no external issue is created.

The real Chrome reporter captures a private masked DOM element, adds a DrawFn
rectangle, uploads the exported PNG using authenticated upload, and sends its
reference and annotation scene to WatchFn. Assertions inspect uploaded pixels
for both the privacy mask and painted annotation, exclude the original image
from scene metadata, compare fetched bytes, and verify persisted references
after database close/reopen. The widget obtains a validated issue link through
the actual persisted outbox. Private context and upload bytes are not forwarded
to the issue provider by the existing issue-body contract.

A controlled 503 after successful storage makes delivery uncertain; the widget's
Retry same report resends the identical event without another upload or another
issue. Existing Node lost-connection/replay, unauthorized route, status failure,
retention and durable receipt checks remain in the same passing fixture.
An initial browser connection-reset scenario was automatically retried by
Chrome before UI failure; it could not establish the explicit UI retry contract.
The deterministic post-commit503 fixture establishes that contract instead.

Reproduce after building the normal dependency closure:

```sh
CATCHFN_WATCH_CORE=/absolute/path/to/watchfn/typescript/dist/index.mjs node catchfn/typescript/scripts/botfn-acceptance.mjs
```

Final log: /tmp/catch-combined-acceptance-final.log. The fixture exits0 and removes
its browser, servers, SQLite database and uploaded temporary files in finally.
Diff whitespace checks pass. This change adds integration evidence; runtime and
package metadata are unchanged. It does not prove hosted upload authorization,
external provider delivery, other browser engines or all original readiness
gates. Hosts still own attachment retention and orphan cleanup. The test upload
server is a bounded-fixture assertion, not a production ingress implementation.
