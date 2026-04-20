# Architecture sketch

## Monorepo modules and responsibilities

- `apps/cli`
  - command parsing
  - human-readable and `--json` output
  - local config resolution
  - session lifecycle orchestration entrypoint
- `packages/contracts`
  - zod or equivalent schema definitions
  - canonical TypeScript types
  - error-code registry
  - manifest and event-envelope shapes
- `packages/core`
  - session state machine
  - run orchestration
  - checkpoint coordination
  - report assembly
- `packages/browser-runner`
  - Playwright browser/context/page lifecycle
  - action engine
  - page-model construction
  - trace and video wiring
- `packages/dev-server`
  - spawn/attach modes
  - readiness detection
  - stdout/stderr capture
  - restart and instability tracking
- `packages/storage`
  - artifact path planning
  - append-only event sink writer
  - retention and cap enforcement
  - redaction pipeline
- `packages/analyzers`
  - layout/design analyzers
  - semantic regression analyzers
  - runtime event correlation
- `packages/visual-baselines`
  - baseline registry
  - compare engine
  - diff artifact generation
- `packages/mcp-server`
  - MCP transport
  - tool handlers
  - tool-to-core adapters
- `packages/session-reporter`
  - JSON and Markdown report exporters
  - evidence link assembly
  - human-readable summaries
- `test/fixtures`
  - deterministic local fixture apps
  - golden artifact expectations
  - design and failure scenarios

## Dependency graph

1. `packages/contracts` MUST exist before any other package can compile.
2. `packages/storage` and `packages/dev-server` MUST exist before `packages/core` can finalize runs.
3. `packages/browser-runner` MUST exist before page-model generation, checkpoints, and analyzers can execute.
4. `packages/analyzers` and `packages/visual-baselines` MUST exist before full design/regression reports can ship.
5. `packages/core` MUST stabilize before CLI and MCP adapters are considered complete.
6. `apps/cli` and `packages/mcp-server` MUST share the same contracts and core orchestration paths.
7. `test/fixtures` MUST land before final hardening and full golden-vector verification.

# Phases overview

| Phase | Goal | Delivered capability | Verification method |
| --- | --- | --- | --- |
| `PHASE_00` | Establish monorepo foundation and canonical contracts | Turborepo root, package manifests, config loading, schema package skeleton | `pnpm install`, `pnpm turbo run typecheck` |
| `PHASE_01` | Implement artifact storage and redaction core | Run directory planner, manifests, event sink writer, redaction policy | package unit tests plus golden manifest snapshots |
| `PHASE_02` | Implement dev-server attach/spawn manager | Spawn/attach lifecycle, readiness detection, stdout/stderr sinks, instability flags | fixture Vite app smoke tests |
| `PHASE_03` | Implement browser runner and raw evidence capture | Playwright lifecycle, console/page/network capture, trace recording | headless fixture navigation plus artifact assertions |
| `PHASE_04` | Implement deterministic page model and structured action engine | Selector-first actions, page model extraction, atomic checkpoint creation | fixture interaction tests |
| `PHASE_05` | Implement semantic navigation and vision-assisted disambiguation | intent query resolution, vision ranking, DOM confirmation guardrail | ambiguous-target and visual-rank fixtures |
| `PHASE_06` | Implement design-audit analyzers | overflow/clipping/spacing/alignment/responsive/token findings | purpose-built broken-design fixtures |
| `PHASE_07` | Implement baseline registry and regression comparison | baseline record/compare, pixel diff, semantic diff, severity policy | baseline golden fixtures across viewports |
| `PHASE_08` | Implement root-cause correlation and report generation | evidence-backed hypotheses, JSON/Markdown reports | console/network failure fixtures |
| `PHASE_09` | Implement MCP server parity | stable MCP tools mirroring core actions and queries | MCP contract tests |
| `PHASE_10` | Implement full CLI UX and flow runner | command surface, JSON envelope parity, flow execution | CLI integration tests |
| `PHASE_11` | Implement auth profiles and sensitive-data guarantees | auth save/load, export exclusion, redaction hardening | authenticated fixture flow tests |
| `PHASE_12` | Final hardening, docs, and full vector verification | docs, cross-package polish, full fixture suite, performance caps | execute all vectors locally |

# Definition of Done

No phase is complete unless its verification steps pass.

# Execution sequencing notes

- The implementation MUST follow the phase order unless an earlier phase explicitly provides the required interfaces for safe parallel work.
- Multi-agent execution is allowed only when write scopes are disjoint and contracts are already frozen by earlier phases.
- Every phase MUST update or add tests and fixture expectations for the requirements it covers.
- Every phase MUST leave the repository in a locally verifiable state from repo root.
