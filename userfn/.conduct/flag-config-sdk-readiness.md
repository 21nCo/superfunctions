# Verified explicit configuration refresh in both SDKs

2026-10-20. Implements explicit SDK fetch/verification against the committed
signed service contract. The original automatic-refresh, exposure and remaining
UserFn requirements are preserved below.

## Contract

Opt-in `config` options pin expected tenant and key ID→base64url Ed25519 SPKI
public keys; the SDK environment is required and captured at construction. HTTPS
is mandatory unless the host explicitly enables local HTTP. Construction makes
no config request. TS uses WebCrypto; Python's `userfn[config]` optional extra
loads cryptography/httpx only when configured. Base Python installation remains
dependency-free.

`refreshConfig()` / `await refresh_config()` returns true after applying a new
verified snapshot, false for 304 reuse. Concurrent calls coalesce. Responses are
bounded by 264KiB, 4096 read chunks, 20 JSON levels and an overall request deadline
(default10s, configurable1–60000ms). Identity content encoding is required;
compressed responses reject before body consumption. Redirects and ambient
cookies are disabled; Python also disables environment proxy settings.

Validation checks exact UTF-8 bytes with Ed25519, fixed algorithm/version,
expected tenant/environment, known pinned key ID and SHA-256 ETag. Only then are
all flag/segment definitions validated and staged. Both are applied without an
await between them. Python maps the actual service wire representation into
native dataclasses, preserving rules/prerequisites/environment overrides. Loaded
key mappings are copied; response-provided keys are never trusted.

No first failure replaces bootstrap. No later failure replaces the last good
configuration. 304 cannot establish a cache: it requires the existing verified
ETag and unchanged local definitions. Successful manual configuration setters
invalidate ETag reuse and prevent an older in-flight request overwriting the
manual state. Permanent `closeConfig/close_config` invalidates active work and
prevents late application, including a fetch/coroutine that ignores cancellation.
Errors are observable as ConfigRefreshError; no successful receipt is fabricated.

## Validation

- TS SDK68 existing tests/types/build; service signed-config HTTP acceptance11
  cases, now including actual TS refresh, actual Python refresh against the
  service, invalid signature/identity/ETag, fully signed malformed definitions,
  manual-cache invalidation, real HTTP deadlines, ignored-abort late completion
  and close behavior.
- Python3.9 source72 tests, including four real local HTTP refresh/adversarial
  cases and cancellation-resistant completion. Existing flag/hash behavior stays
  covered. Python3.12.12 fresh installed wheel[config]: 72 tests pass with cryptography50.0.2
  and httpx0.28.1. A separate core-only wheel environment imports successfully
  with neither optional dependency installed.
- Service tests use actual SQLite and shared HTTP/auth/DB; refresh tests run over
  real TCP. SDK storage updates are in-memory and do not claim persistent caches.
- Fresh tarball verification script passes with npm11.21.0 normal resolution
  and Node20.20.0; it exercises the installed SDK refresh
  against the installed service, with no source aliases. Strict installed service
  declarations remain checked without skipLibCheck/peer bypass.

## Remaining original requirements

`refreshInterval/refresh_interval` does not yet schedule background work. Automatic
refresh lifecycle/backoff, persistent client caching, monotonic replay/rollback
and freshness policy, key distribution/revocation administration, cross-browser/load
acceptance, WatchFn flag exposures/evaluation telemetry, UI/hooks and broader
segment/operator parity remain open. A valid signature proves authenticity, not
that a server returned its newest revision; revision UUIDs are not monotonic.
Messaging, surveys, feedback integrations, roadmap/changelog and all other
original requirements are unaffected and remain in scope.


## Late-response cleanup and real browser acceptance

The transport checks abort immediately after fetch resolves and cancels the
returned body before any status/body read. A regression supplies a response after
the request deadline whose body never completes; cancellation is observed once
and no values apply. This handles fetch implementations that ignore abort, in
addition to preventing late application.

`service/scripts/verify-config-browser.mjs` passed with installed Chrome
154.0.8037.58. It bundles the built SDK for the browser, starts real separate-origin
local HTTP app/service servers, and uses actual WebCrypto Ed25519 verification.
Acceptance covers first verified refresh, conditional304 with CORS-exposed headers,
allowed and blocked origins, omission of an ambient cookie, signature/tenant
failure preserving state, and an actual delayed HTTP response respecting the
whole-request deadline. Temporary bundle/profile resources and servers are cleaned
up. This is local Chrome acceptance with explicit HTTP opt-in, not hosted HTTPS,
all-browser or load acceptance.

```sh
USERFN_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
  USERFN_CHROME_PATH=/absolute/path/to/chrome \
  node userfn/service/scripts/verify-config-browser.mjs
```

Subsequent lifecycle checkpoint: [background refresh scheduling](flag-config-scheduling-readiness.md)
implements explicit start/stop and bounded backoff. Persistent caches, freshness,
key administration and exposure requirements remain open.
