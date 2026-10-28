# Adapter browser scenarios

Use this directory for scenarios that check how an adapter behaves in a real browser. Each scenario mounts the same fixture through `@uifn/svelte`, `@uifn/react`, and `@uifn/solid`, then drives it with Playwright. The scenarios run under the `chromium`, `firefox`, and `webkit` projects of `@uifn/dom`'s Playwright suite. The mobile projects match only their own specs, so they skip these.

## How it runs

- `../../playwright.config.ts` starts a second Vite server on `127.0.0.1:4176` with `vite.config.mts`. That config compiles `.svelte` files and Solid JSX, and leaves the React fixtures to Vite's default JSX transform.
- Fixtures import the **built** adapter packages, as an application does. Build them before a browser run: `npx turbo run build --filter=@uifn/react... --filter=@uifn/svelte... --filter=@uifn/solid...`.
- `index.html?framework=<svelte|react|solid>&scenario=<name>` loads `main.ts`. It imports `<framework>/mount.*` and calls `mountScenario(name, #scenario-root)`. `main.ts` also records every `console.error`, `console.warn`, uncaught error, and unhandled rejection.
- Specs call `mountAdapterScenario(page, framework, name)` and `unmountAdapterScenario(page)` from `scenario.ts`. Both fail the test if any error was recorded. Unmount also proves that the framework teardown ran.

## Adding a scenario

1. Write one fixture per framework with the same markup and accessible names: `svelte/<Name>Scenario.svelte`, `react/<Name>Scenario.tsx`, and `solid/<Name>Scenario.tsx`. Use controlled state (`bind:value`, `useState`, or a signal), and render the value into `[data-scenario-value]` when the scenario asserts it.
2. Register the fixture under one scenario name in each framework's `mount` module.
3. Add `<name>.spec.ts` here. Loop over `ADAPTER_FRAMEWORKS` so every adapter runs the same assertions, and assert through roles and accessible names.
4. If an adapter fails because of a real defect, keep the scenario and mark that framework with `test.fail(...)`. Link the tracking Linear issue, as `tabs-keyboard.spec.ts` does. Once the defect is fixed, the expected failure turns red, so remove the annotation in the same change.

## Running locally

```bash
npm --workspace @uifn/dom run test:browser -- --project=chromium --project=firefox --project=webkit browser/adapters
```

CI runs the full suite, including these scenarios, in the `uifn browser tests` workflow (`.github/workflows/uifn-browser.yml`). It uses one job per engine on Linux.
