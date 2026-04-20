# Metadata

- timestamp: `2026-04-15T12:43:55Z`
- agent_name: `codex`
- model: `gpt-5`
- launcher: `Codex Desktop`
- workspace path: `repo root`
- OS: `Darwin arm64`
- shell: `zsh`
- repo metadata: `git branch=main; commit=none yet; dirty=true`
- spec_folder: `2026-04-15-new-384qfawh-spec`
- spec path: `.conduct/specs/2026-04-15-new-384qfawh-spec`
- spec_type: `new`
- spec_id: `384qfawh`
- input paths:
  - `Codex thread user prompt and follow-up clarifications`
  - `External doc: Stagehand v3 introduction`
  - `External doc: Stagehand Playwright integration`
  - `External doc: Eko architecture`
  - `External doc: Eko browser agent`
  - `External doc: Eko web extraction`
  - `External doc: Playwright introduction`
  - `External doc: Playwright MCP`
  - `External doc: Playwright coding agents CLI`
  - `External doc: Playwright Trace Viewer`
  - `External doc: Playwright ConsoleMessage API`

# Overview

## Project name

`probefn` is the working repository and framework name for a local-first browser evidence system that coding agents and human developers can use to drive web applications, inspect runtime evidence, review design quality, and detect visual regressions without guessing root causes.

## One-sentence goal

The system MUST provide a deterministic, evidence-first local framework that lets coding agents operate browser-based web applications through Playwright-backed automation, capture complete debugging and design evidence, and report reproducible findings through MCP and CLI interfaces.

## Target users

- coding agents such as Codex, Claude Code, and other MCP-capable assistants
- human developers debugging local web applications
- frontend engineers reviewing design quality and visual regressions
- QA and product engineers validating critical flows against local fixture apps and real dev servers

## Target environments

- runtime: Node.js 22 LTS or newer
- operating systems: macOS and Linux MUST be supported; Windows compatibility SHOULD be preserved where Playwright supports it
- browser execution: Playwright-backed Chromium MUST be supported; Firefox and WebKit MAY be enabled through the same public API
- connectivity: the framework MUST run fully offline except when the target application itself requires network access
- target applications: local development servers, static preview servers, and already-running browser-accessible web apps

## Assumptions

- the framework is local-first only; there is no hosted control plane, shared SaaS dashboard, or mandatory remote storage
- the implementation stack is TypeScript, Node.js, Playwright, and Turborepo
- the monorepo package manager is `pnpm`
- the framework owns a dedicated artifact root inside the repository by default at `.artifacts/`
- local authentication reuse is required, but shared team identity management is not required

# Glossary

- `Session`: a long-lived orchestration context that binds browser state, config, artifact roots, and event sinks
- `Run`: a single execution attempt inside a session, usually mapping to one debug/design/regression pass
- `Checkpoint`: a named capture point that freezes evidence artifacts and analyzer results at a point in time
- `Evidence bundle`: the complete set of artifacts, events, findings, and metadata attached to a run or checkpoint
- `Deterministic mode`: a capture mode that constrains viewport, locale, timezone, motion, browser settings, and wait semantics to reduce nondeterminism
- `Page model`: a normalized representation of visible and interactable UI elements produced from DOM, accessibility, layout, and screenshot context
- `Semantic action`: an action expressed in user intent terms such as “click the Save button” rather than a raw selector
- `Vision assist`: screenshot-based ranking or disambiguation used only after structural discovery has produced candidate targets
- `Design finding`: a structured issue describing layout, spacing, contrast, clipping, responsive, hierarchy, or token-consistency problems
- `Regression finding`: a structured difference between a baseline checkpoint and a current checkpoint, derived from pixel, layout, and semantic comparisons
- `Root-cause hypothesis`: an evidence-backed explanation generated from correlated runtime events and checkpoints
- `Auth profile`: locally stored browser state used to reproduce authenticated flows without re-entering credentials every run

# Goals / Non-goals

## Goals

