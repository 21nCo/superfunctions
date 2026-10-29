# Adapter browser scenarios

Use this directory for scenarios that check how an adapter behaves in a real browser. Each scenario mounts the same fixture through `@uifn/svelte`, `@uifn/react`, and `@uifn/solid`, then drives it with Playwright. The scenarios run under the `chromium`, `firefox`, and `webkit` projects of `@uifn/dom`'s Playwright suite. The mobile projects match only their own specs, so they skip these.

## How it runs

- `../../playwright.config.ts` starts a second Vite server on `127.0.0.1:4176` with `vite.config.mts`. That config compiles `.svelte` files and Solid JSX, and leaves the React fixtures to Vite's default JSX transform. `.svelte` files compile with the `svelte` and `@sveltejs/vite-plugin-svelte` nested under `uifn/dom/node_modules`, not the repository-wide copies, and the config refuses to start if the plugin's compiler and the fixtures' runtime are different copies.
- Fixtures import the **built** adapter packages, as an application does. The 4176 server's command first runs `npx turbo run build --filter=@uifn/react... --filter=@uifn/svelte... --filter=@uifn/solid...`, so a run on a fresh checkout builds the adapters, `@uifn/core`, and `@uifn/dom` itself. Turbo restores unchanged outputs from its cache. Playwright starts the 4176 server before the 4175 server, so the builds finish before the primitive vectors load `@uifn/dom`.
- The server keeps its Vite dependency cache in `node_modules/.vite-adapters`, apart from the 4175 server's `node_modules/.vite`.
- `index.html?framework=<svelte|react|solid>&scenario=<name>` loads `main.ts`. It imports `<framework>/mount.*` and calls `mountScenario(name, #scenario-root)`. `main.ts` also records every `console.error`, `console.warn`, uncaught error, and unhandled rejection.
- Specs call `mountAdapterScenario(page, framework, name)` and `unmountAdapterScenario(page)` from `scenario.ts`. Both fail the test if any error was recorded. Unmount also proves that the framework teardown ran.

## Adding a scenario

1. Write one fixture per framework with the same markup and accessible names: `svelte/<Name>Scenario.svelte`, `react/<Name>Scenario.tsx`, and `solid/<Name>Scenario.tsx`. Use controlled state (`bind:value`, `useState`, or a signal), and render the value into `[data-scenario-value]` when the scenario asserts it.
2. Register the fixture under one scenario name in each framework's `mount` module.
3. Add `<name>.spec.ts` here. Loop over `ADAPTER_FRAMEWORKS` so every adapter runs the same assertions, and assert through roles and accessible names.
4. If an adapter fails because of a real defect, keep the scenario and confine the defect to its own test, marked `test.fail(...)` for that framework only, with a link to the tracking Linear issue. The other assertions stay in tests that must pass for every framework. `tabs-keyboard.spec.ts` keeps focus retention apart from selection this way. Once the defect is fixed, the expected failure turns red, so remove the annotation in the same change.

## Running locally

From the repository root, after `npm ci`, install the three browsers once and run the scenarios:

```bash
npm --workspace @uifn/dom exec -- playwright install chromium firefox webkit
npm --workspace @uifn/dom run test:browser -- --project=chromium --project=firefox --project=webkit browser/adapters
```

CI runs the full suite, including these scenarios, in the `uifn browser tests` workflow (`.github/workflows/uifn-browser.yml`). It uses one job per engine on Linux, for every pull request to `dev`, `next`, or `main` that changes `uifn/**`, and for every push to `dev`.
