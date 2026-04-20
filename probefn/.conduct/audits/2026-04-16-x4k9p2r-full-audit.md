# Metadata

- timestamp: `2026-04-16T05:33:00Z`
- agent_name: `codex`
- model: `gpt-5`
- launcher: `Codex Desktop`
- workspace/project path: `repo root`
- OS: `Darwin arm64`
- shell: `zsh`
- repo metadata: `git branch=main; commit=none yet; dirty=true`
- intent/notes paths audited:
  - `Codex thread user prompt and follow-up clarifications`
  - `External docs referenced in the thread and captured in the spec metadata`
- spec bundle paths audited:
  - `.conduct/specs/2026-04-15-new-384qfawh-spec/INTENT_AUDIT.md`
  - `.conduct/specs/2026-04-15-new-384qfawh-spec/PLAN.md`
  - `.conduct/specs/2026-04-15-new-384qfawh-spec/SPEC.md`
  - `.conduct/specs/2026-04-15-new-384qfawh-spec/REQUIREMENTS.md`
  - `.conduct/specs/2026-04-15-new-384qfawh-spec/TEST_VECTORS.md`
  - `.conduct/specs/2026-04-15-new-384qfawh-spec/phases/PHASE_00.md` through `PHASE_12.md`
- codebase scope audited:
  - `repo root`
  - excluded from pass/fail determination except where explicitly inspected as evidence: generated `.artifacts/`, existing `.conduct/phase-reports/`
- commands executed during audit:
  - `git status --short --branch`
  - `pnpm test:vectors`
  - `pnpm turbo run test typecheck`
  - `pnpm probefn session start --config test/fixtures/vite-console-error/probefn.config.ts --mode mixed --browser chromium --json`
  - `pnpm probefn run flow --session sess_console_error --file test/fixtures/vite-console-error/flows/trigger-error.yaml --json`
  - `pnpm probefn session stop --session sess_console_error --json`
  - `node --input-type=module` stdio probe that initialized `pnpm probefn mcp serve --stdio` and invoked `probefn_run_flow`

# Audit scope

This was a full read-only audit against both:

1. The original user intent expressed in the conversation.
2. The complete spec bundle under `.conduct/specs/2026-04-15-new-384qfawh-spec/`.

The audit covered:

- intent completeness in the spec
- requirement coverage in the implementation
- repo-root verification commands
- targeted manual probes of the CLI and MCP flow-runner paths
- cross-cutting concerns required by the audit skill: security, determinism, limits, error envelopes, and compatibility/versioning

No implementation files were modified during the audit.

# Inputs audited (intent + spec bundles)

## Intent sources

The authoritative intent came from the user’s thread:

- compare AI browser layers with Playwright only to ground the design direction
- build a framework usable by coding agents such as Codex or Claude Code
- make it reliable for browser-based debugging instead of speculative diagnosis
- capture console logs and broader runtime evidence
- support screenshots plus stronger structural/browser-native signals
- support design review and visual regression workflows
- define the full architecture, stack, interfaces, navigation model, dev-server integration, artifact model, and log forwarding
- keep the system local-first
- use `TypeScript/Node.js + Playwright + Turborepo`
- create the implementation in a new repo in the current workspace
- do not defer scope to later versions

## Spec bundle inputs

I independently read and validated:

- the intent-to-spec mapping in `INTENT_AUDIT.md`
- the system/package/phase plan in `PLAN.md`
- the normative API/semantics/invariants in `SPEC.md`
- the requirement inventory and acceptance criteria in `REQUIREMENTS.md`
- the documented golden vectors in `TEST_VECTORS.md`
- every phase file `PHASE_00.md` through `PHASE_12.md`

## External inputs referenced by the spec

The spec metadata also cites the external Stagehand, Eko, and Playwright references used during discovery. I treated those as design context already absorbed into the spec rather than as separate pass/fail authorities.

