# Browser pending-delivery discard

The browser transport now supports synchronous `discardPending(): number` and cumulative `discardedCount`. This is a local policy-withdrawal primitive: queued events and the in-flight batch remain owned until acknowledgement removes them, and are counted once when discarded. Outstanding capture/flush promises reject with exported `BrowserDeliveryDiscardedError extends BrowserDeliveryError`.

Each delivery cycle uses its own abort generation. Discard replaces that generation and detaches its pending promise before aborting. Request and retry races settle without depending on fetch honoring AbortSignal. Generation checks fence acknowledgements and retries, and promise-identity checks prevent an old finally handler from clearing a new pending operation. New captures, including byte-identical envelopes, start independently. Retry and timeout timers and abort listeners are cleaned up. A late discarded response body is canceled.

`close()` still stops collection and flushes; after failure it remains retryable. Discard neither reopens a closed client nor disables future automatic collection. Consent-controlled hosts should use `autoTrack: false` and gate collection themselves. Independent issue-status reads are unchanged. Discard does not retract requests already handed off or erase persisted records; its counter is local removal accounting, not a count of events guaranteed never to reach the server.

## Validation

- Browser suite: 36 tests pass, including 6 new discard cases. Covers pending microtask, permanently hung and abort-ignoring fetch, late202/503, identical-envelope recapture, pending-promise ownership, retry timer cancellation, unsent tail plus in-flight count, cumulative counts and closed-client behavior.
- Strict TypeScript source check (`tsc --noEmit --strict`, ES2022/DOM) passes.
- Browser CJS/ESM/IIFE and declaration builds pass; runtime checks confirm both module formats export the new subclass and public getters/method.
- Chrome154.0.8037.58 against actual local HTTP: server receives first hanging request; discard settles it locally; immediate new capture succeeds; transient503 retry wait is discarded; later capture and close succeed. The server receipt explicitly demonstrates that discard cannot retract a handed-off request.
- Existing actual ChromeHTTP regression passes503 retry,401 retention, refreshed credentials, close and Unicode preservation.

Commands: `npm test --workspace @watchfn/browser`, `npm run build --workspace @watchfn/browser`, and `node watchfn/agents/browser/tests/{discard-browser-acceptance,browser-acceptance}.mjs` with `PLAYWRIGHT_MODULE` pointing to the installed Playwright module. Temporary logs: `/tmp/watch-discard-{tests,types,build,exports,browser,browser-regression}.log`. Browser instances and local HTTP servers are closed by script finally handlers.

This validates local SDK/HTTP behavior, not withdrawal of remote records, hosted deployment, or delivery durability. Abort-ignoring transports may continue underlying work; their completion is ignored and cannot mutate the new delivery generation.
