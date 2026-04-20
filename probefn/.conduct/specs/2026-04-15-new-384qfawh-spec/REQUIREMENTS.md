# Table of contents

- `ARCH-001`
- `CONFIG-001`
- `RUNTIME-001`
- `API-001`
- `API-002`
- `DEV-001`
- `DEV-002`
- `SESSION-001`
- `BROWSER-001`
- `NAV-001`
- `NAV-002`
- `NAV-003`
- `SNAP-001`
- `EVENT-001`
- `EVENT-002`
- `STORAGE-001`
- `STORAGE-002`
- `DESIGN-001`
- `DESIGN-002`
- `BASELINE-001`
- `BASELINE-002`
- `DEBUG-001`
- `REPORT-001`
- `AUTH-001`
- `SECURITY-001`
- `DETERMINISM-001`
- `DETERMINISM-002`
- `ERROR-001`
- `OBS-001`
- `TEST-001`
- `DOC-001`

## Requirement

- ID: `ARCH-001`
- Priority: `P0`
- Statement: The repository MUST be implemented as a Turborepo monorepo containing `apps/cli`, `packages/contracts`, `packages/core`, `packages/browser-runner`, `packages/dev-server`, `packages/storage`, `packages/analyzers`, `packages/visual-baselines`, `packages/mcp-server`, and `packages/session-reporter`.
- Rationale: The framework has multiple surfaces and shared contracts that require a stable monorepo boundary.
- Acceptance criteria:
  - `pnpm-workspace.yaml` includes `apps/*` and `packages/*`.
  - `turbo.json` defines build, test, lint, and typecheck tasks.
  - The listed packages exist and compile under a shared TypeScript configuration.
- Test vectors: `TV-CONFIG-001`, `TV-FIXTURE-001`
- Notes: Package names MAY use npm scopes, but the package responsibilities MUST remain equivalent.

## Requirement

- ID: `CONFIG-001`
- Priority: `P0`
- Statement: The framework MUST load and validate a canonical `probefn.config.ts` configuration file and reject invalid configuration with `E_CONFIG_INVALID`.
- Rationale: Agents and humans need one deterministic source of truth for dev servers, analyzers, artifact roots, and defaults.
- Acceptance criteria:
  - Config loading succeeds when required fields and valid enums are present.
  - Invalid browser engines, malformed timeouts, or non-relative artifact roots are rejected before execution.
  - Effective defaults are materialized in the run manifest even when omitted from config.
- Test vectors: `TV-CONFIG-001`, `TV-CLI-001`
- Notes: CLI flags MAY override config values, but overrides MUST also pass schema validation.

## Requirement

- ID: `RUNTIME-001`
- Priority: `P0`
- Statement: The framework MUST operate local-first and MUST NOT require any remote service for session orchestration, artifact storage, design audits, regression comparison, or report export.
- Rationale: The user explicitly requested a local-first tool for coding agents and local dev servers.
- Acceptance criteria:
  - A complete debug/design/regression run can execute with network access disabled except for the target app under test.
  - No framework command requires cloud authentication or remote storage configuration.
  - All artifacts and reports are written to local repository-relative paths.
- Test vectors: `TV-SESSION-001`, `TV-REPORT-001`
- Notes: The target application itself MAY call remote APIs; that is outside framework responsibility.

## Requirement

- ID: `API-001`
- Priority: `P0`
- Statement: The CLI MUST expose the session, page, checkpoint, design-audit, baseline, auth-profile, flow-runner, report-export, and MCP-server commands defined in `SPEC.md`, and `--json` MUST emit the canonical response envelope.
- Rationale: Coding agents and humans both need a stable local entrypoint.
- Acceptance criteria:
  - Each documented command parses and invokes the corresponding core action.
  - Success responses emitted with `--json` match the canonical success envelope.
  - Failures emitted with `--json` match the canonical error envelope.
- Test vectors: `TV-CLI-001`, `TV-REPORT-001`
- Notes: Human-readable output MAY differ, but JSON output stability is mandatory.

## Requirement

- ID: `API-002`
- Priority: `P0`
- Statement: The MCP server MUST expose one-to-one tool parity with the core browser/session operations and MUST return the same logical payloads as the CLI JSON mode.
- Rationale: The framework is intended to be consumed directly by coding agents.
- Acceptance criteria:
  - All MCP tools listed in `SPEC.md` are registered.
  - Tool arguments are schema-validated before execution.
  - Tool results and tool errors match the same logical fields returned by CLI JSON output.
- Test vectors: `TV-MCP-001`, `TV-CLI-001`
- Notes: MCP transport metadata MAY wrap the payload, but the inner logical fields MUST be preserved.

