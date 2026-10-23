# Table Of Contents

- `EXW-001`
- `HUB-002`
- `SHARED-003`
- `UI-004`
- `RCT-005`
- `SVE-006`
- `VUE-007`
- `CAP-008`
- `VERIFY-009`
- `DOC-010`
- `DET-011`
- `A11Y-012`

## EXW-001

- ID: `EXW-001`
- Priority: `P0`
- Statement: The repository MUST add `uifn/examples/*` as a root workspace glob and all example workspaces MUST remain `private: true` and excluded from the publish-oriented `verify:uifn-release` package list.
- Rationale: The examples need local workspace linking without becoming accidental published surface area.
- Acceptance criteria:
  - Root `package.json` contains `uifn/examples/*` in `workspaces`.
  - `uifn/examples`, `uifn/examples/shared`, and every playground package set `private` to `true`.
  - `scripts/verify-uifn-release.mjs` does not gain example packages in its checked package list.
  - Running workspace discovery from the repo root resolves all example workspaces.
- Test vectors: `TV-WS-001`, `TV-VERIFY-001`
- Notes: If maintainers later want published examples, that MUST be a separate spec because it changes package-surface and release assumptions.

## HUB-002

- ID: `HUB-002`
- Priority: `P0`
- Statement: `uifn/examples` MUST provide the canonical README and runner scripts `dev:react`, `dev:svelte`, `dev:vue`, `build`, and `verify`, and the root package MUST expose `verify:uifn-examples`.
- Rationale: Developers need one predictable command surface instead of ad hoc workspace-specific instructions.
- Acceptance criteria:
  - `uifn/examples/README.md` exists and documents all supported commands from the repo root.
  - `uifn/examples/package.json` includes the required scripts.
  - Root `package.json` includes `verify:uifn-examples`.
  - The hub scripts target the named example workspaces rather than hard-coded relative node module paths.
- Test vectors: `TV-HUB-001`, `TV-DOC-001`
- Notes: The hub MAY include helper scripts under `uifn/examples/scripts`, but the command contract MUST remain stable.

## SHARED-003

- ID: `SHARED-003`
- Priority: `P0`
- Statement: `@uifn/examples-shared` MUST export the canonical scenario registry, capability matrix, and deterministic fixture data exactly once for all playgrounds to consume.
- Rationale: Cross-adapter parity only works if scenario identity and fixtures are centrally defined.
- Acceptance criteria:
  - `uifn/examples/shared` exports the TypeScript shapes defined in `SPEC.md`.
  - The scenario registry contains exactly four scenarios with the canonical ids and order.
  - The capability matrix marks `virtualized-list` as unsupported in Vue.
  - Fixture data is local, deterministic, and contains no timestamps or randomized ids.
- Test vectors: `TV-SHARED-001`, `TV-CAP-001`, `TV-DET-001`
- Notes: Any adapter-specific visual differences MUST derive from rendering, not from divergent scenario data.

## UI-004

- ID: `UI-004`
- Priority: `P0`
- Statement: Every playground MUST implement the common shell and hash-route contract, including canonical scenario navigation order, default route normalization, and an unsupported view for valid-but-unsupported scenarios.
- Rationale: A shared information architecture makes adapter comparison and documentation consistent.
- Acceptance criteria:
  - Each playground renders the same scenario titles in the same order.
  - Visiting the app without a hash resolves to `#/settings-console`.
  - Visiting an unknown hash resets to `#/settings-console`.
  - Visiting `#/virtualized-results` in Vue renders a stable unsupported view instead of crashing.
- Test vectors: `TV-ROUTE-001`, `TV-VUE-001`
- Notes: The shell MUST include adapter identity; Vue MUST display its experimental status in the shell.

## RCT-005

- ID: `RCT-005`
- Priority: `P0`
- Statement: The React playground MUST render all supported scenarios using `@uifn/react` primitives, including a working `virtualized-results` scenario backed by `VirtualizedList`.
- Rationale: React is a GA adapter and should be a canonical consumer-facing example.
- Acceptance criteria:
  - `uifn/examples/react-playground` builds with Vite and local workspace dependencies.
  - `settings-console`, `team-directory`, `command-center`, and `virtualized-results` render in React.
  - `virtualized-results` uses `VirtualizedList` rather than mounting the full logical list.
  - The app exposes `dev`, `build`, and `preview` scripts with the fixed React port.
- Test vectors: `TV-REACT-001`, `TV-ROUTE-001`, `TV-A11Y-001`
- Notes: The React playground MUST use shared fixtures and MUST NOT inline a divergent scenario registry.

## SVE-006

- ID: `SVE-006`
- Priority: `P0`
- Statement: The Svelte playground MUST render all supported scenarios using `@uifn/svelte` primitives, including a working `virtualized-results` scenario backed by `VirtualizedList`.
- Rationale: Svelte is a GA adapter and should be a canonical consumer-facing example.
- Acceptance criteria:
  - `uifn/examples/svelte-playground` builds with Vite and local workspace dependencies.
  - `settings-console`, `team-directory`, `command-center`, and `virtualized-results` render in Svelte.
  - `virtualized-results` uses `VirtualizedList` with Svelte’s supported render contract.
  - The app exposes `dev`, `build`, and `preview` scripts with the fixed Svelte port.