- The framework MUST expose a stable CLI and MCP tool surface that coding agents can consume directly.
- The framework MUST integrate with running or managed local dev servers, including Vite-style startup output and hot reload behavior.
- The framework MUST navigate web pages through deterministic selectors first, semantic actions second, and screenshot-based assistance only as a confirmation or ranking layer.
- The framework MUST capture screenshots, DOM snapshots, accessibility snapshots, layout metadata, console logs, page errors, network failures, dev-server logs, and Playwright traces.
- The framework MUST produce structured design audits and visual regression reports that cite exact artifacts.
- The framework MUST persist artifacts locally with deterministic metadata and append-only event streams.
- The framework MUST let agents debug by evidence, not by free-form speculation.

## Non-goals

- The system does NOT include a hosted multi-user dashboard, cloud sync, or team RBAC.
- The system does NOT include generalized autonomous web browsing across arbitrary hostile or anti-bot sites.
- The system does NOT replace Playwright; it composes on top of Playwright as the deterministic executor.
- The system does NOT attempt to solve CAPTCHA or bypass hard anti-automation barriers.

# Public API

## Repository/package layout

The implementation MUST use a Turborepo monorepo with the following packages and surfaces:

- `apps/cli`: the `probefn` executable and human-oriented terminal UX
- `packages/contracts`: canonical schemas, types, error codes, event envelopes, and config types
- `packages/core`: orchestrator, session lifecycle, checkpoint coordination, and report assembly
- `packages/browser-runner`: Playwright adapter, page model builder, and browser event capture
- `packages/dev-server`: managed-process lifecycle, readiness detection, and dev-server log capture
- `packages/analyzers`: design audit rules, regression analysis, and root-cause correlation
- `packages/storage`: artifact writer, retention, baseline registry, and redaction pipeline
- `packages/mcp-server`: MCP tool handlers and streaming bridge
- `packages/visual-baselines`: baseline record/compare logic and diff artifact generation
- `packages/session-reporter`: machine-readable and human-readable report emitters

## TypeScript public types

```ts
export type SessionMode = 'debug' | 'design-review' | 'visual-regression' | 'mixed';
export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';
export type DevServerMode = 'attach' | 'spawn';
export type ArtifactKind =
  | 'screenshot'
  | 'dom'
  | 'ax'
  | 'layout'
  | 'styles'
  | 'trace'
  | 'video'
  | 'console'
  | 'page-error'
  | 'network'
  | 'devserver-stdout'
  | 'devserver-stderr'
  | 'report'
  | 'diff-image'
  | 'diff-json'
  | 'clip';

export interface ProbefnConfig {
  schemaVersion: '1.0';
  projectName?: string;
  artifactRoot?: string;
  baselineRoot?: string;
  defaultBrowser?: BrowserEngine;
  defaultMode?: SessionMode;
  devServers?: Record<string, DevServerSpec>;
  analyzers?: AnalyzerPolicy;
  redaction?: RedactionPolicy;
  deterministicDefaults?: DeterministicSettings;
}

export interface DevServerSpec {
  mode: DevServerMode;
  name: string;
  command?: string;
  cwd?: string;
  url?: string;
  readyPattern?: string;
  timeoutMs?: number;
  envAllowlist?: string[];
}

export interface DeterministicSettings {
  enabled: boolean;
  viewport: { width: number; height: number };
  locale: string;
  timezone: string;
  colorScheme: 'light' | 'dark';
  reducedMotion: 'reduce' | 'no-preference';
  animationPolicy: 'freeze' | 'allow';
  networkIdleMs: number;
}

export interface StartSessionInput {
  schemaVersion: '1.0';
  configPath?: string;
  mode: SessionMode;
  browser: BrowserEngine;
  devServer?: DevServerSpec;
  authProfileId?: string;
  deterministic?: Partial<DeterministicSettings>;
  tags?: string[];
}

export interface SessionHandle {
  sessionId: string;
  runId: string;
  artifactRoot: string;
  startedAt: string;
}

export interface OpenPageInput {
  sessionId: string;
  url: string;
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle';
}

export interface FindElementInput {
  sessionId: string;
  query: string;
  strategy?: 'auto' | 'role' | 'label' | 'text' | 'testid' | 'css';
  maxResults?: number;
}

export interface PageActionInput {
  sessionId: string;
  action:
    | { kind: 'click'; target: ActionTarget }
    | { kind: 'fill'; target: ActionTarget; value: string }
    | { kind: 'press'; key: string }
    | { kind: 'hover'; target: ActionTarget }
    | { kind: 'select'; target: ActionTarget; option: string }
    | { kind: 'goto'; url: string };
  checkpointAfter?: 'none' | 'action' | 'milestone';
}

export interface ActionTarget {
  elementId?: string;
  query?: string;
  selector?: string;
  requireDomConfirmation?: boolean;
}

export interface CheckpointInput {
  sessionId: string;
  name: string;
  includeTrace?: boolean;
  includeVideo?: boolean;
  includeStyles?: boolean;
}

export interface DesignAuditInput {
  sessionId: string;
  checkpointId?: string;
  viewportTags?: string[];
}

export interface BaselineRecordInput {
  sessionId: string;
  checkpointId: string;
  baselineKey: string;
}

export interface BaselineCompareInput {
  sessionId: string;
  checkpointId: string;
  baselineKey: string;
}

export interface ExportReportInput {
  sessionId: string;
  format: 'json' | 'markdown';
}
```