# High-level findings

1. The repo broadly implements the intended local-first architecture well. The Turborepo layout, contracts, storage, dev-server orchestration, Playwright runner, design analyzers, baseline system, report export, auth profiles, and docs are all present, and both repo-root verification commands passed in the audited checkout: `pnpm test:vectors` returned `28/28` and `pnpm turbo run test typecheck` completed successfully.
2. `API-002` is not met: `probefn_run_flow` is registered and documented on the MCP surface, but the implementation is an unconditional stub that throws `E_INTERNAL` instead of executing the flow. This is a direct parity break for coding-agent consumption.
3. `TEST-001` is not met: the shipped “golden vector” runner does not execute many of the end-user command paths described in `TEST_VECTORS.md`. In particular, `TV-EVENT-001` is counted as covered by `@probefn/core` tests rather than a real `run flow` execution, and the shipped console-error flow fixture itself is invalid because it tries to click a `Submit order` element that does not exist in the console-error fixture page.
4. Documentation is mostly solid, but `DOC-001` is only partial because `docs/agent-consumption.md` explicitly promises MCP tool parity including `probefn_run_flow`, which is false in the audited implementation.
5. I found no spec gaps or conflicts inside the single bundle. The spec is complete and internally coherent relative to the user’s stated intent.

# Intent Inventory

1. The framework must be usable by coding agents directly, not just humans.
2. It must operate against browser-based local web applications.
3. It must support reliable debugging based on evidence instead of guessed root causes.
4. It must expose console logs and other runtime evidence to the agent.
5. It must support screenshots, but not rely on screenshots alone.
6. It must support design review of the app, not only debugging.
7. It must support visual regression detection/comparison.
8. It must have an explicit architecture rather than an informal prototype.
9. It must specify the primary implementation language and stack.
10. It must explain how agents consume it, including whether CLI and/or MCP are used.
11. It must define how the agent navigates/interacts with pages.
12. It must integrate with running dev servers such as Vite.
13. It must define where artifacts are stored and how they are organized.
14. It must define how console logs and similar signals are forwarded/sunk to agent-consumable context.
15. It must be local-first.
16. It must use `TypeScript/Node.js + Playwright + Turborepo`.
17. It must be created in a new repo in the current workspace.
18. It must use a monorepo if there are multiple packages/surfaces.
19. It must combine screenshots with structural/browser-native signals.
20. It must preserve deterministic browser control rather than screenshot-only clicking.
21. The spec must be detailed and thorough enough to build the framework end to end.
22. Nothing core should be deferred to later versions.

# Intent → Spec coverage matrix

