# PHASE_09 Consumer Smoke

## Metadata

- Generated at: `2026-03-25T11:51:51.810Z`
- Result: `pass`
- Method: packed tarball install into a temporary consumer workspace
- Workspace kind: `temporary-consumer-install`
- Temporary workspace cleaned up after run: `yes`

## Tarballs

| Package | Tarball | Source |
| --- | --- | --- |
| @uifn/core | `uifn-core-0.0.1.tgz` | `uifn/core` |
| @uifn/react | `uifn-react-0.0.1.tgz` | `uifn/react` |
| @uifn/svelte | `uifn-svelte-0.0.1.tgz` | `uifn/svelte` |

## Verification Steps

| Command | Status | Notes |
| --- | --- | --- |
| `npm install` | PASS | Installed packed @uifn/core, @uifn/react, and @uifn/svelte tarballs with peer dependencies. |
| `npm run typecheck` | PASS | Resolved documented core subpath imports and the React root entry point from tarballs. |
| `npm run runtime:core` | PASS | Executed runtime imports for core subpaths from the packed artifact. |
| `npm run runtime:react` | PASS | Rendered a React import from the packed adapter through react-dom/server. |
| `npm run build:svelte` | PASS | Built a minimal Svelte consumer app that imports from the packed Svelte adapter. |

## Summary

- Packages verified: `@uifn/core`, `@uifn/react`, `@uifn/svelte`
- Install: `pass`
- Typecheck: `pass`
- Bundle/runtime: `pass`
- Root evidence JSON: [consumer-smoke.json](../../../release-evidence/consumer-smoke.json)