## CLI surface

The CLI MUST expose the following commands:

```text
probefn session start [--config path] [--mode debug|design-review|visual-regression|mixed] [--browser chromium|firefox|webkit] [--url URL | --dev-server NAME]
probefn session stop --session SESSION_ID
probefn page open --session SESSION_ID --url URL
probefn page find --session SESSION_ID --query "Save button" [--json]
probefn page act --session SESSION_ID --action click --query "Save button" [--checkpoint-after action] [--json]
probefn checkpoint create --session SESSION_ID --name NAME [--include-trace] [--include-video] [--json]
probefn audit design --session SESSION_ID [--checkpoint CHECKPOINT_ID] [--json]
probefn baseline record --session SESSION_ID --checkpoint CHECKPOINT_ID --key KEY [--json]
probefn baseline compare --session SESSION_ID --checkpoint CHECKPOINT_ID --key KEY [--json]
probefn report export --session SESSION_ID --format json|markdown
probefn auth profile save --session SESSION_ID --profile PROFILE_ID
probefn run flow --session SESSION_ID --file flows/example.yaml [--json]
probefn mcp serve [--stdio | --tcp PORT]
```

Human-readable CLI output MAY be concise, but `--json` MUST emit the canonical response envelope defined below.

## MCP tool surface

The MCP server MUST expose structured tools with one-to-one parity for core actions:

- `probefn_session_start`
- `probefn_session_stop`
- `probefn_page_open`
- `probefn_page_find`
- `probefn_page_act`
- `probefn_checkpoint_create`
- `probefn_page_get_console`
- `probefn_page_get_network`
- `probefn_page_get_page_errors`
- `probefn_page_get_layout_report`
- `probefn_page_design_audit`
- `probefn_baseline_record`
- `probefn_baseline_compare`
- `probefn_report_export`
- `probefn_run_flow`

Each MCP tool MUST accept and return the same canonical shapes as the internal TypeScript contracts, modulo MCP transport wrapping.

# Data formats / protocol

## Canonical success envelope

```json
{
  "ok": true,
  "schemaVersion": "1.0",
  "data": {},
  "warnings": []
}
```

## Canonical error envelope

```json
{
  "ok": false,
  "schemaVersion": "1.0",
  "error": {
    "code": "E_ACTION_AMBIGUOUS",
    "message": "Multiple interactable elements matched the provided query.",
    "retryable": true,
    "details": {
      "query": "Save button",
      "candidateCount": 2
    }
  }
}
```

## Canonical run manifest

