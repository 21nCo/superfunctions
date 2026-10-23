# Metadata

- **timestamp**: 2026-03-18T07:03:15Z
- **agent_name**: unknown-agent
- **model**: gpt-5-codex
- **launcher**: Codex Desktop
- **workspace**: /Users/serro/Documents/dev/n/superfunctions
- **os**: Darwin 25.3.0 Darwin Kernel Version 25.3.0: Wed Jan 28 20:51:28 PST 2026; root:xnu-12377.91.3~2/RELEASE_ARM64_T6041 arm64
- **shell**: /bin/zsh
- **git.branch**: next
- **git.commit**: 6f9a47d6c5f8ac166932e0156efb910bf5e32652
- **git.dirty**: true
- **spec_folder**: 2026-03-18-change-3dhqe3l2-spec
- **spec_path**: /Users/serro/Documents/dev/n/superfunctions/.conduct/specs/2026-03-18-change-3dhqe3l2-spec
- **spec_type**: change
- **spec_id**: 3dhqe3l2
- **input_paths**:
  - /Users/serro/.codex/skills/spec/SKILL.md
  - /Users/serro/Documents/dev/n/superfunctions/AGENTS.md
  - /Users/serro/Documents/dev/n/conduct/.conduct/intent/conduct-v0.3.0-design.md
  - /Users/serro/Documents/dev/n/conduct/.conduct/intent/conduct-v0.3.0-design-recommendations.md
  - /Users/serro/Documents/dev/n/conduct/.conduct/intent/conduct-v0.3.0-backend-architecture.md
  - /Users/serro/Documents/dev/n/conduct/.conduct/intent/conduct-v0.3.0-superfunctions-dependencies.md
  - /Users/serro/Documents/dev/n/superfunctions/package.json

# Overview

## Project context

- **Project name**: Superfunctions dependencies for Conduct v0.3.0
- **One-sentence goal**: Deliver the Superfunctions package work that Conduct v0.3.0 depends on: PlugFn provider gaps, a reusable `clifn` runtime, compatibility validation for ready packages, and schema/workspace support that preserves monorepo conventions.
- **Target users**:
  - Superfunctions maintainers responsible for shared package evolution
  - Conduct maintainers consuming shared package capabilities
  - Future CLI and integration package authors that will reuse `clifn` and PlugFn providers
- **Target environments**:
  - npm workspace monorepo under `/Users/serro/Documents/dev/n/superfunctions`
  - TypeScript packages and tests
  - local development and CI using Turbo/npm
  - provider integrations executed through PlugFn in self-hosted and hosted Conduct deployments
- **Languages/packages required**:
  - TypeScript in `plugfn/*`, `packages/*`, and a new `clifn/*` function package
  - existing shared packages such as `@superfunctions/db`, `@superfunctions/http`, `@superfunctions/auth`, `@superfunctions/storage-s3`, `@superfunctions/webhooks`, `@superfunctions/queue`
- **Existing systems it must integrate with**:
  - Conduct backend, CLI, and MCP packages
  - PlugFn provider registry, OAuth flows, and webhook handlers
  - repo workspaces and Turbo build graph
- **Data model summary**:
  - provider action schemas and trigger payloads
  - `clifn` credential/profile/config/client abstractions
  - dependency validation harnesses proving ready-package compatibility
- **Security model**:
  - provider OAuth and webhook verification stay inside PlugFn
  - `clifn` handles local credentials/config but MUST not leak secrets in UI or logs
  - no Conduct package may bypass PlugFn to read raw PM credentials
- **Performance constraints**:
  - provider tests and dependency harnesses MUST run locally without external network dependence
  - `clifn` stdin/stdout helpers MUST stay deterministic for hook usage
  - new provider actions SHOULD fit current PlugFn middleware/retry patterns without custom per-provider execution stacks
- **Non-goals / out of scope**:
  - rewriting packages that the dependency audit already classifies as ready unless tests prove a real gap
  - adopting DataFn into Conduct v0.3.0
  - changing Conduct product semantics beyond what the shared packages expose
  - building a Slack interaction platform if Conduct can satisfy its v0.3 trigger needs elsewhere
- **Hard constraints**:
  - follow monorepo naming and workspace conventions from `AGENTS.md`
  - reuse existing shared packages instead of duplicating HTTP, DB, auth, webhook, or queue primitives
  - PlugFn remains the integration runtime; Conduct-specific provider logic is forbidden
  - new package placement must avoid nested monorepos and remain workspace-native

## Assumptions