- Test vectors: `TV-SVELTE-001`, `TV-ROUTE-001`, `TV-A11Y-001`
- Notes: Svelte-specific reactivity is allowed, but the scenario and route contract MUST remain identical.

## VUE-007

- ID: `VUE-007`
- Priority: `P0`
- Statement: The Vue playground MUST render the shared supported scenarios using `@uifn/vue`, MUST remain labeled experimental, and MUST render an unsupported view for `virtualized-results`.
- Rationale: Vue is public and should have a truthful example surface without pretending to support unavailable primitives.
- Acceptance criteria:
  - `uifn/examples/vue-playground` builds with Vite and local workspace dependencies.
  - The shell and README label the playground as experimental.
  - `settings-console`, `team-directory`, and `command-center` render in Vue.
  - `#/virtualized-results` renders an unsupported view that names `VirtualizedList` as unavailable in Vue.
- Test vectors: `TV-VUE-001`, `TV-ROUTE-001`, `TV-CAP-001`
- Notes: The unsupported view is the required behavior; omitting the route entirely would violate the common route contract.

## CAP-008

- ID: `CAP-008`
- Priority: `P1`
- Statement: Every playground MUST surface the shared capability matrix so that supported and unsupported primitive families are truthfully visible by adapter.
- Rationale: Example apps should teach adapter boundaries, not just happy-path demos.
- Acceptance criteria:
  - A capability matrix view is rendered in each playground shell.
  - Matrix data is sourced from `@uifn/examples-shared`.
  - React and Svelte mark `virtualized-list` as supported.
  - Vue marks `virtualized-list` as unsupported with the canonical note.
- Test vectors: `TV-CAP-001`, `TV-VUE-001`
- Notes: The matrix MAY be a table, cards, or list, but its data content MUST remain canonical.

## VERIFY-009

- ID: `VERIFY-009`
- Priority: `P1`
- Statement: The repository MUST add `verify:uifn-examples` with the canonical JSON summary envelope, non-zero failure behavior, and checks for workspace discovery, manifest validity, builds, docs links, and forbidden network primitives.
- Rationale: Examples should be easy to validate locally without expanding the publish-oriented release gate.
- Acceptance criteria:
  - `npm run verify:uifn-examples` emits JSON with keys `ok`, `command`, `checks`, `workspaces`, and `failures`.
  - The command exits successfully only when all checks pass.
  - Missing scripts or scenario mismatches produce canonical error codes.
  - Obvious network primitives in example source fail verification.
- Test vectors: `TV-VERIFY-001`, `TV-VERIFY-002`, `TV-DET-001`
- Notes: This requirement is intentionally separate from pack/export-map verification.

## DOC-010

- ID: `DOC-010`
- Priority: `P1`
- Statement: `uifn` and adapter READMEs MUST link to the example hub, describe how to run the playgrounds, and preserve truthful status language for GA versus experimental adapters.
- Rationale: Examples only help users if the docs point to them and keep status claims aligned with reality.
- Acceptance criteria:
  - `uifn/README.md` links to `uifn/examples/README.md`.
  - `uifn/react/README.md` and `uifn/svelte/README.md` link to their corresponding playgrounds.
  - `uifn/vue/README.md` links to its playground and continues to label Vue as experimental.
  - `uifn/examples/README.md` documents ports and root-level commands.
- Test vectors: `TV-DOC-001`, `TV-HUB-001`
- Notes: The docs MUST not tell users to install the example packages from npm.

## DET-011

- ID: `DET-011`
- Priority: `P1`
- Statement: The examples bundle MUST remain deterministic and offline-safe, with stable scenario ids/order, fixed ports, local fixture data, and no runtime network access or environment-variable requirements.
- Rationale: Deterministic examples are easier to verify, document, and debug.
- Acceptance criteria:
  - Shared scenarios and ports match the canonical contract.
  - No example workspace requires `.env` files or remote APIs.
  - Source scans for `fetch`, `XMLHttpRequest`, `WebSocket`, and `navigator.sendBeacon` return no runtime usage in `uifn/examples`.
  - Unknown routes normalize deterministically to `#/settings-console`.
- Test vectors: `TV-DET-001`, `TV-SHARED-001`, `TV-ROUTE-001`
- Notes: Build tool internals are not in scope for the network scan; only example source and scripts are covered.

## A11Y-012

- ID: `A11Y-012`
- Priority: `P1`
- Statement: The example scenarios MUST preserve keyboard-reachable, labeled, and status-truthful interactions across adapters, including unsupported-state messaging in Vue.
- Rationale: The examples are reference implementations and must reinforce `uifn`’s accessibility expectations.
- Acceptance criteria:
  - Scenario navigation is keyboard reachable.
  - Interactive controls in each scenario expose accessible names or labels.
  - Unsupported Vue content is announced as unavailable rather than rendering an unlabeled blank state.
  - React and Svelte `virtualized-results` scenarios remain keyboard reachable.
- Test vectors: `TV-A11Y-001`, `TV-VUE-001`
- Notes: This spec does not require a full visual-regression suite; it requires local accessibility-oriented smoke checks.