```json
{
  "schemaVersion": "1.0",
  "sessionId": "sess_0001",
  "runId": "run_0001",
  "mode": "mixed",
  "browser": "chromium",
  "devServer": {
    "mode": "spawn",
    "name": "web",
    "url": "http://127.0.0.1:5173"
  },
  "deterministic": {
    "enabled": true,
    "viewport": { "width": 1440, "height": 900 },
    "locale": "en-US",
    "timezone": "UTC",
    "colorScheme": "light",
    "reducedMotion": "reduce",
    "animationPolicy": "freeze",
    "networkIdleMs": 500
  },
  "artifactRoot": ".artifacts/runs/2026-04-15T12-43-55Z_run_0001",
  "startedAt": "2026-04-15T12:43:55Z",
  "status": "running"
}
```

## Canonical checkpoint manifest

```json
{
  "schemaVersion": "1.0",
  "checkpointId": "chk_landing",
  "sessionId": "sess_0001",
  "runId": "run_0001",
  "name": "landing",
  "url": "http://127.0.0.1:5173/",
  "viewport": { "width": 1440, "height": 900 },
  "artifacts": [
    { "kind": "screenshot", "path": "checkpoints/landing/screenshot.png", "sha256": "sha-demo-1" },
    { "kind": "dom", "path": "checkpoints/landing/dom.json", "sha256": "sha-demo-2" },
    { "kind": "ax", "path": "checkpoints/landing/ax.json", "sha256": "sha-demo-3" },
    { "kind": "layout", "path": "checkpoints/landing/layout.json", "sha256": "sha-demo-4" }
  ],
  "createdAt": "2026-04-15T12:44:10Z"
}
```

## Canonical event envelope

```json
{
  "schemaVersion": "1.0",
  "eventId": "evt_0001",
  "sessionId": "sess_0001",
  "runId": "run_0001",
  "checkpointId": "chk_landing",
  "ts": "2026-04-15T12:44:11.120Z",
  "source": "browser",
  "type": "console",
  "level": "error",
  "pageUrl": "http://127.0.0.1:5173/settings",
  "payload": {
    "text": "TypeError: Cannot read properties of undefined (reading 'plan')",
    "location": {
      "url": "http://127.0.0.1:5173/src/routes/settings.tsx",
      "lineNumber": 88,
      "columnNumber": 14
    }
  },
  "redactions": []
}
```

## Canonical page model

```json
{
  "schemaVersion": "1.0",
  "url": "http://127.0.0.1:5173/settings",
  "elements": [
    {
      "elementId": "el_save_button",
      "role": "button",
      "name": "Save",
      "text": "Save",
      "interactive": true,
      "visibility": "visible",
      "bounds": { "x": 1110, "y": 44, "width": 96, "height": 40 },
      "locatorHints": [
        { "strategy": "role", "value": "button[name=\"Save\"]" },
        { "strategy": "testid", "value": "save-button" }
      ]
    }
  ]
}
```

## Canonical finding shapes

```json
{
  "designFinding": {
    "findingId": "df_0001",
    "severity": "high",
    "category": "overflow",
    "summary": "Pricing grid overflows the viewport by 24px at 390px width.",
    "evidence": ["checkpoints/mobile/layout.json", "checkpoints/mobile/screenshot.png"],
    "elementIds": ["el_pricing_grid"]
  },
  "regressionFinding": {
    "findingId": "rf_0001",
    "severity": "critical",
    "category": "missing-element",
    "summary": "Primary CTA is absent in the current checkpoint but present in the baseline.",
    "evidence": ["diffs/home-mobile/diff.png", "checkpoints/home-mobile/dom.json"],
    "baselineKey": "home.mobile"
  },
  "hypothesis": {
    "hypothesisId": "rh_0001",
    "confidence": 0.87,
    "statement": "The Save button handler accesses a missing subscription plan object after the form submit.",
    "evidenceEventIds": ["evt_0044", "evt_0045"],
    "evidenceArtifacts": ["checkpoints/after-submit/console.ndjson", "browser.trace.zip"]
  }
}
```

# Semantics

## Session lifecycle

- A session MUST own exactly one active browser context and one active run at a time.
- Starting a session in `spawn` mode MUST create the dev-server process, watch for readiness, and fail with `E_DEVSERVER_START_TIMEOUT` or `E_DEVSERVER_EXIT_EARLY` if readiness is not achieved.
- Starting a session in `attach` mode MUST verify that the target URL is reachable before marking the session ready.
- Stopping a session MUST close the Playwright browser context, flush pending event buffers, finalize manifests, and terminate the managed dev server if Probefn spawned it.

