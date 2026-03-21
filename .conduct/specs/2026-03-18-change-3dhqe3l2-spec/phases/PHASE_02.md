# Phase goal

Extend the PlugFn Linear provider to satisfy Conduct's outbound and inbound Linear workflows.

# In scope / Out of scope

- **In scope**: new Linear actions, update/comment triggers, tests, docs.
- **Out of scope**: GitHub and ClickUp provider work.

# Deliverables

- `/Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/providers/linear/*`
- `/Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/tests/providers/linear/*`
- `/Users/serro/Documents/dev/n/superfunctions/plugfn/docs/*`

# Requirements covered

- LIN-001
- DOCS-001

# Implementation tasks

- [ ] Add `issues.get`, `comments.create`, and `issues.search`.
- [ ] Add verified triggers for issue updates and issue comments.
- [ ] Reuse existing query knowledge where helpful without leaking BotFn-private abstractions.
- [ ] Document the new action and trigger contracts.

# Verification steps

1. Run Linear provider unit tests.
   Expected: all new actions pass with fixture responses.
2. Run webhook verification tests for update/comment events.
   Expected: only signed payloads emit triggers.

# Stop condition

Report the final action/trigger names and sample payloads before Phase 03.
