# Router destination enforcement checkpoint — 2026-10-22

Requirement: SEC-001, original audit-fix SPEC Security 1–2 and Limits 5.
This checkpoint closes the reproduced default `/web/page` loopback request and
caller-controlled image private-host override. It does not establish full
production readiness or complete SEC-001.

The browser restriction recorded below is historical checkpoint behavior.
The [2026-10-23 browser isolation checkpoint](./browser-isolation-readiness.md)
adds configured TypeScript browser execution through a Linux network namespace.
Hosted/custom provider and full SEC-001 limits remain separately qualified.
The [hostname policy checkpoint](./hostname-policy-readiness.md) subsequently adds
exact hostname exceptions and deny rules.

## Behavior

- Both routers overwrite page/metadata security with `allowPrivateHosts: false`
  and disable cache. Metadata propagates the mandatory option to each page fetch.
  Image download routers overwrite the legacy `allowPrivateHosts` flag; the
  TypeScript router also prevents a custom provider download from bypassing it.
- Static page HTTP(S) transport checks literal addresses and every DNS answer,
  rejects mixed public/private answer sets, and uses the checked address directly.
  Node supplies checked answers through the socket lookup; Python connects to the
  checked IP with the original Host and TLS SNI identity. No proxy/environment
  proxy is used. TLS certificate verification remains enabled.
- Every redirect repeats the policy, including scheme/credential checks; five
  redirects maximum. Caller headers are dropped on origin changes.
- Bodies are capped at 10 MiB by declared length and cumulative bytes; identity
  encoding is requested and compressed responses are rejected. The overall
  deadline covers DNS, headers, redirect chain and body, with UPSTREAM_TIMEOUT.
- Policy errors are terminal for fallback and retry. Before invocation or
  availability probing, protected web calls reject browser, hosted and custom
  providers that lack the transport boundary. Python protected cookies and all
  protected proxies are rejected. No browser is launched by a rejected call.
- Direct library calls can explicitly select protected static transport or opt
  into private hosts. Legacy calls omitting security retain existing behavior;
  they must not be exposed to untrusted URLs. Protected direct callers must
  disable cache themselves; HTTP callers cannot override that setting.

## Evidence

Committed TypeScript and Python tests use owned ephemeral HTTP servers. Actual
router calls deny loopback (including Node URL numeric/hex normalization) without
any target request despite body security/cache overrides. Metadata reports item
failure, and image override denial also receives no target request. Explicit
private-host opt-in fetches and follows a relative redirect, preserving final URL
metadata. Custom fallback is never invoked after a policy denial.

DNS fixtures inject a mixed public/private response and observe zero connections;
positive checked-address fixtures assert the hostname is resolved once. Redirect
fixtures classify only the owned origin as public for the test, leaving the
private redirect destination denied and unrequested. This is deterministic local
evidence, not a claim of a public production network experiment. No external
host was probed. TypeScript also exercises chunked payload overflow; both
languages cover declared overflow, redirect loops, invalid redirect scheme,
compressed-response rejection and timeout.

Validation:

- TypeScript full suite: 139 passing, including 9 destination-policy tests.
  SDK/admin typechecks and builds pass.
- Python fresh 3.12 environment: 101 passing, including 7 destination-policy
  tests. Earlier system 3.9 focused
  service/router/provider/middleware run: 30 passing.
- System 3.9 full collection lacked Pillow; fresh 3.12 resolves the required
  dependencies. Test-extra installation required local shared python-core and
  python-sqlalchemy 0.1.1 because the published sqlalchemy adapter is 0.1.0.
  No dependency manifests or shared source were changed.

Logs: `/tmp/browse-policy-{tests,all,types,build,python,python-all,python-focused,install}.log`.

## Outstanding original requirements

Browser functionality under a real egress boundary remains required. Request
interception or preflight DNS alone cannot certify browser subresources,
WebSockets, service workers, WebRTC/QUIC and DNS rebinding. A pinned HTTP/CONNECT
proxy is a possible component, but must be paired with process/network isolation
preventing alternate egress and verified for Chromium, Firefox and WebKit.
Existing browser providers have no such sandbox; they are rejected here rather
than represented as safe. Remote hosted providers need separately established
remote egress guarantees. Custom provider support, exact allowedHosts policy,
default direct-library migration, bounded compressed response decoding and
cookie forwarding remain unfinished. Private networking via a globally routed
address or unusual deployment routing also requires deployment firewall policy.
No browser sandbox, deployment, TLS certificate fixture, external service
integration, hosted CI result, or full secret-redaction audit is claimed by these
local transport tests.
