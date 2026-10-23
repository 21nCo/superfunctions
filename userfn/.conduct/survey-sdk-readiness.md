# Explicit survey submission SDKs — 2026-10-23

TypeScript submitSurveyResponse and Python submit_survey_response now call the
actual durable survey service. Both require a caller-owned idempotency key. They
serialize answers before retrying, retain the same credential/key/body, and return
only a validated accepted receipt bound to the requested survey and a server
timestamp. Local identity/timestamp fields are not sent as authority. Requests
and receipts are bounded to64KiB; redirects are rejected. Permanent HTTP failures
including429 do not retry automatically. Per-attempt deadlines cover transport
and streamed receipt. Python uses optional userfn[surveys] HTTPX with ambient proxy
configuration disabled, so cancellation does not leave a detached urllib worker.
Cancellation/timeout cannot undo a server commit; callers retain the key and
payload to reconcile. There is no hidden persistent submission queue.

SDK configuration is additive. New Python dataclass fields were appended after
existing fields to preserve positional construction. Explicit user-initiated
submissions follow the feedback consent boundary, not passive messaging consent.
The existing survey renderer remains local/unwired. Python survey eligibility,
rendering, display reservation, WatchFn outbox, tenant-wide submission caps,
branching/richer templates and broader readiness remain unfinished.

Validation:
-229 TypeScript SDK tests, types and build pass.201 Python tests pass.
-Normal Python CI passes normal editable development install, isolated wheel/sdist
 builds, configured mypy34files and201tests. A genuinely fresh environment first
 exposed the missing build tool; build>=1.0 is now declared in the dev extra.
 Ruff was briefly added unnecessarily, enabling a previously absent CI stage
 against inherited broad rules and reporting180 style diagnostics. That new
 addition was removed; original configured checks were not relaxed. This is not
 a Ruff-clean claim. Earlier summaries implying the normal entrypoint ran Ruff
 for this package were inaccurate.
-All21 native service tests pass, including actual TypeScript and Python SDKs
 overHTTP/twoSQLite connections. Each new SDK fixture loses the response after
 commit, retries the same identity, and proves no extra quota consumption.
-A fresh normal npm11 installation of7localtarballs plus a separate noneditable
 Python3.11wheel[surveys] consumer passes actual HTTP ESM/CJS/Python acceptance,
 lost ACK replay, cap denial, and strict NodeNext declarations for bothTS module
 modes. The installed Python import is verified in site-packages underpython-I.
 This installed fixture uses shared memory storage; durable SQLite evidence is
 the separate native test. Production audit reports3moderate entries from one
 underlying UUID advisory, propagated via userfn/service; remediation is pending.

Reproduce installed acceptance after building the dependency closure:
USERFN_NPM_CLI=/path/to/npm11/bin/npm-cli.js \
USERFN_SURVEY_WHEEL_PYTHON=/path/to/installed-wheel/bin/python \
node userfn/service/scripts/verify-survey-package.mjs

Receipts: /tmp/user-survey-sdk-{tests,native,types-final,build}.log,
/tmp/user-survey-python-{tests,types}.log,/tmp/user-surveys-python-ci-final.log,
/tmp/user-surveys-packed.log and /tmp/user-survey-packed-audit.json. Installed npm
fixtures clean up in finally. Owned /tmp/user-surveys-python and
/tmp/user-surveys-wheel environments remain for dependency followup validation.
No push, base merge, deployment, release or external provider send in this slice.

## Final dependency validation

The UUID dependency is now11.1.1-compatible, preserving its explicit browser and
Node ESM/CJS exports. This removes the installed advisory without claiming that
the prior v4 usage exercised its affected buffer APIs. Normal npm11 workspace
install and scoped lock regeneration pass. SDK229tests, types and build pass; a
new test hook initially returned VitestUtils instead ofvoid and was corrected.
Fresh7-tarball ESM/CJS/Python-wheel HTTP acceptance repeats successfully and its
production audit is now zero. The earlier three entries are superseded.

Actual installed Chrome154 runs the built browser SDK through real signed config
and WatchFn HTTP/SQLite exposure persistence, retries, queue bounds and database
reopen successfully (21persisted events). Explicit existing Playwright and WatchFn
built-module paths were supplied from their readiness worktrees; an initial
defaultpath invocation failed before work because local WatchFn dist was absent.
This validates the UUID browser path, not automatic survey-renderer transport.
Receipts /tmp/user-uuid-{install,tests,types-final,build,packed,browser-final}.log.
Python3.11 is the newly verified SDK/wheel version; the broader supported Python
version matrix remains a readiness gate. No release/deployment occurred.
