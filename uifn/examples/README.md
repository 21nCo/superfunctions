# uifn examples

Private workspace apps for exercising `@uifn/*` adapters in realistic, scenario-driven playgrounds.

## Workspace Layout

- `@uifn/examples` - command hub for example apps
- `@uifn/examples-shared` - shared scenario data, capability metadata, and fixtures
- `@uifn/example-react-playground` - React example app
- `@uifn/example-svelte-playground` - Svelte example app
- `@uifn/example-vue-playground` - Vue example app (experimental)

## Commands

Run from the repository root:

```bash
npm run verify:uifn-examples
npm --workspace @uifn/examples run dev:react
npm --workspace @uifn/examples run dev:svelte
npm --workspace @uifn/examples run dev:vue
npm --workspace @uifn/examples run build
```

`npm run verify:uifn-examples` performs the canonical workspace, manifest, build, docs, and offline checks for the example bundle.

## Dev Ports

- React playground: `6111`
- Svelte playground: `6112`
- Vue playground: `6113`

## Notes

- These apps are private workspaces and are not published to npm.
- The Vue playground remains experimental and follows the same status language as `@uifn/vue`.
- The publish-oriented `npm run verify:uifn-release` command does not include example workspaces.