1. `clifn` is implemented as a standard Superfunctions function package under `clifn/core` (or an equivalent subpackage path) even though the dependency note used a flat path example, because the monorepo conventions favor subpackages.
2. Slack outbound notifications are in scope, but inbound Slack slash-command handling is assumed to be solvable in Conduct without new Slack provider changes unless a verified implementation gap appears.
3. Packages marked "ready" in the dependency audit are verified through harnesses first and only changed if those harnesses reveal concrete blockers.

# Glossary

- **PlugFn provider**: A reusable integration adapter exposing named actions and webhook triggers behind PlugFn's core runtime.
- **Ready package**: A shared package already classified as sufficient for Conduct v0.3.0, subject only to compatibility verification.
- **CliFn**: A reusable CLI primitives runtime for credentials, project config, HTTP client behavior, UI, stdio, and prompts.
- **Dependency harness**: A focused integration test/example proving that a shared package satisfies Conduct's needs without forking or ad hoc patches.
- **Direct Drizzle fallback**: A schema definition path used when `@superfunctions/cli` code generation cannot yet express a required constraint or composite index.
- **Provider trigger**: A verified webhook event exposed by a PlugFn provider to downstream consumers.

# Goals / Non-goals

## Goals

1. Superfunctions MUST provide every reusable package capability that Conduct v0.3.0 depends on.
2. Provider changes MUST remain general-purpose and reusable outside Conduct.
3. The repo MUST gain a reusable CLI runtime package so Conduct does not fossilize one-off CLI infrastructure.
4. Existing ready packages MUST be proven compatible through tests/examples rather than reimplemented.

## Non-goals

- Embedding Conduct-specific business rules into shared packages.
- Reworking package families that the dependency audit does not rely on.
- Shipping speculative DataFn or search-based abstractions for Conduct v0.3.0.

# Public API

## `clifn` package surface

```ts
export declare function createCredentialStore(path?: string): CredentialStore;
export declare function createProjectConfig(path?: string): ProjectConfigStore;
export declare function createApiClient(config: ApiClientConfig): ApiClient;
export declare const ui: {
  success(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  spinner(message: string): Spinner;
  table(rows: Array<Record<string, string | number>>): void;
};
export declare function readJsonStdin<T>(): Promise<T>;
export declare function writeJsonStdout<T>(value: T): void;
export declare const prompt: {
  select<T extends string>(label: string, choices: T[]): Promise<T>;
  multiSelect<T extends string>(label: string, choices: T[]): Promise<T[]>;
  text(label: string, options?: { default?: string }): Promise<string>;
  confirm(label: string): Promise<boolean>;
};
```

## Linear provider additions

```ts
type LinearIssueGetInput = { issueId: string };
type LinearCommentCreateInput = { issueId: string; body: string };
type LinearIssueSearchInput = { teamId?: string; query: string; first?: number };
```

Required action names:

- `issues.get`
- `comments.create`
- `issues.search`

Required trigger names:

- `issue.updated`
- `issue_comment.created` or equivalent comment-created trigger name documented and stable

## GitHub provider additions

```ts
type GitHubIssueGetInput = { owner: string; repo: string; issueNumber: number };
type GitHubIssueUpdateInput = {
  owner: string;
  repo: string;
  issueNumber: number;
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
  labels?: string[];
  assignees?: string[];
};
type GitHubPullCreateInput = {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  head: string;
  base: string;
  draft?: boolean;
};
type GitHubPullReviewInput = {
  owner: string;
  repo: string;
  pullNumber: number;
  body: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
};
```

Required action names:

- `issues.get`
- `issues.update`
- `pulls.create`
- `pulls.createReview`

Required trigger names:

- `pull_request.closed`
- `issue_comment.created`

## ClickUp provider additions

Required action names:

- `tasks.create`
- `tasks.get`
- `tasks.update`
- `tasks.list`
- `comments.create`
- `spaces.list`

Required trigger names:

- `task.updated`
- `task.statusChanged`

# Data formats / protocol

## Provider action envelope

PlugFn actions MUST continue using provider-native request/response shapes validated by Zod. Conduct-facing examples:

```json
{
  "action": "linear.comments.create",
  "input": {
    "issueId": "ENG-1234",
    "body": "Spec generated: OAuth PKCE Flow"
  }
}
```

```json
{
  "action": "github.pulls.createReview",
  "input": {
    "owner": "21nCo",
    "repo": "super-functions",
    "pullNumber": 42,
    "body": "Audit complete with 2 warnings.",
    "event": "COMMENT"
  }
}
```

## Provider trigger envelope

