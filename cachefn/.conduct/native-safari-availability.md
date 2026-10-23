# Native Safari acceptance availability

2026-10-20, inspected at Cache head `3ceb82fb5888fbbd684c6723bd8ac6c08063eae9` with a clean worktree. `V0_SPEC.md:882` explicitly requires IndexedDB tests in Chrome, Firefox and Safari, followed by quota and storage-persistence checks. Existing Playwright WebKit evidence does not satisfy native Safari execution.

The host includes `/usr/bin/safaridriver`, reporting `Included with Safari 27.0 (22625.1.29.11.27)`. A disposable driver process was started with `-p` on an available ephemeral port. Its local `GET /status` returned HTTP200 and `{"value":{"message":"","ready":true}}`. This is driver availability, not permission to automate Safari.

`POST /session` with `{"capabilities":{"alwaysMatch":{"browserName":"safari"}}}` returned HTTP500:

```json
{"value":{"error":"session not created","message":"Could not create a session: You must enable 'Allow remote automation' in the Developer section of Safari Settings to control Safari via WebDriver.","stacktrace":""}}
```

No session was created; no browser window, profile or personal tab was accessed. No OS/browser setting was changed, no enable command was run, and no software was installed. The owned driver process was terminated and exited0. Raw local receipt: `/tmp/cache-native-safari-probe.log`. Firefox was not retried.

Native Safari IndexedDB namespace/TTL/tag/persistence acceptance remains blocked by host remote-automation configuration. No native storage behavior was executed or claimed. Once the host owner independently permits automation, the availability check can be reproduced using an available local port:

```sh
/usr/bin/safaridriver --version
/usr/bin/safaridriver -p 4444
# In a second terminal, against that owned driver only:
curl --fail-with-body -H 'Content-Type: application/json' \
  -d '{"capabilities":{"alwaysMatch":{"browserName":"safari"}}}' \
  http://127.0.0.1:4444/session
```

If creation succeeds, use only the returned WebDriver-owned session/window, run the existing Cache source contract against a disposable localhost origin, delete that session with `DELETE /session/<returned-session-id>`, and stop the owned driver. The existing `typescript/scripts/browser-acceptance.mjs` is a source for the IndexedDB assertions, but its Playwright WebKit mode is not a native Safari runner; a WebDriver fixture remains required after the host gate is cleared. Do not treat the availability command alone as a storage acceptance test.

2026-10-23 recheck at starting head `4a6cc2b33`: the same session-creation denial
persists. A reusable native runner now exists at
`typescript/scripts/safari-acceptance.mjs`; the shared storage contract is verified
in Chrome but has not executed in native Safari. Current cleanup reports no
created session and a confirmed owned-driver exit. See
[`browser-matrix-20261023.md`](browser-matrix-20261023.md) for exact scope and receipts.

## Authorized temporary-setting attempt — 2026-10-23

The host owner explicitly authorized temporarily enabling Safari remote automation
and restoring it after isolated CacheFn acceptance. Native settings readback showed
`Show features for web developers = 0`. It was temporarily enabled to expose the
Developer panel, where `Allow remote automation and external agents = 0` was read.

Attempting to enable that checkbox produced Safari's protected confirmation:

> Safari detected an app or service that interfered with clicking. Are you sure
> you want to change this setting? Enter your password to continue with Safari.

The prompt was cancelled without entering credentials or bypassing protection.
Developer-panel readback confirmed remote automation still0. Advanced-panel
readback then confirmed developer-feature visibility restored to0. The settings
window was closed. No WebDriver session or storage test was started in this
attempt, and there is no new Safari acceptance result.

The remaining gate requires the host owner to approve the native setting and its
password confirmation manually. Temporary authorization alone cannot satisfy
Safari's protected UI authentication. Once enabled, run the checked-in isolated
`safari-acceptance.mjs` fixture, then restore remote automation and developer-menu
visibility to the recorded original off states and verify both readbacks.
