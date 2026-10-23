# Phase goal

Add the ClickUp provider and validate the Conduct compatibility matrix for Slack and the packages already marked ready.

# In scope / Out of scope

- **In scope**: ClickUp provider implementation, ready-package dependency harnesses, Slack outbound compatibility checks.
- **Out of scope**: final docs/changelog pass and schema fallback hardening.

# Deliverables

- `/Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/providers/clickup/*`
- `/Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/tests/providers/clickup/*`
- Conduct dependency harness files under the relevant package test/example directories

# Requirements covered

- CLICKUP-001
- READY-001
- TEST-001

# Implementation tasks

- [ ] Implement the ClickUp provider using the existing provider pattern.
- [ ] Add OAuth configuration, actions, and triggers for ClickUp.
- [ ] Build a dependency harness proving the ready packages work unchanged for Conduct.
- [ ] Validate that Slack outbound notifications do not require provider changes for v0.3.

# Verification steps

1. Run ClickUp provider tests.
   Expected: actions and verified triggers pass.
2. Run the Conduct dependency harness.
   Expected: ready packages pass without code changes or produce precise failure evidence.

# Stop condition

Report ClickUp provider status and any proven gaps in ready packages before Phase 05 begins.
