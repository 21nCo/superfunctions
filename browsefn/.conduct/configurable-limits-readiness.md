# Configurable security limits checkpoint — 2026-10-23

This implements the static/image portion of the original `SecurityConfig`
`maxResponseBytes`, `maxDownloadBytes` and `maxRedirects` contract in
`.conduct/specs/2026-04-01-audit-fix-gq6dwlwa-spec/SPEC.md`. It does not complete
BrowseFn production readiness or the full browser/global-limit requirement.

## Behavior

- Global and per-call positive safe-integer byte limits, and nonnegative
  safe-integer redirect limits. Defaults: page 10 MiB, image 25 MiB, five
  redirects. Python `None` means omitted; TypeScript omission is `undefined`.
- A per-call value cannot raise an explicit global ceiling. An explicit value
  can exceed the default. Legacy image `maxPayloadBytes`/`maxRedirects` tighten
  configured image limits. Python preserves omitted legacy defaults through
  batch cloning, so explicitly raised global limits are not silently reduced.
- Static page/metadata transports bound received body bytes per hop and reject
  redirect overflow before requesting the next target. Decoded HTML and final
  formatted page content are separately checked as UTF-8 bytes before return
  and cache publication. Cached content is checked again.
- Image transfer, transform input, watermark input and encoded transformed
  output use the effective image ceiling before file publication.
- Routers inherit trusted constructor limits. Request-body private destination
  policy is discarded; legacy image limits can only tighten trusted ceilings.
  The separate router encoded screenshot ceiling remains 10 MiB.
- Browser and hosted providers reject explicitly configured page byte/redirect
  limits before launch or vendor request. The existing isolated browser path
  still works when only an image limit is configured. Remote screenshot CDN
  downloads inherit image limits while retaining their public-only boundary.

## Validation

All fixtures are local and owned. No public provider requests, deployment or
publication were performed.

- `npm test -w ./browsefn/typescript -w ./browsefn/admin`: SDK **192 passed**,
  admin **24 passed**. The default run skips the native Docker acceptance file.
- `/tmp/browse-policy-venv/bin/python -m pytest browsefn/python/tests -q`:
  **144 passed**, 18 existing shared Pydantic deprecation warnings.
- `npm run typecheck -w ./browsefn/typescript`: passed.
- `npm run build -w ./browsefn/typescript`: ESM, CJS and declarations passed.
- `BROWSEFN_ISOLATION_IMAGE=browsefn-isolation-acceptance:20261023 npm test -w
  ./browsefn/typescript -- --run tests/browser-isolation.acceptance.test.ts`:
  **19 passed**, including image-only limits preserving Playwright/Puppeteer
  page loading, existing Chromium/Firefox/WebKit functionality, public
  WebSockets, denied private subresources/service-worker/raw TCP/UDP access,
  certificate verification, timeout and worker cleanup.
- `git diff --check`: passed. Docker container inventory filtered by `browsefn`
  was empty after native acceptance.

New regression cases cover actual declared and streaming bodies at/beyond byte
limits; UTF-8 content; zero redirects with no target request; six explicitly
permitted redirects above the default five; rejection before a seventh target;
malformed configuration; global/per-call/legacy precedence; formatted expansion;
colliding cache keys with oversized content; transformed output and watermark
limits; trusted raised router limits; and unsupported providers rejected before
network use. Remote screenshot tests mock vendor responses and verify the
public-only downloader receives effective limits.

## Remaining boundaries

The browser broker's fixed HTTP/tunnel bounds cannot enforce arbitrary page
response or redirect caps over encrypted connection reuse. Explicit custom page
limits therefore fail closed, rather than silently applying output-only limits.
Python's protected custom/browser providers remain unsupported. Browser hostname
rules still have their separate HTTP/2 coalescing limitation.

Body/content limits do not bound the full response JSON envelope, decompressed
image pixels, encoder intermediates or browser `page.content()` allocation.
Protected static compressed responses remain rejected. Legacy direct static
calls without protected page policy check decoded output after fetch allocation.
Caller-managed cache key generators must preserve policy identity for original
transfer/redirect provenance; cached returned content is checked even on key
collisions. These are explicit remaining constraints, not evidence of complete
memory isolation or full original security coverage.