| # | Intent item | Spec coverage | Status |
| --- | --- | --- | --- |
| 1 | Agent-consumable framework | `SPEC.md` Goals, CLI surface, MCP tool surface; `API-001`, `API-002` | Covered |
| 2 | Browser-based local web apps | `SPEC.md` Overview/Target environments; `DEV-001`, `DEV-002`, `BROWSER-001` | Covered |
| 3 | Evidence-first debugging | `SPEC.md` Goals, Root-cause correlation, Report semantics; `DEBUG-001`, `REPORT-001` | Covered |
| 4 | Console/runtime evidence | `SPEC.md` Goals, Event envelope, Observability; `EVENT-001`, `EVENT-002`, `OBS-001` | Covered |
| 5 | Screenshots plus more than screenshots | `SPEC.md` Goals, Action resolution, Checkpoints; `NAV-003`, `SNAP-001` | Covered |
| 6 | Design review support | `SPEC.md` Design audit semantics; `DESIGN-001`, `DESIGN-002` | Covered |
| 7 | Visual regression support | `SPEC.md` Baseline and regression semantics; `BASELINE-001`, `BASELINE-002` | Covered |
| 8 | Explicit architecture | `PLAN.md`, `SPEC.md` Repository/package layout | Covered |
| 9 | Primary stack specified | `SPEC.md` Assumptions/Target environments; `ARCH-001` | Covered |
| 10 | Agent consumption via CLI/MCP | `SPEC.md` CLI/MCP sections; `API-001`, `API-002`, `DOC-001` | Covered |
| 11 | Page navigation model | `SPEC.md` Action resolution semantics; `NAV-001`, `NAV-002`, `NAV-003` | Covered |
| 12 | Dev-server/Vite integration | `SPEC.md` Dev-server integration; `DEV-001`, `DEV-002` | Covered |
| 13 | Artifact storage layout | `SPEC.md` Canonical manifests, Observability, Invariants; `STORAGE-001`, `REPORT-001` | Covered |
| 14 | Console log sinking/forwarding | `SPEC.md` Event envelope, Observability; `EVENT-001`, `EVENT-002` | Covered |
| 15 | Local-first | `SPEC.md` Assumptions, Goals, Security; `RUNTIME-001` | Covered |
| 16 | TS/Node + Playwright + Turborepo | `SPEC.md` Assumptions, package layout; `ARCH-001`, `BROWSER-001` | Covered |
| 17 | New repo in current workspace | `PLAN.md`/repo creation implied; implementation repo exists at `repo root` | Covered |
| 18 | Monorepo if multiple surfaces | `SPEC.md` Repository/package layout; `ARCH-001` | Covered |
| 19 | Structural signals in addition to screenshots | `SPEC.md` page model, checkpoints, design semantics; `SNAP-001`, `NAV-003`, `DESIGN-001` | Covered |
| 20 | Deterministic control over screenshot-only clicking | `SPEC.md` Action resolution, invariants; `NAV-001`, `NAV-003`, `DETERMINISM-001` | Covered |
| 21 | Detailed end-to-end spec | full bundle, especially `SPEC.md`, `REQUIREMENTS.md`, `TEST_VECTORS.md`, phases | Covered |
| 22 | No deferred core scope | `SPEC.md` “Undefined / Explicitly user-deferred only”; phases through `PHASE_12` | Covered |

Spec completeness result: I found no missing intent items and no conflicting spec statements inside the audited bundle.

# Requirement coverage summary

Bundle audited: `.conduct/specs/2026-04-15-new-384qfawh-spec`

| Status | Count |
| --- | ---: |
| PASS | 28 |
| PARTIAL | 1 |
| FAIL | 2 |
| UNVERIFIED | 0 |
| SPEC MISSING | 0 |
| SPEC CONFLICT | 0 |

# Requirement-by-requirement results

