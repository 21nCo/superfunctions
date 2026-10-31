# MCP critical review remediation — 2026-10-28

Status: coordinated draft candidate is validated locally and remains unreleased. Production
readiness is not established for the entire repository. This receipt distinguishes
completed baseline validation from later review changes awaiting final qualification.

## Coordinated package graph

| Package | Candidate version |
| --- | --- |
| @mcpfn/core | 0.0.6 |
| @mcpfn/client | 0.0.5 |
| @mcpfn/auth | 0.0.6 |
| @mcpfn/testing | 0.0.6 |
| @mcpfn/inspector | 0.0.5 |
| @mcpfn/datafn | 0.1.5 |
| @mcpfn/cli | 0.0.7 |

Direct SDK pins converge on 1.32.1. Core/Auth bundle Zod 4.6.6. The initial
15-package consumer audit had nine high-severity package findings (not nine
independent vulnerabilities), including nested old core/SDK copies. The coordinated
normal install has zero advisories and one physical copy of every MCP package,
SDK 1.32.1, and fast-uri 3.1.9. No consumer overrides or legacy peer resolution.

Core/Auth builds validate actual SDK/Zod input roots and versions, capture input
hashes, and seal final bundle hashes in shipped inventories. Packed and extracted
release archives are checked against those inventories. This is build provenance
and consistency evidence, not an independent signature of trustworthy code.

## Completed baseline gate

`/tmp/mcp-reviewed-gate-complete-20261028.log`: **101/101 steps passed**.
Individual command output is retained under
`/tmp/mcp-reviewed-gate-artifacts-20261028/step-results/`.

- Core: 292 tests; Auth: 81 tests; Testing: 299 tests at this baseline.
- Actual official MCP conformance and authenticated native Chromium flow passed.
- Actual workerd startup/authenticated calls passed with consumer Zod 3.25.76 and
  4.6.6. The fixture supplies a verified service subject for stateful sessions.
- Fresh packed core/admin and seven-package ecosystem checks passed on exact
  Node 18.18.0 and 20.0.0; combined Node 18 HTTP uses explicit WebCrypto flag.
- Packed ESM/CJS checks cover independent SDK error identity and the forward-ported
  next declaration-order, hidden-tool, and prompt-schema behavior.
- Full packed production audit: zero advisory findings; graph and inventories checked.

This gate predates the subsequent D2–D14 review batch. Do not represent it as
qualification of those later source changes. Current focused tests and final gate
receipts must be added before claiming the final candidate passes.

## Review-driven changes

All external reviews used the Claude CLI with canonical `claude-opus-5-5`,
read-only source snapshots, and no fallback model. Reviews are static evidence;
reported defects were reproduced before fixes where meaningful.

Implemented baseline fixes include resource/expiry enforcement, foreign SDK
McpError preservation, rejection of shared task storage in stateless HTTP,
issuer-bound OAuth credential migration, callback-state enforcement, and verified
subject binding for authenticated stateful sessions. Known-session-ID attacks
were reproduced; session-ID discovery was not demonstrated.

The second security review prompted further bounded work: explicit unbound-session
policy, malformed expiry rejection, resource-aware authorization, graceful host
signal handling, session capacity/idle lifetime, collision rejection, and anonymous
session isolation. These changes are under focused validation and follow-up review.

No full runtime redesign was recommended. Release/source convergence remains
necessary: next and dev cannot publish different implementations under one version.
Next's package/version lines and unpublished DataFn dependencies remain separate
release work; no release, merge, deployment, or registry mutation was performed.

## CI and release tooling

- Full npm 10.2.0 and 10.9.2 installation planning passes after adding the one
  missing @emnapi/runtime 1.11.3 placement; scoped Auth release planning passes
  with npm 10.9.2. Four orphaned extraneous SDK 1.29.0 lock entries were removed.
- Main PR CI's npm-ci failure was reproduced as that missing lock entry. This
  specific failure was not a billing failure. Next PR CI separately still reports
  account payment/spending-limit blockage.
- CI triggers include shared/root build inputs without suppressing general JS CI;
  disposable actual-Git planner tests passed.
- Core/Auth publication now uses the repository lockfile and checks the exact
  packed archive before publication. Both current archives were extracted and
  verified locally; workflow YAML and release-tag contract tests passed.
- Gate process supervision is POSIX-qualified only. Independently detached children
  require their own lifecycle cleanup; arbitrary process-tree or Windows cleanup
  is not claimed.

