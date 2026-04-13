# Phase goal

Implement the parser-agnostic runner and normalized exit behavior for CLI actions.

# In scope / Out of scope

- In scope:
  - `clifn/runner`
  - action context construction
  - normalized error handling
  - deterministic exit codes
  - injected IO support
- Out of scope:
  - parser-specific command registration
  - config discovery
  - subprocess implementation details

# Deliverables

- Create `clifn/core/src/runner.ts`
- Modify `clifn/core/src/index.ts`
- Create `clifn/core/tests/runner.test.ts`

# Requirements covered

- `RUN-001`
- `RUN-002`
- `OBS-001`

# Implementation tasks

- Define the runner options and runner context interfaces.
- Construct runner context with output, diagnostics sink, cwd, env, and non-interactive state.
- Normalize uncaught errors into deterministic exit behavior.
- Preserve machine-readable mode invariants so JSON output is not polluted by extra human-readable lines.
- Make the runner independent of any parser library.
- Add tests for success, handled failure, thrown error, injected IO, and JSON-mode behavior.

# Verification steps

- Run `npm run test -- --filter=clifn -- runner`
- Expected outcomes:
  - runner returns deterministic exit codes
  - JSON mode remains machine-readable
  - parser-specific dependencies are absent from runner implementation

# Stop condition

Stop after generic action execution works without binding to one parser.

