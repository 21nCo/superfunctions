# Browser destination isolation checkpoint — 2026-10-23

Requirement: SEC-001 browser navigation, subresource, redirect and DNS destination
boundary. This extends the 2026-10-22 static transport checkpoint; it does not
claim full BrowseFn production readiness or complete all original SEC-001 items.

## Implemented path

The real WebScraper and HTTP router admit exact built-in Playwright/Puppeteer
providers only when trusted constructor configuration supplies an isolation
image. Each protected operation launches a disposable Linux Docker container
with no external network interface. Host-native launches remain available only
for legacy trusted direct calls or explicit `allowPrivateHosts: true`; the router
overrides that option and disables cache. Unsupported/custom/hosted protected
providers remain denied. Python has no local browser provider implementation.

Browser control and proxy traffic cross bounded stdio frames, not a mounted host
socket or exposed Docker socket. The host HTTP/CONNECT proxy checks all DNS
answers, rejects mixed/private destinations, and connects to the checked IP.
Every new redirect/subresource/tunnel connection repeats the check. Existing
connections remain pinned. TLS stays end-to-end; certificate checks are not
disabled. Worker TCP/UDP cannot bypass the proxy to the host network. Service
worker traffic is covered by the network boundary rather than page interception.

The worker uses no host mounts, a read-only filesystem, non-root UID, dropped
capabilities and no-new-privileges. Runtime log driver is `none`, stderr is not
forwarded, and core dumps are disabled. Container memory, CPU, PID, tmpfs and
shared-memory limits are set. Proxy requests, outstanding DNS and broker peers
are bounded; plain HTTP is capped at 10 MiB per body, CONNECT/WebSocket tunnels
at 20 MiB combined bytes. Page resource-limit failures can abort a request.
The worker peer limit terminates the worker. Browser redirect counts use browser
limits, not the static provider's five-hop limit. Encrypted decompression is
bounded by container memory/deadline rather than decoded response-byte counting.

The whole protected operation has a deadline, including initial DNS, startup,
navigation and callback results. Late proxy DNS answers cannot connect. Cleanup
removes only the owned UUID container and verifies Docker reports it absent;
daemon failure or timeout is surfaced as cleanup uncertainty. Cleanup can extend
past the operation deadline. The host's outstanding DNS work and arbitrary
trusted callback side effects are not forcibly cancellable.

## Local acceptance

Environment: Darwin arm64, Node 20.20.0, Docker client/server 29.8.1 running Linux
containers. Host Playwright 1.57.0 and Puppeteer 24.33.0. The separately provisioned
worker uses Playwright 1.57.0 and Puppeteer Core 24.33.0.

- Base: `mcr.microsoft.com/playwright:v1.57.0-noble`, pinned digest
  `sha256:3bed4b1a12f2338642f3d8cba28e291deef3c66bd4a964bbeb3e57bbff511dbd`.
- Owned acceptance image: `browsefn-isolation-acceptance:20261023`, image ID
  `sha256:f28fc51cc0ec6a3dc3e1e4f50b0ad4082aa1b3307d5e58a79a2879bfb5ce98a5`.
- Runtime never pulls; a missing image fails without host-native fallback.
- Native acceptance explicitly classifies only an owned IPv4 fixture as public,
  leaves a separate IPv6 loopback listener denied, and rejects unowned DNS.
  This is local network-boundary evidence, not public-site probing.

Commands from the repository root:

```sh
npm test -w ./browsefn/typescript -w ./browsefn/admin
npm run typecheck -w ./browsefn/typescript -w ./browsefn/admin
npm run build -w ./browsefn/typescript -w ./browsefn/admin
BROWSEFN_ISOLATION_IMAGE=browsefn-isolation-acceptance:20261023 \
  npm test -w ./browsefn/typescript -- tests/browser-isolation.acceptance.test.ts
/tmp/browse-policy-venv/bin/python -m pytest browsefn/python/tests -q
```

Results: 158 SDK tests and 24 admin tests passed. The ordinary SDK suite skips the
16 explicitly gated Docker tests; all 16 also passed when separately enabled.
SDK/admin typechecks and ESM/CJS/declaration builds passed. Unchanged Python
regression suite: 101 passed with 18 existing dependency/deprecation warnings.

Native fixtures exercise:

- Playwright Chromium, Firefox and WebKit: JavaScript, external script resource,
  relative redirect and screenshot positive path; private redirect/image/fetch
  denied with zero actual requests at the denied listener.
- Puppeteer: actual header/cookie receipt, JavaScript, screenshot, trusted page
  callback and denied private subresources.
- All four providers reject an owned invalid HTTPS certificate before any HTTP
  request reaches that server. TLS CONNECT also has a checked-address tunnel
  fixture; no trusted-public-certificate HTTPS success receipt is claimed.
- Public WebSocket and service-worker private fetch behavior.
- Actual raw TCP and UDP attempts inside the running worker toward owned host
  listeners fail; listeners receive no traffic. Docker readback confirms
  network-none, dropped capabilities, read-only root, memory/swap and log policy.
  This is a TCP/UDP namespace test, not a separate WebRTC/QUIC browser API test.
- Real router page rendering; private-host/cache body overrides cannot bypass
  enforcement; unconfigured browsers and custom fallback remain denied.
- Stalled callback timeout, missing worker image, and absence of owned containers
  after completion.

Proxy/lifecycle/broker tests additionally cover mixed DNS, rebinding, credential
URLs, checked-IP CONNECT, HTTP/CONNECT DNS completing after the deadline without
late target requests, pipelined DNS admission, declared/chunked oversized response
abort, malformed/oversized frames, and daemon failure during cleanup. Malformed
worker and daemon-failure cases use isolated process doubles; native failure
acceptance covers the actual missing-image and deadline paths.

## Remaining gates and operational limits

This is an opt-in deployment boundary. A Linux-container Docker daemon, trusted
image and matching browser/client versions must be provisioned. Native browser
launch on a platform without this boundary is not a protected substitute. A
production Linux host, remote Docker daemon, deployed router and registry release
were not exercised. No shared dependency metadata changed.

Host process crashes or unavailable Docker can leave cleanup uncertain; operators
must reconcile owned `browsefn-<UUID>` containers. There is no durable worker
supervisor or cross-process admission quota. Images remain locally provisioned
for reproducibility; no runtime acceptance containers remain. Docker daemon,
image, kernel, local host users and application callbacks are trusted. The
Puppeteer Chromium sandbox is disabled within the container; the enforced
network boundary is the Linux namespace, not a browser sandbox claim.

Hosted provider egress, custom provider attestations, exact hostname allowlists,
Python browser support and the full original performance/release requirements
remain separate unfinished scope. Protected custom proxies and headed browser
mode remain unsupported. Puppeteer host executable/argument configuration applies
only to trusted host-native calls. No deployment, merge, release or PR publication
was performed for this checkpoint.
