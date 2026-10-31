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

Pull requests to `dev` that change a stable package's shipped code (sources, build configuration, published `package.json` fields including dependency pins) must bump that package's version and add a `## <version>` entry with content to its `CHANGELOG.md`. Tests, fixtures, stories, harnesses, Markdown and a package's `docs/` directory need neither, unless a build surface names them: an import from a shipped file, a lifecycle script argument or glob (a directory argument, such as `svelte-package -i lib`, means every file under it, even the package root or a declared input root), a manifest entry field (`exports`, `main`, `bin` and the like), a path or glob string in a build config or build script, resolved from the package root and from the script's directory (such as a tsup `entry`, `./` included, where a `!` glob drops what it matches), or a file that a tsconfig the build compiles with makes tsc compile, as TypeScript resolves it (extends, include, exclude, files, allowJs and project references); a tsc command without `-p` or `-b`, or one given a directory, compiles that directory's `tsconfig.json`, wherever the command appears (a script, or any string in a build script); a build script that runs tsc in any form, such as an argv array, compiles every `tsconfig*.json` in its package, whatever that run's project, working directory or `--noEmit`, and any tsconfig or `-p`/`-b` project outside the package that it names with `..` must be declared; and a lifecycle script's `tsc --noEmit`, or a tsconfig whose effective options set `noEmit` without a `--noEmit false` on the command line (anywhere in a build script), emits none of its files, though its project references still build. A build script is any file a shipped lifecycle script runs (`node build.mjs`, `tsx tools/build.ts`, `sh build.sh`) or names as a tool config (`rollup -c tools/rollup.config.mjs`, `--config=build/webpack.mjs`, any `*.config.*` file), besides the package's `scripts/` and root `*.config.*` files, and every local module a build script imports; it runs from the package root, and a shell build script is read line by line like a lifecycle script. A file that a `files` entry matches ships, tests and fixtures included, and a package without a `files` list ships every file; Markdown stays exempt either way. A packed file's imports and paths count like a shipped source's. Validation scripts that prepack runs, such as `test`, `typecheck`, `lint` and `generate:check`, need no bump either, but every script that `preinstall`, `install` or `postinstall` reaches does, whatever its name, because it runs on consumers' machines. A script counts as reached when any command word in a reached script names it, whatever the runner (`npm --silent run x`, `pnpm run x`, `yarn x`, `run-s 'x:*'`). Unknown paths inside a package count as shipped. Inputs outside a package root, such as a catalog its build reads or sources it bundles through a relative import, are declared with a reason in `uifn/version-bump-inputs.json`. A change to a declared input needs the dependent package's bump. The same file records out-of-root references that do not feed the tarball, such as tsconfig `paths` for type-checking (a relative import that a shipped source bundles from such a path fails until it is declared as an input), and in-package data or helpers outside `files` that never reach it, such as verification helpers and contract JSON. The check rejects an exclusion that `files` covers (any exclusion when `files` is absent), that covers a build config tools load implicitly (such as `tsup.config.ts`, `tsconfig*.json` or `.npmignore`), or that contains a file any of those build surfaces, or a tsconfig include, names. Each changed path is judged at both ends of the range by that end's own declarations, and counts if it ships at either end where it exists. So a new path can be excluded in the same change, a deleted path is judged by the base branch alone, and a path that already exists keeps counting until its exclusion is on the base branch. Packages stable on the base branch are checked too, so a change that demotes or moves one still needs its bump, including for files it adds. The check fails when shipped or packed sources, build scripts or lifecycle scripts refer to an undeclared path outside the package. Check locally with `node scripts/verify-uifn-version-bump.mjs --base origin/dev`, and list changes since the last published tags with `--since-published`. That report is informational: if it cannot be built, it warns and exits 0.

`verify:uifn-stable` covers only the stable lane. Run `npm run verify:uifn-phase-01` for the isolated proof that the stable lane executes with the experimental workspaces absent. `verify:uifn-lanes` always reports experimental results separately. The full 1.0 release remains fail-closed until the architecture, behavior, accessibility, compatibility, performance, security, and release gates are complete.

Private React, Svelte, and Solid Workbench apps live under `uifn/examples`. Integrated pattern and Superfunction panels are experimental-demo surfaces and are excluded from the stable package result.

## Versioning

Breaking cleanup is authorized before 1.0; legacy compatibility scaffolding is removed instead of preserved. After 1.0, stable public packages follow semantic versioning. Source-installed consumers use `uifn diff` and `uifn update` to review local changes.
