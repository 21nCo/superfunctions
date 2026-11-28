# ReviewFn

ReviewFn is a portable, evidence-backed pull-request reviewer. It captures an immutable base/head change, freezes authoritative issue and repository context, runs approved tests in a disposable checkout, asks a compatible review harness for structured assessments, validates every source/evidence/code reference, and publishes one current-head advisory summary.

The first release is deliberately advisory. It cannot edit code, push, merge, or treat a completed model invocation as proof that the requested behavior is complete.

## Packages

| Package | Responsibility |
| --- | --- |
| `reviewfn` | The front door: re-exports `@superfunctions/reviewfn-core`, and its `reviewfn` command runs `@superfunctions/reviewfn-cli` at the same version |
| `@superfunctions/reviewfn-core` | Versioned contracts, identity, policy, orchestration, validation, artifacts and rendering |
| `@superfunctions/reviewfn-cli` | Initialization, preflight, review, report rendering and evaluation commands |
| `@superfunctions/reviewfn-harness-codex` | Codex CLI capability checks, bounded execution, JSONL normalization and structured output |
| `@superfunctions/reviewfn-context-composio` | Explicit-account Linear issue/comment/document snapshots through Composio CLI |
| `@superfunctions/reviewfn-github` | Exact Git snapshots and idempotent GitHub summary/check publication |
| `@superfunctions/reviewfn-testing` | Fake adapters, deterministic fixtures, replay metrics and comparison-confound reporting |

Every package is independently installable. No package depends on another Superfunctions runtime.

## Local quick start

Requires Node.js 22 or newer, Git, and a supported Codex CLI installation.

Run it once with `npx reviewfn <command>` (the `reviewfn` package fetches the CLI at its own version), or install the CLI in the repository:

```sh
npm install --save-dev @superfunctions/reviewfn-cli
npx reviewfn init
npx reviewfn preflight --base origin/main --head HEAD --issue ENG-123
npx reviewfn review --base origin/main --head HEAD --issue ENG-123
```

Reports are written to `.reviewfn/output/report.json` and `.reviewfn/output/report.md`; content-addressed evidence is written under `.reviewfn/artifacts`. Add those two generated directories to the consumer repository's ignore rules.

For a connection-free setup, retain only the `repository-markdown` context adapter. For Linear, add `composio-linear` with an explicit `account`, `expectedWorkspace`, and `issue`. ReviewFn never embeds a personal connected-account ID.

## Panel review

`reviewfn panel` runs several harness slots over the same frozen change and combines their findings into one panel report. `reviewfn init --panel` writes a `.reviewfn/panel.json` template to start from.

```sh
npx reviewfn init --panel
npx reviewfn panel --base origin/main --head HEAD --issue ENG-123
npx reviewfn report --panel
```

The run writes `.reviewfn/output/panel-report.json` and `.reviewfn/output/panel-report.md`, with its evidence under `.reviewfn/artifacts`. Harness adapters resolve only from a fixed table (`codex`, `claude-code`, `cli`). The Codex adapter ships as a direct dependency of the CLI; the `claude-code` and `cli` packages are not published yet and will resolve once installed next to the CLI. A slot whose adapter package is missing fails preflight with `REVIEWFN_HARNESS_NOT_INSTALLED`. The exit code is 0 for complete coverage, 2 for incomplete coverage or an unmet quorum, 3 for a failed preflight, 4 for a canceled run and 1 for any other error. The verdict never changes it. See [panel review](./docs/panel.md).

## Guarantees

- Run identity records base, head, merge-base, diff, context, policy, prompt, harness, model and budget provenance.
- Every requirement must resolve to exactly one assessment.
- Incomplete context, quota, timeout, malformed output, cancellation and stale heads cannot produce or publish a passing review.
- Repository tests receive no model, context, or GitHub publishing credentials.
- A PR that changes auto-loaded agent instruction/configuration paths is rejected before inference.
- GitHub publication maintains one profile summary and idempotently updates the same run's check.
- Advisory output uses a neutral GitHub check; gating remains a separately authorized, calibrated policy.

See [configuration](./docs/configuration.md), [security](./docs/security.md), [GitHub setup](./docs/github-action.md), [report contract](./docs/report-schema.md), [panel report contract](./docs/panel-report-schema.md), and [evaluation](./docs/evaluation.md).

The release gate requires Docker and the pinned test image documented in `docs/security.md`. PR inference additionally requires the trusted Codex image and a credential-isolating proxy. Publication is a separate `reviewfn publish` command/job. See `docs/github-action.md` for identity checks, concurrency, retries and permissions.

Registry release order is core first, then context-composio, github,
harness-codex, and testing, followed by the CLI. Each package runs its own
`npm run typecheck`, `npm run build`, `npm run lint`, and `npm test` after installing
its declared registry dependencies in a standalone directory. No release gate
substitutes sibling sources for published declarations. The CLI's execution tests
run real Git snapshots and Docker containers; provide Docker and the pinned image
rather than replacing those tests with a binary-export smoke check.