## Requirement

- ID: `DEV-001`
- Priority: `P0`
- Statement: The dev-server manager MUST support both `spawn` and `attach` modes for local web applications.
- Rationale: Agents must work with both already-running servers and framework-managed server processes.
- Acceptance criteria:
  - Spawn mode starts a configured command, detects readiness, and exposes the resolved URL.
  - Attach mode validates that the configured URL is reachable before the session becomes ready.
  - Unsupported or malformed dev-server specs are rejected with structured config or runtime errors.
- Test vectors: `TV-SESSION-001`, `TV-SESSION-002`
- Notes: Managed spawn mode SHOULD support Vite-style readiness messages and configurable regex readiness patterns.

## Requirement

- ID: `DEV-002`
- Priority: `P0`
- Statement: The dev-server manager MUST persist stdout and stderr separately, detect early exits and readiness timeouts, and label restarts or hot-reload instability in the run metadata.
- Rationale: Reliable debugging requires dev-server output and lifecycle evidence, not just browser events.
- Acceptance criteria:
  - Stdout and stderr are captured into separate append-only sinks.
  - Early process exit before readiness emits `E_DEVSERVER_EXIT_EARLY`.
  - Readiness timeout emits `E_DEVSERVER_START_TIMEOUT`.
  - Server restarts or instability are recorded in the run or checkpoint metadata.
- Test vectors: `TV-SESSION-001`, `TV-DETERMINISM-002`
- Notes: Websocket reconnect chatter MUST NOT be misclassified as page console output.

## Requirement

- ID: `SESSION-001`
- Priority: `P0`
- Statement: The core orchestrator MUST create a run manifest, maintain at most one active run per session, and finalize manifests on clean shutdown or failure.
- Rationale: Agents need a durable run boundary that anchors all artifacts and reports.
- Acceptance criteria:
  - Starting a session writes a run manifest with session ID, run ID, mode, browser, deterministic settings, and artifact root.
  - Starting a second active run for the same session returns `E_SESSION_ALREADY_RUNNING`.
  - Stopping or failing a run finalizes status and timestamps in the manifest.
- Test vectors: `TV-SESSION-001`, `TV-STORAGE-001`
- Notes: The framework MAY create a new session for each CLI invocation, but the one-active-run rule still applies per session ID.

## Requirement

- ID: `BROWSER-001`
- Priority: `P0`
- Statement: The browser runner MUST launch Playwright Chromium and SHOULD support Firefox and WebKit through the same public API and run manifest shape.
- Rationale: The framework is Playwright-based and needs a stable engine abstraction.
- Acceptance criteria:
  - Chromium sessions launch successfully through the browser-runner package.
  - The selected browser engine is persisted in the run manifest and checkpoint metadata.
  - Unsupported engines are rejected before browser launch.
- Test vectors: `TV-BROWSER-001`, `TV-CONFIG-001`
- Notes: Chromium support is mandatory; Firefox and WebKit support may arrive later without changing the public surface.

## Requirement

- ID: `NAV-001`
- Priority: `P0`
- Statement: The action engine MUST execute deterministic actions using explicit selectors, roles, labels, or test IDs before any semantic or visual fallback is attempted.
- Rationale: Deterministic browser control is the reliability anchor of the whole system.
- Acceptance criteria:
  - Explicit locator actions are executed directly against Playwright locators.
  - Deterministic actions fail with `E_ACTION_TARGET_NOT_FOUND` when no target matches.
  - Deterministic actions fail with `E_ACTION_NOT_INTERACTABLE` when the target exists but cannot be acted on safely.
- Test vectors: `TV-ACTION-001`, `TV-ACTION-004`
- Notes: Explicit selector precedence MUST be preserved even when a semantic query is also supplied.

## Requirement

- ID: `NAV-002`
- Priority: `P0`
- Statement: Semantic navigation MUST resolve user-intent queries through the page model using roles, accessible names, labels, visible text, and stable locator hints.
- Rationale: Agents need natural-language navigation without losing structural grounding.
- Acceptance criteria:
  - A unique, interactable match can be resolved from a semantic query without raw selectors.
  - The resolution result returns element metadata and locator hints.
  - Ambiguous results fail with `E_ACTION_AMBIGUOUS`.
- Test vectors: `TV-ACTION-002`, `TV-ACTION-003`
- Notes: Semantic resolution MUST prefer accessible semantics over raw text-only heuristics.

## Requirement

