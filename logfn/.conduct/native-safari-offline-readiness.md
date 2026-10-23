# Native Safari IndexedDB queue acceptance

On 2026-10-23, source `ad0c8c34acb92757cb00005108c895b9ed19921d` built
successfully and `node logfn/scripts/safari-offline-acceptance.mjs` exited 0 in
**native Safari 27.0**, AppleWebKit 605.1.15, using `/usr/bin/safaridriver`.
This is not Playwright WebKit evidence.

The runner serves the actual compiled LogFn browser entry point on an owned
loopback server. An isolated WebDriver session and ephemeral origin separate its
fixed library database name (`logfn-http-queue`) from personal browser storage;
a random non-secret queue namespace further separates this run. It tests:

- Actual HTTP 503 rejection retains the event in IndexedDB.
- Default privacy transforms remove nested password/token, correlation user ID,
  and pipeline-injected API key before durable storage.
- A page reload in the same Safari session retains the failed event; restoring
  the endpoint and draining delivers it with redaction intact.
- Acknowledgement removes persisted records, and another reload/drain sends no
  additional events. Recovery retains the documented at-least-once semantics;
  this does not claim exactly-once delivery across ambiguous unload requests.
- Two queue instances commit the bounded overflow eviction count, and a failed
  structured-clone write rolls back without incrementing eviction metrics.

The checked-in receipt is
[`native-safari-offline-20261023.json`](native-safari-offline-20261023.json).
Raw local logs: `/tmp/log-safari-native.log` and `/tmp/log-safari-build.log`.
Cleanup confirms owned driver PID 7020 exited, WebDriver session deleted,
IndexedDB database deleted and loopback server closed. Subsequent process readback
found no PID 7020.

## Settings and ownership

The earlier tooling attempt could not inspect Safari (`cgWindowNotFound`); Orca
reported `runtime_timeout`. No setting changed in that attempt. A prior
`open -a Safari about:blank` request returned successfully, but tab creation and
ownership could not be verified, so no unknown tab was closed.

On this resumed attempt, a bounded driver probe initially returned the explicit
remote-automation-disabled session denial and exited without creating a session
(driver PID 4546 confirmed exited). Native GUI access then worked. Both **Show
features for web developers** and **Allow remote automation and external agents**
were read as 0. Under the user's temporary authorization, both were enabled with
readback 1. Immediately after the isolated acceptance completed, remote automation
was restored to 0, developer features restored to 0, and both states verified via
separate native checkbox readbacks. Only the opened settings window was closed;
normal tabs and user browsing data were left alone.

## Reproduction and remaining scope

With the host owner enabling Safari remote automation temporarily, run:

```sh
npm --workspace=logfn/typescript run build
node logfn/scripts/safari-offline-acceptance.mjs
```

The runner never changes the host setting itself. Restore any temporary setting
change to its original value after the run, including failure paths.

This proves the bounded Safari queue/privacy/reload/overflow contract. It does not
prove OS connectivity switching, Safari process-restart persistence, private-mode
or quota-exhaustion behavior, Firefox coverage, browser performance, deployments,
or the complete original LogFn specification. Those remain separate readiness
gates; the earlier Chrome-only limitation is superseded only for these tested
native Safari behaviors. No library source, Python code, dependency, root metadata
or ignore rules changed in this checkpoint.