Remaining release work includes publication ordering/version convergence,
post-publication core/auth registry qualification, conformance runner transitive
locking/environment policy, and qualification of the final review delta.


## Final validated checkpoint

`/tmp/mcp-final-review-gate-20261028.log`: **101/101 passed** after the D2–D14
implementation batch. All 61 captured changed/new files were hash-identical
before and after the gate. Persistent executable/configuration/test hashes are
in `security-remediation-source-hashes-20261028.json`; subsequent receipt-only
edits do not change those validated inputs.

Core 307, Auth 97, Testing 305, Client 55, Inspector 52, CLI 58, shared Admin 109,
OAuth Core 31, and MCP DataFn 9 tests passed. DataFn server: 1,152 passed and one
skipped. Both real Worker/Zod cases, official conformance, exact minimum runtimes,
packed graph/audit, and embedded inventory checks passed. Per-step stdout/stderr:
`/tmp/mcp-final-review-gate-artifacts-20261028/step-results/`.

The auth/process follow-up accepted the security batch without a regression, but
identified an AuthFn compatibility follow-up: native resource IDs can identify
projects/orgs rather than URL audiences. An explicit trusted alias policy and
protection from authorization-hook claim mutation remain to be implemented.

A core follow-up incorrectly inspected the root SDK 1.25.2 while describing it as
1.32.1. Its claims that the bundled SDK lacks task session filtering and close-time
handler abortion do not match the verified package-local 1.32.1 sources. Those
findings are being re-reviewed against the correct dependency. Error normalization
on other request paths and JSON-response shutdown still require bounded triage.

This is a tested draft checkpoint, not a statement that all review follow-ups or
production/release gates are closed. No package was published.

## Qualified follow-up checkpoint

The combined follow-up gate passed **104/104 steps** in `/tmp/mcp-followup-gate-v2-20261028.log`; full command evidence is in `/tmp/mcp-followup-gate-v2-artifacts-20261028/step-results/`. All 20 frozen changed/new files matched their pre-run SHA256 values afterward; the durable receipt is `security-followup-source-hashes-20261028.json`. Core passed 317 tests, Auth 117, Testing 305, and DataFn server 1,152 with one skip. Fresh-package Node 18.18/20.0/22.13 HTTP lifecycle checks, the existing minimum-runtime ecosystem checks, conformance, browser/worker acceptance and production dependency audit all passed.

This batch closes the confirmed all-handler error-disclosure and pending-HTTP shutdown defects, including a generic 500 for failed initialization. Provider resource-ID mapping now requires provider authorization, snapshots/validates claims before policy callbacks, and fails closed if its authorizer disappears. Noncloneable provider configuration produces an explicit nonretryable configuration error. The stock AuthFn provider still denies authorization and has a separate unresolved functional implementation gap; no bypass was added.

The release preflight rejects an existing target version and unavailable internal dependency versions, both before building and before publication. Live read-only checks accepted unpublished core 0.0.6 and correctly rejected testing 0.0.6 until its dependency versions exist. The bundle verifier rejects escaping symlinks and unsupported identities/options. Exact fresh core archive extraction with `/usr/bin/tar` and inventory verification passed separately; temporary files were removed. The first follow-up gate stopped at an outdated synthetic bundler fixture missing its package name; correcting the fixture preserved the new identity boundary, and the complete rerun passed.

Sequential critical Opus 5.5 reviews accepted the core, provider and release fixes. The tiny generic-initialization-status and final request-time authorizer/test-assertion deltas were qualified after their reviews and are not misrepresented as part of the earlier frozen review snapshots. The earlier core review that inspected SDK 1.25.2 was superseded by the corrected review of actual SDK 1.32.1; its two invalid SDK findings remain retracted.

SonarCloud on the prior pushed head reported two promise-marking findings and two release-script security findings. This batch adds explicit ignored-promise markers, package-root containment and a fixed archive executable. A new remote analysis is still required; this is not a claim that its gate is already green.

Registry availability does not prove source identity. Existing consumer-tree evidence confirms that Auth tests use registry OAuth Core 0.1.1 and MCP DataFn tests use registry DataFn Core 0.1.0/Server 0.1.1/DB 0.2.0, even when newer workspace packages are also installed. The newer DataFn server features are tested separately. Fresh-package MCP DataFn CRUD coverage, next-branch dependency/build qualification, publication-source convergence, post-publication core/auth readback and conformance-runner dependency/environment policy remain open. No publication, deployment or merge occurred.
