# Phase Goal

Establish the workspace, privacy, and command scaffolding for `uifn` example apps.

# In Scope / Out Of Scope

In scope:

- Root workspace manifest update for `uifn/examples/*`
- Root `verify:uifn-examples` script scaffold
- `uifn/examples` directory creation
- Example hub README and package manifest creation

Out of scope:

- Shared scenario data
- Framework-specific playground implementation
- README cross-linking in `uifn` package docs

# Deliverables

- Modify `package.json`
- Create `uifn/examples/README.md`
- Create `uifn/examples/package.json`

# Requirements Covered

- `EXW-001`
- `HUB-002`

# Implementation Tasks

1. Modify root `package.json` to add `uifn/examples` and `uifn/examples/*` to `workspaces`.
2. Add root script `verify:uifn-examples` that delegates to `uifn/examples`.
3. Create `uifn/examples/package.json` as a private workspace named `@uifn/examples`.
4. Add hub scripts `dev:react`, `dev:svelte`, `dev:vue`, `build`, and `verify`.
5. Create `uifn/examples/README.md` with repo-root usage commands and port assignments.
6. Ensure the hub scripts target workspace names rather than brittle relative `node_modules` binaries.

# Verification Steps

1. Run:

```bash
node -e "const pkg=require('./package.json'); if(!pkg.workspaces.includes('uifn/examples')) throw new Error('missing uifn/examples workspace'); if(!pkg.workspaces.includes('uifn/examples/*')) throw new Error('missing uifn/examples/* workspace'); if(!pkg.scripts['verify:uifn-examples']) throw new Error('missing verify:uifn-examples');"
```

Expected outcome: exits `0`.

2. Run:

```bash
node -e "const pkg=require('./uifn/examples/package.json'); const required=['dev:react','dev:svelte','dev:vue','build','verify']; for (const key of required) if (!pkg.scripts[key]) throw new Error('missing '+key); if (pkg.private !== true) throw new Error('examples hub must be private');"
```

Expected outcome: exits `0`.

3. Review `uifn/examples/README.md`.

Expected outcome: it includes the root command `npm run verify:uifn-examples` and the fixed dev ports `6111`, `6112`, and `6113`.

# Stop Condition

Report the updated root workspace contract, the new example hub package name, and the exact root-level commands that now exist before starting Phase 01.
