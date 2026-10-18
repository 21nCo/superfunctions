# Package and source delivery

Package mode installs the framework package (`npm install @uifn/components-react`, `npm install @uifn/components-svelte`, or `npm install @uifn/components-solid`) and imports its stable subpaths. Source mode uses the signed offline catalog in `@uifn/registry` and records source ownership and hashes in `.uifn/registry.lock`. Both modes expose the same named parts and compound root contract.

## Source installation

Install the CLI as a development dependency in your consumer project. Resolve the installed `@uifn/registry` entry from that project, then use its sibling CLI file. This also finds npm-hoisted workspace dependencies without downloading a package or falling back to a global `uifn` binary. Stop if resolution fails.

```sh
npm install --save-dev @uifn/registry
UIFN_CLI="$(node -p "require('node:path').join(require('node:path').dirname(require.resolve('@uifn/registry')), 'bin.mjs')")"
node "$UIFN_CLI" add button --framework react --cwd . --dry-run --json
node "$UIFN_CLI" add button --framework react --cwd . --json
node "$UIFN_CLI" diff --cwd . --json
node "$UIFN_CLI" update button --cwd . --dry-run --json
```

Dry run shows the exact plan without writing. Add and update validate catalog signatures, package dependencies, source hashes, and dirty-file conflicts before an atomic write. Check that `--cwd` points to the intended project before running a write; planning does not verify ancestor workspace declarations. Local edits are never silently overwritten.

## Npm lockfiles after dependency changes

Whenever `uifn add`, `uifn update`, or `uifn apply` changes `package.json`, refresh the npm lockfile from the directory that owns it. In an npm workspace, run the refresh from the workspace root even when the package has no local `package-lock.json`. `apply` reports `requiredActions`; `add` and `update` do not, so inspect the package diff yourself.

Run `npm install --package-lock-only --ignore-scripts --lockfile-version=3`, review the diff, then run `npm ci`. UIFn does not run npm or edit the npm lockfile during its file transaction.