- ID: `NAV-003`
- Priority: `P0`
- Statement: Vision assistance MUST only rank or disambiguate candidate targets and MUST require DOM or accessibility confirmation before any interactive action executes.
- Rationale: Screenshot-only clicking is too unreliable for debugging and automated design review.
- Acceptance criteria:
  - Vision-assisted flows still return a confirmed element ID before action dispatch.
  - If a visually plausible region lacks structural confirmation, the action is rejected.
  - The action result records whether vision assistance was used.
- Test vectors: `TV-ACTION-004`, `TV-ACTION-003`
- Notes: Vision MAY still be used for non-interactive clipping or layout analysis.

## Requirement

- ID: `SNAP-001`
- Priority: `P0`
- Statement: Each checkpoint MUST capture a screenshot, DOM snapshot, accessibility snapshot, and layout metadata, and MUST only commit its checkpoint manifest after all required artifacts are present.
- Rationale: Debugging and design review depend on a complete evidence bundle, not partial captures.
- Acceptance criteria:
  - A created checkpoint writes all required artifact files.
  - The checkpoint manifest references only successfully written required artifacts.
  - Capture failures return `E_CHECKPOINT_CAPTURE_FAILED` and do not leave a committed partial checkpoint manifest.
- Test vectors: `TV-CHECKPOINT-001`, `TV-STORAGE-001`
- Notes: Optional artifacts such as styles, video, and trace links MAY be omitted when not requested.

## Requirement

- ID: `EVENT-001`
- Priority: `P0`
- Statement: The framework MUST persist browser console events, page errors, failed requests, response failures, dev-server stdout, and dev-server stderr as append-only structured event sinks.
- Rationale: Agents need raw evidence streams to inspect actual runtime behavior.
- Acceptance criteria:
  - Browser-originated console, page-error, and network events are persisted with timestamps and source labels.
  - Dev-server stdout and stderr are persisted separately from browser events.
  - Event sinks append new entries without rewriting existing events.
- Test vectors: `TV-EVENT-001`, `TV-STORAGE-001`
- Notes: NDJSON is the required on-disk persistence format.

## Requirement

- ID: `EVENT-002`
- Priority: `P0`
- Statement: Action and checkpoint results MUST include a delta summary of newly observed console errors, page errors, network failures, and generated checkpoint IDs.
- Rationale: Agents need compact summaries after each action without rereading the entire evidence store.
- Acceptance criteria:
  - A successful action response includes counts or IDs for newly added runtime events.
  - A checkpoint response includes the created checkpoint ID and any analyzer warnings.
  - A no-change action still returns explicit zero-value deltas.
- Test vectors: `TV-DELTA-001`, `TV-CHECKPOINT-001`
- Notes: Delta summaries supplement but do not replace access to raw sinks.

## Requirement

- ID: `STORAGE-001`
- Priority: `P0`
- Statement: The artifact store MUST write repository-relative, run-scoped directories for manifests, checkpoints, events, diffs, reports, and traces.
- Rationale: Agents and humans need predictable evidence locations that can be cited and replayed.
- Acceptance criteria:
  - Every run is written under a unique run directory beneath `.artifacts/runs/`.
  - Manifests, checkpoints, and reports reference repository-relative paths only.
  - Event sinks and checkpoint artifacts are grouped under the owning run directory.
- Test vectors: `TV-STORAGE-001`, `TV-REPORT-001`
- Notes: The physical root MAY be configurable, but manifest paths MUST remain repository-relative.

## Requirement

- ID: `STORAGE-002`
- Priority: `P1`
- Statement: The storage system MUST enforce configurable artifact and event caps and MUST fail or roll over explicitly instead of silently truncating evidence.
- Rationale: Local-first storage needs predictable limits without hiding lost evidence.
- Acceptance criteria:
  - Exceeding the configured artifact-volume cap returns `E_STORAGE_CAP_EXCEEDED` or an explicit rollover warning.
  - Exceeding event caps creates a labeled rollover sink or returns a structured error.
  - Silent truncation without a warning or error never occurs.
- Test vectors: `TV-LIMITS-001`, `TV-STORAGE-001`
- Notes: Cap defaults are defined in `SPEC.md` and MAY be overridden by config.

## Requirement

- ID: `DESIGN-001`
- Priority: `P0`
- Statement: The design analyzer MUST detect overflow, clipping, overlap, spacing inconsistency, alignment inconsistency, and responsive layout issues across configured viewports.
- Rationale: The framework is required to help with design review, not just runtime debugging.
- Acceptance criteria:
  - Known-bad fixture pages surface structured findings for overflow, clipping, and overlap.
  - Responsive fixture pages surface findings when the layout breaks at mobile or tablet viewports.
  - Findings include severity, category, summary, and evidence references.
