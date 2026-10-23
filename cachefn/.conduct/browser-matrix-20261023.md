# Browser correctness matrix checkpoint — 2026-10-23

Starting tree: clean `4a6cc2b33`. Original `V0_SPEC.md` requires IndexedDB in
Chrome, Firefox and Safari, quota handling and persistence. This checkpoint adds
reproducible native-browser runners and strengthens shared correctness evidence;
it does **not** complete the Firefox/native Safari matrix or add performance evidence.

## Fixture changes

The existing Playwright fixture now imports one shared `storageContract` used by
the native Safari and installed-Firefox runners. Existing namespace, TTL, tag,
transaction-abort, atomic pattern invalidation, localStorage, fallback and
adaptive-monitor checks remain. Added checks close an IndexedDB connection and
reopen a separate storage object to verify retained values/tags. Quota acceptance
now observes a real `QuotaExceededError` from the native storage method; it does
not infer quota failure merely because a large value can be read back.

`scripts/safari-acceptance.mjs` starts an owned `/usr/bin/safaridriver`, creates
only its own session, serves a disposable localhost origin, executes the shared
contract, deletes the owned session and verifies driver exit. It never enables
remote automation. [Apple's WebDriver documentation](https://developer.apple.com/documentation/webkit/about-webdriver-for-safari)
describes the isolated automation session, separate from normal browsing data.
A failed session deletion is surfaced, not treated as successful cleanup.

`scripts/firefox-native-acceptance.mjs` uses the installed Firefox executable
with `-no-remote`, headless mode and a newly created owned profile. A random
localhost fixture posts its result back to the owned server. This avoids relying
on Playwright's patched Firefox/Juggler binary. It verifies termination of the
owned process group before deleting the profile. No installed profile is opened.
Both native runners deliberately report `offlineConnectivityTested:false`;
WebDriver/native command-line startup does not provide the Playwright fixture's
network-toggle test. Python and runtime library source are unchanged.

## Actual results

- **Chrome154.0.8037.58:38 assertions passed** in a fresh headless context,
  including the shared34 checks and existing4 offline/reconnect queue checks.
  `/tmp/cache-shared-browser-chrome.log` records the exact browser/user agent.
- **Firefox: blocked before Cache code executes.** Playwright1.57.0 with cached
  firefox1497 timed out after30 seconds with sandbox-extension/graphics errors.
  Playwright1.64.1 with cached firefox1555 exited1, `Could not find profile folder`.
  Canonical `/private/tmp` reproduces that failure. Installed Firefox through the
  new native runner also exits1 with that message, both with a fresh canonical
  OS-temp profile and a disposable directory under the current user's home.
  No storage assertions ran; no Firefox acceptance is claimed.
- **Native Safari27.0 (22625.1.29.11.27): blocked at session creation.** Driver
  responds, but POST/session returns `session not created` requiring Allow Remote
  Automation in Safari settings. No session/window was created. Cleanup receipt
  confirms driver exit and server closure. No setting was changed. No Safari
  storage assertion ran, and WebKit results are not substituted.

Receipts: `/tmp/cache-firefox-correctness.log`,
`/tmp/cache-firefox-current-correctness.log`, `/tmp/cache-firefox-canonical-temp.log`,
`/tmp/cache-native-firefox-current.log`, `/tmp/cache-native-firefox-home-temp.log`,
`/tmp/cache-native-safari-current.log`, `/tmp/cache-shared-browser-chrome.log`.
Owned launch processes exited; the native Firefox profile and its temporary home
parent were removed. Scripts pass `node --check`; `git diff --check` passes.
No browser downloads, host-setting changes, deployment, release or provider sends.

## Reproduction

From the repository root, with esbuild installed:

```sh
# Use an existing Playwright installation; this task used1.64.1.
export PLAYWRIGHT_MODULE_PATH=/path/to/playwright
BROWSER_ENGINE=firefox node cachefn/typescript/scripts/browser-acceptance.mjs
BROWSER_EXECUTABLE_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node cachefn/typescript/scripts/browser-acceptance.mjs
node cachefn/typescript/scripts/safari-acceptance.mjs
# FIREFOX_EXECUTABLE_PATH can select another installed Firefox executable.
node cachefn/typescript/scripts/firefox-native-acceptance.mjs
```

The runners fail nonzero on host availability errors. A native runner's successful
result still covers storage correctness, not Playwright offline toggling or the
original p99/memory/performance targets. Prior Chrome performance receipts remain
separate and unchanged. Native Safari needs the host automation gate resolved;
Firefox needs an environment where an owned isolated profile can start.


## Authorized native Safari acceptance

A subsequent user-authorized temporary settings change unblocked native Safari27.0. On source `19a7af179b1c0aa6c0be74ba4a0c2c180bbe27b2`, `node cachefn/typescript/scripts/safari-acceptance.mjs` exited0 and passed all34 shared storage assertions. These cover namespace separation, TTL, tag consistency, failed-write and transaction-abort rollback, persistence after connection reopen, atomic pattern invalidation, localStorage and quota/fallback handling. This supersedes the earlier session-creation blocker for this run only.

Receipt: `/tmp/cache-native-safari-authorized-20261023.log`. The actual native browser reported Safari27.0, AppleWebKit605.1.15. Cleanup reported `driverPid:58699`, `driverExited:true`, `sessionCreated:true`, `sessionDeleted:true`, `serverClosed:true`. The fixture used its isolated WebDriver session and a disposable localhost origin.

Afterward, Safari settings read back both Allow remote automation and external agents and Show features for web developers as0, restoring their original disabled state; settings were closed. No persistent enablement is required or claimed. No library source changed. This proves the34-check native storage contract; offline connectivity toggling, native Safari performance and the blocked Firefox matrix remain unverified.
