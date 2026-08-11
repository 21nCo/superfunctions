# Sub-spec: Storybook, Testing, and Release

## Purpose

Define Storybook as the consumer-facing workshop/test/docs surface and define the release gates required for production readiness.

## Storybook Package

`@uifn/storybook` MUST provide:

- preset,
- addons or panels where needed,
- theme decorators,
- density decorators,
- locale decorators,
- viewport decorators,
- reduced-motion decorator,
- Superfunction mock client decorators,
- compatibility panel,
- generated docs pages.

## Compatibility Panel

For each story, the panel MUST display:

- component or pattern name,
- version,
- status,
- owner,
- dependencies,
- supported frameworks,
- primitive dependencies,
- token groups,
- Superfunction backing if present,
- source policy,
- registry item id.

## Story Requirements

Every component/pattern MUST include stories for:

- default state,
- variants,
- interactive states,
- accessibility state,
- themed states,
- responsive state where applicable,
- loading/empty/error states where applicable.

## Story Tests

Stories MUST be executable as:

- interaction tests,
- accessibility checks,
- visual regression checks,
- docs validation checks.

## Release Gate

`npm run verify:uifn-release` MUST validate:

- package graph,
- package build,
- lint,
- typecheck,
- unit tests,
- core behavior tests,
- adapter conformance tests,
- component tests,
- pattern tests,
- Superfunction mock-client tests,
- Storybook story tests,
- accessibility checks,
- visual regression checks,
- SSR/hydration checks,
- export maps,
- pack output,
- registry manifests,
- registry locks and examples,
- docs generation,
- token contrast,
- Tailwind static class safety,
- no absolute local paths in committed artifacts.

The gate MUST emit machine-readable JSON:

```json
{
  "ok": false,
  "command": "verify:uifn-release",
  "failures": [
    {
      "code": "UIFN_STORY_A11Y_FAILED",
      "package": "@uifn/components",
      "framework": "angular",
      "item": "Select",
      "story": "Select/Keyboard"
    }
  ]
}
```

## Manual Evidence

Manual evidence SHOULD be minimized, but if required it MUST be structured and checked by the gate. Free-form manual signoff MUST NOT be the only release proof for accessibility or visual behavior.