- Test vectors: `TV-DESIGN-001`, `TV-BASELINE-003`
- Notes: Severity policy MUST be consistent and documented.

## Requirement

- ID: `DESIGN-002`
- Priority: `P1`
- Statement: The design analyzer MUST detect design-token drift, missing focus visibility, undersized touch targets, and contrast-metadata issues when the relevant inputs are available.
- Rationale: Design quality includes consistency and accessibility-adjacent checks that are visible to users.
- Acceptance criteria:
  - Token drift is reported when computed styles deviate from the configured token map.
  - Missing visible focus state and undersized touch targets are surfaced as findings.
  - Absence of token configuration suppresses token-drift findings without failing the run.
- Test vectors: `TV-DESIGN-002`, `TV-DESIGN-001`
- Notes: Contrast metadata may use computed color values and text/background pairing heuristics rather than full WCAG certification logic.

## Requirement

- ID: `BASELINE-001`
- Priority: `P0`
- Statement: Baseline recording MUST persist checkpoint evidence under a baseline key that includes route identity, viewport tag, browser engine, color scheme, and deterministic settings.
- Rationale: Visual comparisons are only meaningful when baseline dimensions match exactly.
- Acceptance criteria:
  - Recording a baseline writes a baseline registry entry and links to the source checkpoint.
  - Baseline keys with mismatched dimensions are treated as distinct records.
  - Re-recording the same baseline key replaces or versions it according to documented policy.
- Test vectors: `TV-BASELINE-001`, `TV-BASELINE-003`
- Notes: The replacement policy MUST be deterministic and documented in code and docs.

## Requirement

- ID: `BASELINE-002`
- Priority: `P0`
- Statement: Baseline comparison MUST combine pixel diff and semantic/layout diff findings and MUST classify results by severity.
- Rationale: Pixel-only regressions are too noisy for agent-driven debugging and design review.
- Acceptance criteria:
  - Comparison generates a diff artifact and a machine-readable regression summary.
  - Missing elements, moved elements, and meaningful layout changes are surfaced as semantic or layout findings.
  - Missing baselines return `E_BASELINE_NOT_FOUND`.
- Test vectors: `TV-BASELINE-002`, `TV-BASELINE-003`
- Notes: Cosmetic low-threshold drift MAY be kept as low severity when no semantic meaning is detected.

## Requirement

- ID: `DEBUG-001`
- Priority: `P0`
- Statement: The correlation engine MUST generate evidence-backed root-cause hypotheses from actions, console/page/network events, and checkpoints, and MUST NOT assert unsupported causes.
- Rationale: The framework exists to help agents troubleshoot reliably instead of guessing.
- Acceptance criteria:
  - Hypotheses cite evidence event IDs and artifact paths.
  - Confidence scores are attached to hypotheses.
  - When evidence is insufficient, the report explicitly says the root cause is unresolved instead of inventing one.
- Test vectors: `TV-DEBUG-001`, `TV-REPORT-001`
- Notes: Hypotheses MAY be ranked, but unsupported speculation is prohibited.

## Requirement

- ID: `REPORT-001`
- Priority: `P0`
- Statement: The reporting system MUST export machine-readable JSON and human-readable Markdown reports containing run metadata, checkpoint indexes, findings, regressions, hypotheses, and artifact references.
- Rationale: Agents need machine-readable output and humans need concise evidence-backed summaries.
- Acceptance criteria:
  - JSON export is lossless relative to the stored run artifacts and analyzer results.
  - Markdown export summarizes key evidence and links all referenced artifacts by repository-relative path.
  - Reports exclude sensitive auth-profile payloads by default.
- Test vectors: `TV-REPORT-001`, `TV-SECURITY-001`
- Notes: Markdown reports MAY omit low-severity details if they remain available in the JSON export.

## Requirement

- ID: `AUTH-001`
- Priority: `P1`
- Statement: The framework MUST support saving and loading local auth profiles and MUST exclude those profiles from exported reports and baseline bundles by default.
- Rationale: Reproducible authenticated flows are necessary for debugging real applications safely.
- Acceptance criteria:
  - Auth profiles can be saved from an active session and loaded into a new session.
  - Missing profiles return `E_AUTH_PROFILE_NOT_FOUND`.
  - Report and baseline export commands omit auth-profile artifacts unless the user explicitly opts in.
- Test vectors: `TV-AUTH-001`, `TV-SECURITY-001`
- Notes: Credential entry UX itself is outside scope; saved browser state is the required persistence mechanism.

## Requirement

