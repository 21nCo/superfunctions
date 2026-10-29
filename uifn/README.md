# uifn

`uifn` is the clean-room UI primitive and component system for Superfunctions. Its stable architecture is one private behavior runtime, one public controller contract, one owned DOM layer, thin framework-native adapters, framework-isolated styled packages, and a deterministic package/source delivery pipeline.

## Stable package graph

| Package | Layer | Current role |
| --- | --- | --- |
| `@uifn/core` | core | Framework-agnostic controllers and pure logic |
| `@uifn/dom` | DOM | Owned browser-service boundary |
| `@uifn/adapter-kit` | adapters | Shared binding and conformance contract |
| `@uifn/react` | adapters | React headless package |
| `@uifn/svelte` | adapters | Svelte headless package |
| `@uifn/solid` | adapters | Solid headless package |
| `@uifn/tokens` | styling | Semantic token contracts |
| `@uifn/theme` | styling | Theme contracts and mounting |
| `@uifn/recipes` | styling | Framework-neutral part recipes |
| `@uifn/theme-tailwind` | styling | Generated Tailwind integration |
| `@uifn/components` | styled-neutral | Framework-neutral contracts, CSS, recipes, and metadata |
| `@uifn/components-react` | styled adapter | React styled-package boundary |
| `@uifn/components-svelte` | styled adapter | Svelte styled-package boundary |
| `@uifn/components-solid` | styled adapter | Solid styled-package boundary |
| `@uifn/registry` | delivery | Source installation, locks, diff, update, versioned presets, and Create CLI |
| `@uifn/storybook` | workshop | Storybook integration and documentation tooling |

The authoritative machine-readable DAG is `uifn/package-graph.json`. React, Svelte, and Solid are equal stable targets. Stable packages cannot depend on examples, product demos, or experimental products.

The private `@uifn/create` editor is a client of the same preset contract. Run `npm --workspace @uifn/create run dev` for the schema-driven configurator.

## Experimental products

`@uifn/patterns` and `@uifn/sf` are independently versioned experimental products. They publish under the `experimental` dist-tag, have separate gates and changelogs, and cannot block, enter, or be bundled into the stable release lane.

## Verification

Run package-surface checks from the repository root:

```bash
npm run verify:uifn-package-graph
npm run verify:uifn-stable
npm run verify:uifn-lanes
```

Pull requests to `dev` that change a stable package's shipped code (sources, build configuration, published `package.json` fields including dependency pins) must bump that package's version and add a `## <version>` entry with content to its `CHANGELOG.md`. Tests, fixtures, stories, harnesses, Markdown and a package's `docs/` directory need neither, unless a shipped file, lifecycle script or manifest entry field (`exports`, `main`, `bin` and the like) imports or names them. Validation scripts that prepack runs, such as `test`, `typecheck`, `lint` and `generate:check`, need no bump either. Unknown paths inside a package count as shipped. Inputs outside a package root, such as a catalog its build reads or sources it bundles through a relative import, are declared with a reason in `uifn/version-bump-inputs.json`. A change to a declared input needs the dependent package's bump. The same file records out-of-root references that do not feed the tarball, and in-package data or helpers outside `files` that never reach it, such as verification helpers and contract JSON. The check rejects an exclusion that `files` or a tsconfig include covers, that covers a build config tools load implicitly (such as `tsup.config.ts`, `tsconfig*.json` or `.npmignore`), or that a shipped file or lifecycle script refers to. Each changed path is judged at both ends of the range by that end's own declarations, and counts if it ships at either end where it exists. So a new path can be excluded in the same change, a deleted path is judged by the base branch alone, and a path that already exists keeps counting until its exclusion is on the base branch. Packages stable on the base branch are checked too, so a change that demotes or moves one still needs its bump. The check fails when shipped sources, build scripts or lifecycle scripts refer to an undeclared path outside the package. Check locally with `node scripts/verify-uifn-version-bump.mjs --base origin/dev`, and list changes since the last published tags with `--since-published`. That report is informational: if it cannot be built, it warns and exits 0.

`verify:uifn-stable` covers only the stable lane. Run `npm run verify:uifn-phase-01` for the isolated proof that the stable lane executes with the experimental workspaces absent. `verify:uifn-lanes` always reports experimental results separately. The full 1.0 release remains fail-closed until the architecture, behavior, accessibility, compatibility, performance, security, and release gates are complete.

Private React, Svelte, and Solid Workbench apps live under `uifn/examples`. Integrated pattern and Superfunction panels are experimental-demo surfaces and are excluded from the stable package result.

## Versioning

Breaking cleanup is authorized before 1.0; legacy compatibility scaffolding is removed instead of preserved. After 1.0, stable public packages follow semantic versioning. Source-installed consumers use `uifn diff` and `uifn update` to review local changes.