## Dev-server integration

- Managed dev servers MUST stream stdout and stderr into separate append-only NDJSON sinks.
- Vite-like readiness text such as `Local:` or configurable regex patterns MUST be supported.
- Hot reload noise such as websocket reconnect chatter SHOULD be marked with `source=dev-server` and MUST NOT be misclassified as browser console errors.
- If the dev server restarts during a run, the run MUST be marked `unstable` and analyzer outputs MUST note the instability.

## Action resolution

- Deterministic selectors MUST be attempted before semantic or visual resolution.
- Semantic actions MUST search the page model by role, accessible name, label, visible text, and stable locator hints.
- Vision assistance MAY rank candidates or propose a candidate region, but the final interactive target MUST be confirmed against DOM or accessibility state before action execution.
- If more than one confirmed target remains, the action MUST fail with `E_ACTION_AMBIGUOUS`.
- If a target is found but is hidden, covered, disabled, or offscreen in a non-scrollable way, the action MUST fail with `E_ACTION_NOT_INTERACTABLE`.

## Checkpoints and evidence bundles

- Every checkpoint MUST capture a full-page screenshot, DOM snapshot, accessibility snapshot, and layout metadata.
- When requested, checkpoints MUST also capture computed style extracts, Playwright trace links, and video files.
- Checkpoint creation MUST be atomic at the manifest level: partial artifact writes MAY exist temporarily, but the checkpoint manifest MUST only be committed once all required artifacts are present.
- Each action MAY create an automatic checkpoint according to the configured checkpoint policy.

## Design audit semantics

- Design audit mode MUST operate over one or more checkpoints.
- The analyzer MUST evaluate overflow, clipping, overlap, spacing inconsistency, alignment inconsistency, focus visibility, touch-target size, contrast metadata, responsive wrap behavior, and design-token drift where a token map is configured.
- Findings MUST include severity, category, summary, artifact references, and implicated element IDs when known.
- The design analyzer MUST distinguish confirmed findings from unstable findings caused by ongoing animation, loading, or hot reload.

## Baseline and regression semantics

- A baseline key MUST uniquely bind route, viewport tag, browser engine, color scheme, and deterministic settings.
- Baseline recording MUST persist the source checkpoint manifest and analyzer summaries in the baseline registry.
- Baseline comparison MUST produce pixel diff artifacts and semantic/layout diff findings in the same run.
- Regressions MUST be reported as added, removed, or changed findings; cosmetic pixel drift without structural meaning MAY be reported as low severity when under threshold.

## Root-cause correlation

- Runtime event correlation MUST join console errors, page errors, request failures, recent actions, affected URLs, and nearby checkpoints.
- Hypotheses MUST cite evidence event IDs and artifact paths and MUST expose a confidence score.
- The report generator MUST never claim a root cause when no evidence backs the statement; unsupported guesses are prohibited.

## Auth profile semantics

- Saving an auth profile MUST persist local Playwright storage state with a profile identifier under the artifact root or configured sensitive-store root.
- Auth profiles MUST be excluded from report export and baseline export by default.
- Loading an auth profile MUST fail with `E_AUTH_PROFILE_NOT_FOUND` when the requested profile does not exist.

## Report semantics

- Session reports MUST be exportable as JSON and Markdown.
- JSON reports MUST be lossless for machine use.
- Markdown reports MUST summarize key failures, design findings, regressions, hypotheses, and direct artifact paths relative to repo root.
- Reports MUST include the run manifest, checkpoint index, error summary, and analyzer summary.

## Error codes and failure behavior

The framework MUST implement at least the following error codes:

