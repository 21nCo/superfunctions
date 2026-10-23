# Browser chat transport outcome reporting

## Original contract conflict

The original `2026-02-28-new-r7k4m2x9-spec/SPEC.md` line 663 says the consent
message MUST be sent before recording begins. `REQUIREMENTS.md` BOT-008 and
SEC-006 likewise require announcement before recording. However,
`TEST_VECTORS.md` TV-BOT-010 negative explicitly says failed delivery SHOULD be
non-fatal and recording should continue with a warning. The existing server
`worker/consent.ts` and consent lifecycle tests implement that negative vector.
The historical phase tracker marks the specification complete, but this conflict
and absence of live provider acceptance prevent a complete readiness claim.

This checkpoint preserves that server policy pending an explicit decision.
It fixes an independent reporting defect: the shared browser chat tracker caught
and swallowed send failures; Meet/Teams silently returned when no input was found;
and the browser session returned successfully when no chat tracker existed.
Consequently the server could emit `bot.consent_sent` without attempting a send
or after the browser command failed.

## Behavior

Meet/Teams now reject absent chat inputs. Browser sessions reject sends without
an active chat tracker. The shared chat tracker propagates the original fill/
keyboard/transport failure to its caller. Existing server handling then emits
`bot.consent_failed`, without `bot.consent_sent`, and retains its current non-fatal
recording policy. Successful fill and Enter commands continue to resolve normally.
This is browser command submission evidence, not provider delivery acknowledgement,
participant consent or a legal-policy guarantee. Zoom already propagates its SDK
send rejection and is unchanged.

There is no new public option, retry, dependency, provider request or automated
meeting access. Python SDK behavior is unchanged because chat submission here is
an internal TypeScript platform adapter operation.

## Acceptance

The pre-fix Meet run failed all three added cases: absent session, missing input,
and rejected keyboard send incorrectly resolved. After the change:

- Browser-core: 7 tests passed.
- Meet: 14 tests passed, including missing-input/session and preserved-error cases.
- Teams: 12 tests passed with the same failure contract.
- Browser-core, Meet and Teams typechecks and builds passed.
- Server consent fixture additionally asserts that failure emits no consent-sent
  diagnostic: all 3 consent tests passed (96 ms test time).

Tests use owned in-process page/SDK fixtures, not live meetings or a real browser.
No deployment or provider delivery guarantee is inferred. Local logs:
`/tmp/rec-chat-baseline.log`, `/tmp/rec-chat-platforms.log`,
`/tmp/rec-chat-types.log`, `/tmp/rec-chat-build.log`,
`/tmp/rec-chat-adapters-build.log`, `/tmp/rec-chat-consent.log`.

All owned test/build processes exited. No browser, container, network receiver or
external resource was created. The earlier default-parallel server timeout
limitation remains open; this checkpoint did not rerun that broad suite.
