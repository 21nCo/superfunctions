# Generated Storybook Story Runner and Browser Gate Closure

- timestamp: 2026-06-28T07:14:09Z
- requirements: STORY-001, STORY-002, TEST-002
- status: complete

## Previous State

Storybook validation still had a metadata-only gap:

- `verify-uifn-stories` checked story JSON ids, required story cases, fixture existence, and registry count, but it did not execute the generated story entries.
- Component browser a11y/visual checks rendered one synthetic workshop entry per component/framework, not the generated `.stories.json` cases.
- Pattern and Superfunction-backed stories were validated as manifests/fixtures, not executed as public story-state inputs.

## Production Changes

- Added `uifn/components/src/__tests__/generated-story-runner.test.ts`.
  - Reads component `.stories.json` files.
  - Executes every generated story entry across React, Svelte, Vue, Solid, and Angular exports.
  - Dispatches interaction events for interaction stories and verifies nonblank, non-placeholder rendered roots.
- Added `uifn/patterns/src/patterns-story-runner.test.ts`.
  - Reads controlled pattern stories.
  - Executes every story state through public pattern functions.
  - Verifies status, callbacks for interaction stories, no backend imports, and visual matrix metadata.
- Added `uifn/sf/src/sf-story-runner.test.ts`.
  - Reads Superfunction-backed stories.
  - Executes every story state with injected fake clients.
  - Verifies controlled counterpart, backing, client contract, mockability, and forbidden-read invariants.
- Updated `scripts/verify-uifn-stories.mjs`.
  - Requires all story-runner files.
  - Executes Storybook package tests plus component/pattern/SF story-runner suites.
  - Emits `executedStoryCommands` in release evidence.
- Updated `uifn/components/src/__tests__/browser-workshop.test.ts`.
  - Adds generated Storybook browser a11y coverage over batch-b story entries.
  - Adds generated Storybook browser visual coverage over data-rich story entries across required themes and viewports.
- Updated `scripts/verify-uifn-a11y.mjs` and `scripts/verify-uifn-visual.mjs`.
  - Browser evidence now points to generated Storybook story tests.
- Fixed styled component renderers in React, Svelte, Vue, Solid, and Angular.
  - `open` continues to produce `data-state-open`.
  - `aria-expanded` is only emitted on supported tags.
  - Generated story labels include story ids so repeated landmarks are unique.

## Verification

- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-stories.mjs`
  - passed with four executed story commands.
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-a11y.mjs --scope batch-b`
  - passed with generated Storybook browser axe/keyboard evidence.
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-visual.mjs --scope data-rich`
  - passed with generated Storybook browser screenshot/pixel-diff evidence.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run typecheck`
  - passed.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run test`
  - passed: 6 files, 37 tests.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/components run build`
  - passed.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/patterns run typecheck`
  - passed.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/patterns run test`
  - passed: 2 files, 5 tests.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/patterns run build`
  - passed.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/sf run typecheck`
  - passed.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/sf run test`
  - passed: 2 files, 5 tests.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/sf run build`
  - passed.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/storybook run test`
  - passed: 1 file, 6 tests.
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/storybook run build`
  - passed.
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-release.mjs`
  - passed 81/81 with generated-story evidence in `stories`, `a11y`, and `visual`.

## Remaining Work Outside This Row

Storybook story execution and a11y/visual gate false-success gaps are closed. Remaining SFN-15 work is in architecture/core audits, styling closure, docs/examples, clean-room provenance, source-install parity, security/privacy, and breaking-change cleanup.
