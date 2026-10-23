# Requirement IDs

- PLUG-001
- LIN-001
- GH-001
- CLICKUP-001
- CLIFN-001
- READY-001
- SCHEMA-001
- WORKSPACE-001
- TEST-001
- DOCS-001

## PLUG-001

- **Priority**: P0
- **Statement**: Superfunctions MUST provide Conduct's PM integration capabilities through PlugFn providers and shared runtimes rather than Conduct-specific integration abstractions.
- **Rationale**: The dependency audit explicitly makes PlugFn the integration runtime and removes the need for custom Conduct OAuth/webhook stacks.
- **Acceptance criteria**:
  - Conduct can obtain required PM behaviors through PlugFn public actions/triggers.
  - No Conduct-only provider forks or private action names are introduced.
  - Shared runtime behaviors such as retries, rate limiting, and webhook verification remain inside PlugFn.
- **Test vectors**: TV-PLUG-001
- **Notes**: Workflow orchestration remains in Conduct; reusable provider surface area belongs in Superfunctions.

## LIN-001

- **Priority**: P0
- **Statement**: The PlugFn Linear provider MUST add single-issue read, comment creation, issue search, and update/comment webhook triggers sufficient for Conduct's outbound and inbound Linear workflows.
- **Rationale**: Conduct depends on fetching issue details, posting spec/phase comments, searching related issues, and receiving issue/comment updates.
- **Acceptance criteria**:
  - `issues.get`, `comments.create`, and `issues.search` are implemented and documented.
  - Webhook triggers cover issue updates and issue comment creation or equivalent mention-detection input.
  - Signature verification remains enforced for incoming Linear events.
- **Test vectors**: TV-LIN-001
- **Notes**: Existing BotFn Linear queries may be adapted, but the resulting provider contract must remain PlugFn-native.

## GH-001

- **Priority**: P0
- **Statement**: The PlugFn GitHub provider MUST add issue read/update, pull-request creation/review actions, and the webhook triggers needed for review-complete and comment-driven Conduct workflows.
- **Rationale**: Conduct needs to create PRs, post audit reviews, fetch/update issues, and react to comment or PR-closure events.
- **Acceptance criteria**:
  - `issues.get`, `issues.update`, `pulls.create`, and `pulls.createReview` are implemented.
  - `pull_request.closed` and `issue_comment.created` triggers are implemented and verified.
  - Public action schemas are typed and documented.
- **Test vectors**: TV-GH-001
- **Notes**: Existing GitHub issue creation/comment actions remain unchanged.

## CLICKUP-001

- **Priority**: P1
- **Statement**: PlugFn MUST add a new ClickUp provider with OAuth, core task/comment actions, and update/status-change triggers so Conduct can treat ClickUp as a first-class PM target.
- **Rationale**: The design makes ClickUp a first-class PM tool even though the current superfunctions repo has no provider yet.
- **Acceptance criteria**:
  - A new ClickUp provider package exists and registers with PlugFn.
  - `tasks.create`, `tasks.get`, `tasks.update`, `tasks.list`, `comments.create`, and `spaces.list` are implemented.
  - `task.updated` and `task.statusChanged` triggers exist with verified signatures.
- **Test vectors**: TV-CLICKUP-001
- **Notes**: This is sequenced after Linear/GitHub but remains fully in scope for the release train.

## CLIFN-001

- **Priority**: P0
- **Statement**: Superfunctions MUST add a reusable `clifn` package that provides credential storage, project config, authenticated HTTP client behavior, styled UI, JSON stdio helpers, and interactive prompts.
- **Rationale**: Conduct v0.3.0 should not ship one-off CLI infrastructure when the same primitives are reusable across the ecosystem.
- **Acceptance criteria**:
  - `clifn` exposes stable public subpaths for `credentials`, `config`, `client`, `ui`, `stdio`, and `prompt`.
  - The package fits repo conventions and workspace rules.
  - Conduct can consume the package without private imports.
- **Test vectors**: TV-CLIFN-001
- **Notes**: Conduct may incubate APIs inline first, but the superfunctions deliverable is the extracted package.

## READY-001

- **Priority**: P0
- **Statement**: Packages classified as ready in the dependency audit MUST be validated through Conduct-specific dependency harnesses and MUST remain unchanged unless a verified gap is found.
- **Rationale**: The repo should avoid churn and duplication while still proving that the existing packages satisfy Conduct's needs.
- **Acceptance criteria**:
  - Harnesses exercise `@superfunctions/db`, `@superfunctions/storage-s3`, `@superfunctions/webhooks`, `@superfunctions/queue`, `@superfunctions/http`, `@superfunctions/auth`, `@superfunctions/config`, `@superfunctions/errors`, `@superfunctions/envelope`, and `@superfunctions/middleware`.
  - Any proposed code change to a ready package cites a reproducible failing harness.
  - Conduct examples use public APIs only.
- **Test vectors**: TV-READY-001
- **Notes**: "Ready" does not mean "untested"; it means "verified before modification."

## SCHEMA-001

- **Priority**: P1
- **Statement**: Superfunctions MUST support Conduct's composite-index and CHECK-constraint schema needs either through `@superfunctions/cli` enhancements or a documented direct Drizzle fallback that is covered by tests.
- **Rationale**: The dependency audit identified a real gap, but also a viable workaround; the important requirement is that Conduct is never blocked.
- **Acceptance criteria**:
  - Conduct can declare its unique constraints and CHECK constraints in a supported way.
  - If `@superfunctions/cli` remains unchanged, a direct Drizzle fallback path is documented and tested.
  - The supported path is referenced in Conduct examples or package docs.
- **Test vectors**: TV-SCHEMA-001
- **Notes**: This requirement does not force `@superfunctions/cli` codegen changes if the documented fallback is solid.

## WORKSPACE-001

- **Priority**: P0
- **Statement**: New package placement, naming, and workspace wiring for Conduct dependencies MUST follow the monorepo conventions in `AGENTS.md`.
- **Rationale**: The new dependency work should strengthen repo coherence, not add ad hoc layouts.
- **Acceptance criteria**:
  - `clifn` is added through a workspace-compatible function package layout.
  - Root `package.json` workspaces are updated accordingly.
  - No nested monorepo or duplicate shared primitives are introduced.
- **Test vectors**: TV-WORKSPACE-001
- **Notes**: The exact subfolder may vary, but it must follow the repo's established function-package structure.

## TEST-001

- **Priority**: P0
- **Statement**: Superfunctions MUST ship automated tests and examples that prove Conduct can consume the new and existing dependency surfaces locally.
- **Rationale**: Conduct depends on shared packages at runtime, so the dependency layer needs executable proof, not just docs.
- **Acceptance criteria**:
  - New provider actions/triggers have unit tests and webhook verification tests.
  - `clifn` has unit tests for each submodule.
  - At least one Conduct-oriented integration harness/example exercises the dependency graph locally.
- **Test vectors**: TV-TEST-001
- **Notes**: The harness may live in package tests, examples, or both.

## DOCS-001

- **Priority**: P1
- **Statement**: Superfunctions MUST update package READMEs, docs, and changelog notes for all new dependency capabilities delivered for Conduct v0.3.0.
- **Rationale**: Shared packages need reusable, public documentation rather than private institutional knowledge in the Conduct repo.
- **Acceptance criteria**:
  - `clifn` includes a README with API examples.
  - Updated PlugFn provider docs show the new actions/triggers.
  - Any Conduct-facing examples use public package imports and avoid Conduct-private coupling.
- **Test vectors**: TV-DOCS-001
- **Notes**: This is shared-package documentation, not Conduct product documentation.