- `E_CONFIG_INVALID`
- `E_SESSION_NOT_FOUND`
- `E_SESSION_ALREADY_RUNNING`
- `E_DEVSERVER_START_TIMEOUT`
- `E_DEVSERVER_EXIT_EARLY`
- `E_URL_UNREACHABLE`
- `E_BROWSER_LAUNCH_FAILED`
- `E_ACTION_TARGET_NOT_FOUND`
- `E_ACTION_AMBIGUOUS`
- `E_ACTION_NOT_INTERACTABLE`
- `E_CHECKPOINT_CAPTURE_FAILED`
- `E_BASELINE_NOT_FOUND`
- `E_BASELINE_MISMATCH`
- `E_AUTH_PROFILE_NOT_FOUND`
- `E_STORAGE_WRITE_FAILED`
- `E_STORAGE_CAP_EXCEEDED`
- `E_ANALYZER_FAILURE`
- `E_REDACTION_FAILURE`
- `E_MCP_INVALID_ARGS`
- `E_INTERNAL`

Each error response MUST use the canonical error envelope and MUST mark `retryable` accurately.

# Invariants

- Artifact paths MUST be repository-relative inside manifests and reports.
- Event sinks MUST be append-only; events MUST never be rewritten in place.
- Successive checkpoints within a run MUST preserve creation order.
- Deterministic mode MUST lock viewport, locale, timezone, color scheme, reduced motion, and browser engine for the run.
- When deterministic mode is enabled, the framework MUST inject motion suppression and wait for configured stability thresholds before taking regression-critical screenshots.
- Reports, analyzer outputs, and diff summaries MUST be reproducible from the persisted artifact set alone.
- Vision assistance MUST never bypass DOM or accessibility confirmation for interactive actions.
- Baseline comparisons MUST only compare checkpoints whose baseline key dimensions match exactly.
- Sensitive values MUST be redacted before being written into event sinks, reports, and analyzer outputs.

# Security

- The framework MUST default to local-only storage and MUST NOT require remote services.
- Console logs, request headers, request bodies, cookies, authorization headers, and dev-server env output MUST pass through the redaction pipeline before persistence.
- A configurable allowlist MAY preserve selected safe headers for debugging.
- Auth profiles MUST be treated as sensitive and MUST be excluded from exports unless the user explicitly opts in.
- MCP and CLI inputs MUST be validated against canonical schemas before execution.
- The framework MUST preserve repo-local relative paths and MUST NOT leak absolute host-specific paths into persisted artifacts.

# Limits/caps

- Default maximum artifact volume per run: `2 GiB`
- Default maximum console/page/network/dev-server events per sink before rollover: `50,000`
- Default maximum page-model results returned by a `find` call: `25`
- Default action timeout: `30,000 ms`
- Default page navigation timeout: `120,000 ms`
- Default dev-server readiness timeout: `120,000 ms`
- Default screenshot viewport tags shipped with fixtures: `desktop`, `tablet`, `mobile`
- Default DOM snapshot max depth: `250`
- Default diff pixel threshold for low-severity drift: `0.5%` of compared pixels

If a configurable cap is exceeded, the framework MUST fail gracefully with a structured error or mark the sink as rolled over with a warning; silent truncation is prohibited.

# Observability

- The framework MUST write run manifests, checkpoint manifests, event sinks, analyzer summaries, and report outputs under `.artifacts/`.
- Playwright traces MUST be recorded per run and linked from the report.
- Dev-server stdout and stderr MUST be written separately and surfaced to agents on demand.
- Action results MUST include deltas summarizing new console errors, new network failures, new page errors, and checkpoint references.
- The system MUST log its own internal warnings and failures to a framework log sink without mixing them into page-originated events.
- Observability outputs MUST omit redacted values and MUST label redaction counts where applicable.

# Compatibility / versioning strategy

- All persisted JSON documents MUST include `schemaVersion`.
- `1.x` schema versions MUST remain backward compatible for additive changes.
- Breaking changes to schemas, error envelopes, baseline keys, or MCP/CLI JSON output MUST increment the major schema version and include migration notes in the repository docs.
- CLI human-readable output MAY evolve, but `--json` output MUST remain stable within a schema major version.

# Undefined / Explicitly user-deferred only

- No user-deferred items were provided.
- Any behavior not explicitly specified in this document, REQUIREMENTS.md, TEST_VECTORS.md, PLAN.md, or the phase files is undefined and not required.
