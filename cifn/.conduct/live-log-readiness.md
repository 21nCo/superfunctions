# Live remote shell log checkpoint — 2026-10-23

RUNNER-005 now delivers redacted complete shell output lines during a step and between steps. Per-stream StringDecoder buffers preserve split UTF-8; complete-line buffering prevents configured secret fragments split across chunks from being published separately. Existing literal/multiline-component redaction runs before LogFn and spool writes. Normal completion emits trailing text once; interrupted trailing fragments remain withheld with explicit truncation. Previously published complete redacted lines remain available after interruption.

The Runner command extension accepts an optional line callback and a streamed result marker to avoid duplicate final output. Remote execution isolates callback persistence errors from shell results and marks failed log outcome. This is not a new guarantee for arbitrary custom sinks that throw from unrelated Runner lifecycle hooks.

A 250 ms pump uses the same LogSpool instance as synchronous appends; an awaited acknowledgement therefore cannot overwrite packets appended in flight. Only one send loop runs at a time. Packet/job caps, private atomic fsynced persistence, sequence/digest validation, expiry and authenticated control-plane writes are unchanged. Network failure leaves packets replayable. Timer shutdown and the active request complete before final spool reopen/sealing. Requests retain their existing ten-second timeout.

## Validation

- Runner strict source lint/typecheck and build pass; all 97 runner tests pass.
- New tests prove append-during-ACK survives reopen and final sequencing, plus actual shell split-UTF8/secret output must reach redacted LogFn before a file gate allows that shell to exit. Existing interruption-prefix, Unicode caps, spool failure and process-group tests pass.
- Built real HTTP/SQLite control-plane and shell acceptance passes lost acknowledgement/SQL reopen/replay, successful execution during log-only outage, later replay and exactly-once execution witnesses. New live case reads both redacted stdout and stderr while run status remains running and transfer remains pending; then releases the shell and proves one copy of each line plus terminal completion. Split-secret prefix is absent from transport. The initial fixture waited only for stdout before testing stderr; it now waits for both independently acknowledged packets.
- Fresh normal npm11 installation of eleven local tarballs plus SQLite12.5.0 passes; running the same packaged native script outside the worktree passes live, crash/reopen and outage cases. CJS exports pass; native acceptance imports the runner ESM build. Initial local Node22 invocation hit the existing Node20 SQLite ABI; matching Node20.20 runs passed without rebuilding or changing dependencies.

Receipts: /tmp/cifn-live-{tests,build,native,packed}.log and installed dependency receipt. Owned native fixtures clean up control-plane processes/listeners/spools/database; isolated package fixture removed after verification.

## Remaining scope

Fresh dependency audit reports seven affected package entries (five high, two moderate): UUID bounds-check advisory and TestFn fast-glob/micromatch/braces nested-pattern exhaustion. No dependency-clean claim is made; remediation is a separate open readiness item. Exact receipt: /tmp/cifn-live-audit.json.

No fixed latency SLA, arbitrary-secret discovery, partial-line live delivery, durable active-owner crash reconciliation, external LogFn forwarding, remote non-shell providers or complete production-readiness claim. A started journal without a log outcome is not reopened for mutation by another owner. The later [started snapshot recovery checkpoint](started-log-recovery-readiness.md) can replay its persisted nonterminal packets without taking execution ownership. Existing memory/resource limits are output bounds, not full execution sandbox guarantees.