| ID | Status | Evidence | Notes |
| --- | --- | --- | --- |
| `ARCH-001` | PASS | `pnpm-workspace.yaml`, `turbo.json`, package tree, `pnpm turbo run test typecheck` | Monorepo layout and required package surfaces are present. |
| `CONFIG-001` | PASS | `packages/contracts`, `packages/contracts/test/config.test.ts`, `TV-CONFIG-001` in `pnpm test:vectors` | Canonical config loading/validation exists and invalid configs are rejected. |
| `RUNTIME-001` | PASS | local artifact roots, no remote dependency surfaced in commands/docs, successful local repo-root verification | Core execution is local-first. |
| `API-001` | PASS | `apps/cli/src/index.ts`, `apps/cli/src/commands/*`, `apps/cli/test/cli.test.ts` | CLI surface exists and canonical JSON envelopes are implemented. The flow-runner validation gap is captured under `TEST-001`, not as missing CLI command wiring. |
| `API-002` | FAIL | `packages/mcp-server/src/tools/report.ts:45-59`, `packages/mcp-server/src/server.ts:1174-1185`, manual MCP probe | `probefn_run_flow` is advertised and registered, but it always throws `E_INTERNAL` instead of executing the flow, so MCP does not have one-to-one parity with the CLI/core action set. |
| `DEV-001` | PASS | `packages/dev-server`, `packages/dev-server/test/dev-server-manager.test.ts`, repo-root test run | Spawn and attach modes are implemented and tested. |
| `DEV-002` | PASS | `packages/dev-server`, `packages/storage`, integration tests, instability metadata in later phases | stdout/stderr sinks, timeout/early-exit handling, and instability labeling are present. |
| `SESSION-001` | PASS | `packages/core/src/session-manager.ts`, session-state persistence, dev-server/browser smoke coverage | Run manifests and one-active-run semantics are implemented. |
| `BROWSER-001` | PASS | `packages/browser-runner`, `packages/browser-runner/test/browser-runner.test.ts` | Chromium launch and persisted browser metadata are present. |
| `NAV-001` | PASS | `packages/browser-runner/src/actions.ts`, `test/actions.test.ts` | Selector-first deterministic actions are implemented. |
| `NAV-002` | PASS | `packages/browser-runner/src/semantic-find.ts`, semantic tests | Semantic navigation resolves natural-language targets through the page model. |
| `NAV-003` | PASS | `packages/browser-runner/src/vision-ranker.ts`, `confirmation.ts`, vision tests | Vision is used only as ranking/disambiguation with structural confirmation. |
| `SNAP-001` | PASS | `packages/core/src/checkpoints.ts`, checkpoint tests | Required checkpoint artifacts and atomic manifest behavior are present. |
| `EVENT-001` | PASS | browser-runner capture, storage sinks, event sink files, tests | Browser and dev-server evidence sinks are append-only structured files. |
| `EVENT-002` | PASS | delta logic in core/browser-runner, checkpoint/action tests | Action/checkpoint delta summaries are implemented. |
| `STORAGE-001` | PASS | `packages/storage`, report export outputs, repo-relative manifests | Run-scoped artifact structure is implemented with repo-relative paths. |
| `STORAGE-002` | PASS | `packages/storage/src/caps.ts`, cap tests | Cap enforcement and rollover/error behavior are implemented. |
| `DESIGN-001` | PASS | `packages/analyzers/src/design/*`, `packages/analyzers/test/design.test.ts` | Core design-audit categories are implemented. |
| `DESIGN-002` | PASS | token drift/focus/touch analyzers and tests | Accessibility-adjacent design findings are implemented. |
| `BASELINE-001` | PASS | `packages/visual-baselines`, baseline registry tests | Deterministic baseline recording exists. |
| `BASELINE-002` | PASS | compare tests, diff modules | Pixel + semantic/layout regression comparison is implemented. |
| `DEBUG-001` | PASS | `packages/analyzers/src/correlation/root-cause.ts`, reporter tests | Evidence-backed hypotheses and unresolved reporting exist. |
| `REPORT-001` | PASS | `packages/session-reporter`, report tests, repo-root report exports | JSON and Markdown reports exist with artifact references. |
| `AUTH-001` | PASS | `packages/core/src/auth-profiles.ts`, auth tests, export filters | Local auth profiles and export omission are implemented. |
| `SECURITY-001` | PASS | redaction pipeline, secret-leak coverage, export filters | Sensitive values are redacted before persistence/export. |
| `DETERMINISM-001` | PASS | deterministic settings persisted in manifests, baseline-key dimensions, deterministic smoke | Deterministic run settings are implemented and observable. |
| `DETERMINISM-002` | PASS | instability metadata propagation, design analyzer warnings/tests | Unstable captures are labeled rather than silently treated as stable. |
| `ERROR-001` | PASS | canonical contracts, CLI tests, MCP invalid-args tests | Structured error envelopes are implemented consistently. |
| `OBS-001` | PASS | trace capture/report linking, browser-runner tests, report exports | Playwright trace handling is present and linked from reports. |
| `TEST-001` | FAIL | `scripts/test-vectors.ts:142-220`, `apps/cli/test/cli.test.ts:46-123`, `test/fixtures/vite-console-error/flows/trigger-error.yaml:1-13`, `test/fixtures/vite-console-error/server.mjs:11-30`, manual `pnpm probefn run flow ...` probe | The repo-root vector runner does not execute the documented vectors end to end; instead it maps vector IDs to package test suites. The shipped flow fixture for `TV-EVENT-001` is invalid because it clicks `Submit order` on a page that contains no such control, and the real CLI probe fails accordingly with `E_ACTION_TARGET_NOT_FOUND`. |
| `DOC-001` | PARTIAL | `README.md`, `docs/getting-started.md`, `docs/artifacts.md`, `docs/baselines.md`, `docs/agent-consumption.md:45-66` | Required operator docs exist, but MCP consumption docs currently promise parity including `probefn_run_flow`, which is not true in the implementation. |