- ID: `SECURITY-001`
- Priority: `P0`
- Statement: The redaction pipeline MUST scrub authorization headers, cookies, secret-looking tokens, and dev-server environment leaks before any event, manifest, or report is persisted.
- Rationale: Local-first does not remove the need to avoid leaking sensitive data into artifacts.
- Acceptance criteria:
  - Sensitive values are replaced or masked in stored event sinks and reports.
  - Redaction metadata indicates that redaction occurred without exposing the original value.
  - Redaction failures return `E_REDACTION_FAILURE` rather than silently persisting secrets.
- Test vectors: `TV-SECURITY-001`, `TV-REPORT-001`
- Notes: A safe allowlist MAY preserve selected non-sensitive headers when explicitly configured.

## Requirement

- ID: `DETERMINISM-001`
- Priority: `P0`
- Statement: Deterministic mode MUST fix viewport, locale, timezone, color scheme, reduced motion, browser engine, and stability waits for the entire run.
- Rationale: Regression comparison and reproducible debugging depend on a controlled environment.
- Acceptance criteria:
  - The run manifest records all deterministic settings.
  - Regression-critical screenshots are captured only after configured stability conditions are met.
  - Changing deterministic settings changes the baseline key dimensions.
- Test vectors: `TV-DETERMINISM-001`, `TV-BASELINE-001`
- Notes: Deterministic mode MAY be disabled for exploratory sessions, but baseline operations MUST still stamp the effective settings.

## Requirement

- ID: `DETERMINISM-002`
- Priority: `P1`
- Statement: Analyzers MUST label findings as unstable when app restarts, hot reload, animations, or unresolved loading states reduce confidence in the captured evidence.
- Rationale: Agent-facing design/debug reports must distinguish reliable failures from transient noise.
- Acceptance criteria:
  - Unstable runs or checkpoints carry instability metadata.
  - Findings produced during instability include an unstable marker or reduced confidence.
  - Stable runs do not overuse the unstable label.
- Test vectors: `TV-DETERMINISM-002`, `TV-DESIGN-001`
- Notes: Instability labeling supplements, but does not replace, normal findings.

## Requirement

- ID: `ERROR-001`
- Priority: `P0`
- Statement: All framework failures MUST use canonical structured error envelopes with stable error codes, messages, retryability flags, and diagnostic details.
- Rationale: Agents need machine-readable failures to plan recovery steps.
- Acceptance criteria:
  - CLI JSON output emits the canonical error envelope on failures.
  - MCP tools surface equivalent logical error fields.
  - Unknown internal failures map to `E_INTERNAL` rather than leaking raw stack traces into user-facing envelopes.
- Test vectors: `TV-CLI-001`, `TV-MCP-001`
- Notes: Internal stack traces MAY still be stored in a framework log sink for debugging.

## Requirement

- ID: `OBS-001`
- Priority: `P1`
- Statement: The framework MUST record Playwright traces for runs and MUST link trace artifacts from exported reports.
- Rationale: Trace replay is a key evidence source for debugging complex browser issues.
- Acceptance criteria:
  - Runs configured for tracing persist a trace artifact under the run directory.
  - Reports reference the trace artifact path.
  - Missing trace artifacts are reported explicitly instead of referenced blindly.
- Test vectors: `TV-OBS-001`, `TV-REPORT-001`
- Notes: Video capture is optional; trace capture is the mandatory replay artifact.

## Requirement

- ID: `TEST-001`
- Priority: `P0`
- Statement: The repository MUST include deterministic fixture applications and golden-vector tests that cover every `MUST` requirement in this specification.
- Rationale: The spec requires local verification for every phase and no hidden behavior.
- Acceptance criteria:
  - The fixture suite includes healthy, broken-design, regression, console-error, network-failure, and authenticated scenarios.
  - Each `MUST` requirement references at least one positive and one negative test vector.
  - A single repo-root command executes the golden-vector suite locally.
- Test vectors: `TV-FIXTURE-001`, `TV-DESIGN-001`
- Notes: Fixtures MAY be lightweight React/Vite apps and static HTML cases as long as behavior is deterministic.

## Requirement

- ID: `DOC-001`
- Priority: `P2`
- Statement: The repository MUST include operator documentation for local setup, dev-server integration, artifact interpretation, baseline workflow, and MCP/CLI consumption by coding agents.
- Rationale: The framework only succeeds if agents and humans can use it consistently.
- Acceptance criteria:
  - Repo-root docs cover installation, config, and basic session lifecycle.
  - Docs explain how artifacts are laid out and how reports map to stored evidence.
  - Docs explain how coding agents should consume MCP tools and how humans should consume CLI JSON.
- Test vectors: `TV-FIXTURE-001`, `TV-MCP-001`
- Notes: Documentation examples MUST use repository-relative paths and repo-root commands only.
