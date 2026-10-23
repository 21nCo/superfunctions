# Phase goal

Extend the PlugFn GitHub provider to satisfy Conduct's issue, PR, and review workflows.

# In scope / Out of scope

- **In scope**: new GitHub actions, comment/closure triggers, tests, docs.
- **Out of scope**: ClickUp provider and ready-package harnesses.

# Deliverables

- `/Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src/providers/github/*`
- `/Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/tests/providers/github/*`
- `/Users/serro/Documents/dev/n/superfunctions/plugfn/docs/*`

# Requirements covered

- GH-001
- DOCS-001

# Implementation tasks

- [ ] Add `issues.get` and `issues.update`.
- [ ] Add `pulls.create` and `pulls.createReview`.
- [ ] Add verified `pull_request.closed` and `issue_comment.created` triggers.
- [ ] Update provider documentation with public examples.

# Verification steps

1. Run GitHub provider tests.
   Expected: issue and PR action fixtures pass.
2. Run webhook verification tests for PR closed and issue comment events.
   Expected: verified payloads emit the expected trigger names.

# Stop condition

Report final GitHub provider capability coverage before Phase 04 starts.