```json
{
  "provider": "github",
  "trigger": "issue_comment.created",
  "verified": true,
  "payload": {
    "repository": {"full_name": "21nCo/super-functions"},
    "issue": {"number": 42},
    "comment": {"body": "/conduct spec"}
  }
}
```

## `clifn` config shapes

```json
{
  "credentialsProfile": {
    "backend": "https://api.conduct.sh",
    "key": "sk_live_xxx"
  },
  "projectConfig": {
    "profile": "default",
    "projectId": "proj_abc123"
  }
}
```

## Failure behavior

- Provider actions MUST surface normalized PlugFn errors when required inputs are missing or the remote API rejects the action.
- Webhook triggers MUST mark unverified requests as rejected and MUST NOT emit business events.
- `clifn` helpers MUST throw deterministic typed errors for missing profiles, invalid config JSON, and HTTP failures.

# Semantics

## PlugFn as the integration runtime

Superfunctions MUST supply provider actions and triggers through PlugFn rather than introducing a Conduct-specific integration subsystem. Provider implementations stay reusable and only expose generic actions/triggers; Conduct owns workflow orchestration and state mapping.

## `clifn` extraction strategy

Conduct may prove APIs inline first, but the superfunctions dependency outcome for v0.3.0 is a reusable `clifn` package with stable subpath exports for credentials, config, client, UI, stdio, and prompt helpers.

## Ready-package validation

`@superfunctions/db`, `@superfunctions/storage-s3`, `@superfunctions/webhooks`, `@superfunctions/queue`, `@superfunctions/http`, `@superfunctions/auth`, `@superfunctions/config`, `@superfunctions/errors`, `@superfunctions/envelope`, and `@superfunctions/middleware` remain unchanged unless dependency harnesses prove otherwise. Conduct MUST consume them through their existing public APIs.

## Schema-generation gap handling

Conduct's schema needs composite indexes and CHECK constraints. Superfunctions MUST support that requirement either by extending `@superfunctions/cli` generation or by documenting and testing a direct Drizzle fallback so the gap never blocks Conduct.

## Package placement and workspace rules

New dependency work MUST follow repo conventions:

- `clifn` lives as a normal top-level function package with a subpackage workspace.
- workspaces are updated in root `package.json`.
- no nested monorepos are introduced.
- package names remain unscoped for function packages and `@superfunctions/*` for shared packages.

# Invariants

1. PlugFn providers MUST remain Conduct-agnostic and reusable by other consumers.
2. Provider action and trigger names listed in this spec are stable public contracts once shipped.
3. Provider webhook triggers MUST verify signatures before emitting events.
4. `clifn` public subpaths MUST stay deterministic and usable in non-Conduct CLIs.
5. Ready packages MUST NOT be changed speculatively without a failing harness or explicit gap proof.
6. Secrets MUST NOT be echoed by `clifn` UI or test fixtures.

# Security

- PlugFn OAuth tokens and webhook secrets remain inside provider/runtime layers and MUST NOT be exposed through Conduct-specific helper code.
- `clifn` credential storage MUST read/write local profile files without printing secret values in styled output.
- Provider webhook tests MUST cover signature failures as negative cases.
- No dependency package in this spec may require Conduct to handle raw PM credentials directly.

# Limits/caps

- Linear issue search defaults to `first=20` unless the caller overrides it.
- `clifn` stdin/stdout helpers MUST operate on single JSON documents and MUST fail fast on invalid JSON.
- Provider compatibility tests MUST run locally without live third-party network calls.
- ClickUp provider pagination defaults MAY follow provider norms, but task listing MUST be cursor- or page-token-safe and deterministic.

# Observability

Superfunctions dependency work MUST provide:

- unit tests for new provider actions and triggers
- fixture-backed webhook verification tests
- `clifn` tests for credentials, config, client retries, stdio, and prompts
- example usage in READMEs or provider docs for the new actions

Superfunctions dependency work MUST NOT:

- emit secret-bearing test snapshots
- rely on opaque manual verification for provider contract changes

# Compatibility / versioning strategy

- New provider capabilities are additive and should ship as backward-compatible minor releases unless a package's existing contract must change.
- `clifn` starts as a new package and MUST publish stable subpath exports from its first release.
- Conduct-facing examples in docs MUST use only public shared-package APIs.

# Undefined / Explicitly user-deferred only

- DataFn adoption for Conduct memory/query semantics.
- Full Slack interaction-platform support inside PlugFn unless a later dependency audit requires it.
- Changes to package families not referenced by the Conduct dependency audit.