## Requirement notes for failures/partials

### `API-002`

The MCP tool list includes `probefn_run_flow`, and the docs promise parity, but the implementation path is a hard stub:

- `packages/mcp-server/src/tools/report.ts:45-59` registers the tool and forwards to `runFlow(...)`.
- `packages/mcp-server/src/server.ts:1174-1185` immediately throws `E_INTERNAL` with the message `Flow execution is not available through the MCP server yet.`

I confirmed the behavior with a manual stdio MCP probe after `initialize`: the tool returns a structured `E_INTERNAL` payload rather than executing the flow.

### `TEST-001`

The repo-root vector runner currently proves much less than `TEST_VECTORS.md` claims:

- `scripts/test-vectors.ts:142-220` maps vector IDs to package test suites, not to the documented end-user commands in `TEST_VECTORS.md`.
- `TV-EVENT-001` is counted as covered by the `core` group, which only runs `pnpm --filter @probefn/core test`; it does not run the documented `run.flow` command path.
- The only shipped CLI flow file, `test/fixtures/vite-console-error/flows/trigger-error.yaml:1-13`, attempts to click `Submit order`.
- The actual console-error fixture page in `test/fixtures/vite-console-error/server.mjs:11-30` contains no such button or control.

I manually reproduced the gap:

1. `pnpm probefn session start --config test/fixtures/vite-console-error/probefn.config.ts --mode mixed --browser chromium --json` succeeded.
2. `pnpm probefn run flow --session sess_console_error --file test/fixtures/vite-console-error/flows/trigger-error.yaml --json` failed with `E_ACTION_TARGET_NOT_FOUND` for `Submit order`.

So the advertised vector is green in `pnpm test:vectors`, but the shipped end-user path it claims to represent is broken.

### `DOC-001`

The docs are generally good, but `docs/agent-consumption.md:45-66` explicitly states that the MCP surface mirrors the core browser/session operations and lists `probefn_run_flow`. That statement is currently inaccurate because `probefn_run_flow` is registered but not implemented.

# Spec conflicts / spec gaps

## Spec conflicts

None found. I audited a single coherent bundle and did not identify conflicting normative requirements between `SPEC.md`, `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`, or the phase files.

## Spec gaps

None found relative to the user’s stated intent. The specification is detailed, end-to-end, and does not defer core behavior.

# Cross-cutting audits

## Security / authz / validation boundaries

Result: PASS

- The local-first model intentionally avoids shared SaaS authz concerns.
- Sensitive values are routed through a redaction layer and tested via the secret-leak fixtures.
- Auth-profile artifacts are filtered from exported reports/baselines by default.
- CLI and MCP inputs are schema-validated before execution.

Residual risk:

- Because `test:vectors` is not genuinely executing all documented end-user flows, the current automated proof of some security-sensitive paths is weaker than the spec claims.

## Determinism invariants

Result: PASS

- Deterministic settings are persisted into session/run state.
- Baseline keys include deterministic dimensions.
- Instability metadata is propagated to design findings and reports.

Residual risk:

