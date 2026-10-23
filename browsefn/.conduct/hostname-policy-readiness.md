# Exact hostname policy checkpoint — 2026-10-23

This implements the hostname portion of the original audit-fix SPEC public
`SecurityConfig` declaration (lines 178–197) and Security item 2 (line 474). That
item permits direct-library private-host opt-in through `allowPrivateHosts` or
`allowedHosts`. Consequently `allowedHosts` is an exact private-host exception
list, not an exclusive public-host allowlist. The specification does not define
wildcards or rule precedence; this checkpoint uses conservative exact matching
and deny precedence, documented as implementation choices.

## Public behavior

Both SDKs expose global `BrowseFnConfig.security` and per-call destination policy
for page, metadata and image downloads. The implemented `SecurityConfig` fields
are `allowPrivateHosts`, `allowedHosts` and `blockedHosts`. Python additionally
accepts snake_case aliases. Rules normalize case, IDNA ASCII, a single trailing
dot and IPv6 literals, including IPv4-mapped IPv6. URL components, ports, CIDRs,
wildcards, zone IDs, malformed arrays and ambiguous numeric IPv4 rules are
rejected before DNS. Matching is exact; a parent name does not authorize children.

Per-call allowed lists replace defaults when present; an empty list removes
exceptions. Blocked lists are combined with defaults, and deny rules win over
both the exception list and broad private-host opt-in. Effective page policy is
resolved before cache identity, so previously allowed cached content cannot
satisfy a request with a different denied policy. Static page and image transfers
check each redirect hostname, validate all DNS answers unless that exact name
has an explicit private exception, and connect to the checked address. An
exception explicitly trusts the named host's DNS answers; it is not an IP-range
exception inherited by redirects or other names.

Routers set `allowPrivateHosts: false` and `allowedHosts: []`, retain global deny
rules, and keep page/metadata caching disabled. Caller-supplied nested policy,
global private exceptions and the legacy image flag cannot bypass router
private-network denial. Nested image policy takes precedence over the legacy
flag for direct calls. Unsupported providers cannot attest themselves into the
protected transport.

## Browser limitation remains explicit

The existing isolated browser path without hostname rules remains available and
was rerun against actual owned fixtures. Browser calls with a nonempty allowed
or blocked hostname list fail closed, even when `allowPrivateHosts` is true.
They do not launch a worker or silently use a host-native browser.

The proxy sees plaintext HTTP authority and TLS CONNECT authority, not every
Host/:authority inside an encrypted reused connection. Cross-origin HTTP/2
coalescing and ORIGIN behavior require further protocol enforcement and
multi-origin TLS acceptance before strict browser hostname semantics can be
claimed. This is an unclosed requirement, not a proven exploit in the current
browser versions. No speculative engine flags or disabled TLS certificate
verification were substituted for acceptance. The no-exception public-IP
boundary remains pinned and isolated as documented separately.

## Validation

Commands from the repository root:

```sh
npm test -w ./browsefn/typescript -w ./browsefn/admin
npm run typecheck -w ./browsefn/typescript -w ./browsefn/admin
npm run build -w ./browsefn/typescript -w ./browsefn/admin
BROWSEFN_ISOLATION_IMAGE=browsefn-isolation-acceptance:20261023 \
  npm test -w ./browsefn/typescript -- tests/browser-isolation.acceptance.test.ts
/tmp/browse-policy-venv/bin/python -m pytest browsefn/python/tests -q
```

The full ordinary SDK suite passed 177 tests; admin passed 24. The ordinary suite
skips 17 opt-in Docker tests, which also passed in a separate native run. SDK/admin
typechecks and SDK ESM/CJS/declaration plus admin builds passed. Python passed 119
tests with 18 existing dependency/deprecation warnings. No manifest, lockfile,
shared package or dependency changes were required.

Each SDK has 18 focused hostname fixtures. Owned HTTP listeners prove exact
hostname exceptions succeed, blocked hosts receive no request, redirects do not
inherit exceptions, global rules reach page/metadata/image calls, router rules
cannot be weakened, and cached allowed pages do not bypass denied policy. DNS
fixtures cover actual IDNA resolution and a trailing-dot host; IPv4-mapped IPv6
uses the real listener for both default denial and explicit-exception success.
Malformed rules are rejected before the DNS hook. Static public-host acceptance
also confirms that a private exception list does not become an exclusive list.
Native browser acceptance verifies the hostname fail-closed gate while retaining
Chromium/Firefox/WebKit/Puppeteer rendering, private-target denial, service-worker
and WebSocket behavior, invalid-TLS rejection, deadlines and cleanup. No public
site was probed and no live provider credentials were used.

## Remaining original limits to implement separately

- `SecurityConfig.maxResponseBytes`, `maxDownloadBytes` and `maxRedirects` are not
  implemented globally. Existing static page limits are fixed; image limits use
  legacy per-call fields. No unsupported global fields are advertised as working.
- Image download default is 20 MiB in both SDKs, whereas original Limits 6 requires
  25 MiB. This checkpoint does not lower or redefine the required threshold.
- Router screenshot serialization lacks the original 10 MiB encoded-output cap
  (Limits 7). Encoding currently occurs without checking that limit first.
- Browser page extraction lacks a 10 MiB decoded `page.content()` limit (Limits 5).
  The proxy wire limits and worker memory limit do not establish decoded payload
  compliance. TLS tunnel byte caps are not per-response decoded-size caps.
- Browser redirect counts currently follow engine behavior rather than a shared
  configurable policy; browser hostname enforcement remains gated as above.
- Hosted/custom-provider network assurances, Python browser functionality,
  host-crash worker reconciliation and the broader release/performance scope
  remain unfinished. Legacy direct calls without security retain their existing
  behavior and are not an untrusted-URL security boundary.

These are local implementation checkpoints, not full SEC-001 or production
completion. No push, deployment, merge or release was performed for this slice.


The later [configurable-limits checkpoint](./configurable-limits-readiness.md)
implements static/image global limits and records the remaining browser limit
contract. Earlier statements that all global limits were unimplemented describe
this hostname checkpoint only.
