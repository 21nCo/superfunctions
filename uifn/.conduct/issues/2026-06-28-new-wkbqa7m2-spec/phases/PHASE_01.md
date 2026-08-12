# PHASE_01 - Workbench Package Family

## Phase Goal

Create private Workbench apps for React, Svelte, Vue, Solid, and Angular with shared route loading.

## In Scope

- Workspace package manifests.
- App shells.
- Shared route index.
- Dev/build/preview commands.
- Fixed local ports.

## Out of Scope

- Full component rendering.
- Full browser QA.

## Deliverables

- uifn/examples/react-workbench
- uifn/examples/svelte-workbench
- uifn/examples/vue-workbench
- uifn/examples/solid-workbench
- uifn/examples/angular-workbench
- uifn/examples/package.json
- root package.json script updates

## Requirements Covered

- WB-001
- WB-003
- DOC-001

## Implementation Tasks

1. Add or migrate five private Workbench workspace packages.
2. Wire each app to shared route definitions.
3. Add deterministic index and route-not-found pages.
4. Add dev/build/preview scripts with fixed ports.
5. Update root scripts for Workbench verification.
6. Update docs with Workbench app names and ports.

## Verification Steps

```bash
npm run verify:uifn-examples -- --scope workspaces
npm --workspace @uifn/example-react-workbench run build
npm --workspace @uifn/example-svelte-workbench run build
npm --workspace @uifn/example-vue-workbench run build
npm --workspace @uifn/example-solid-workbench run build
npm --workspace @uifn/example-angular-workbench run build
git diff --check
```

Expected outcome: all five apps build and route manifests match.

## Stop Condition

Stop and report framework app package names, ports, and build status.