- The determinism contract itself is sound; the main risk is test coverage integrity rather than deterministic implementation drift.

## Limits / caps

Result: PASS

- Artifact/event cap behavior is implemented in storage and tested.
- The cap behavior is explicit: rollover or structured failure, not silent truncation.

## Error handling + canonical envelopes

Result: PASS with one functionality caveat

- CLI JSON and MCP invalid-args paths use stable canonical envelopes.
- Unknown/internal failures are wrapped as `E_INTERNAL`.
- The notable caveat is not envelope shape but missing functionality: MCP `run_flow` returns `E_INTERNAL` because the operation is unimplemented.

## Compatibility / versioning / migrations

Result: PASS

- Persisted JSON uses `schemaVersion`.
- The contracts and manifests are centralized in `packages/contracts`.
- I did not find implementation behavior that contradicts the documented `1.x` compatibility strategy.

Audit-environment note:

- The repository declares `node >=22.0.0` in `package.json`.
- The audit environment was `node v20.20.0`, which emitted engine warnings, but the audited commands still ran. I did not count that as an implementation failure because the repository correctly declares its intended runtime.

# Recommendations

## Top risks (ranked)

1. `API-002` parity break for agent consumers.
   Why it matters: coding agents using MCP cannot run flows even though the tool is advertised and documented as available.
2. False confidence from `pnpm test:vectors`.
   Why it matters: the repo-root green signal currently masks broken end-user paths, including the shipped console-error flow fixture and the missing MCP flow implementation.
3. Documentation drift around MCP parity.
   Why it matters: agents and humans following the docs will assume a capability that does not exist.

## Fix order (ranked)

1. Implement `probefn_run_flow` in MCP by delegating to the same flow executor used by the CLI, then add a real positive MCP flow contract test.
   References: Intent items `1`, `10`, `11`, `14`; requirements `API-002`, `DOC-001`.
2. Replace the current vector indirection with genuine end-user vector execution for the documented commands, especially `run flow`, MCP flow parity, and any negative variants that are currently only implied by unit tests.
   References: Intent items `3`, `11`, `12`, `13`, `21`; requirement `TEST-001`.
3. Repair the shipped console-error flow fixture so it matches the actual fixture page, or repair the fixture page so the flow is real.
   References: Intent items `3`, `4`, `11`, `14`; requirements `API-001`, `TEST-001`.
4. Update `docs/agent-consumption.md` only after MCP flow parity exists, so the docs accurately describe the consumable surface.
   References: Intent items `1`, `10`; requirement `DOC-001`.

# Appendix: commands run + environment details

## Commands run

From `repo root`:

```bash
git status --short --branch
pnpm test:vectors
pnpm turbo run test typecheck
pnpm probefn session start --config test/fixtures/vite-console-error/probefn.config.ts --mode mixed --browser chromium --json
pnpm probefn run flow --session sess_console_error --file test/fixtures/vite-console-error/flows/trigger-error.yaml --json
pnpm probefn session stop --session sess_console_error --json
```

I also ran a repo-root `node --input-type=module` probe that:

1. spawned `pnpm probefn mcp serve --stdio`
2. sent `initialize`
3. sent `notifications/initialized`
4. invoked `tools/call` for `probefn_run_flow`

## Command outcomes

- `pnpm test:vectors` returned a success envelope with `vectorsPassed: 28` and `vectorsFailed: 0`.
- `pnpm turbo run test typecheck` completed successfully across the workspace.
- The manual CLI `run flow` probe failed with canonical `E_ACTION_TARGET_NOT_FOUND` for `Submit order`.
- The manual MCP `probefn_run_flow` probe failed with canonical `E_INTERNAL` and the message `Flow execution is not available through the MCP server yet.`

## Environment details

- OS: `Darwin arm64`
- shell: `zsh`
- Node during audit: `v20.20.0`
- package manager during audit: `pnpm 10.0.0`

