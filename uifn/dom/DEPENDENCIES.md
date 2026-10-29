# DOM runtime dependency review

This package wraps focused browser algorithms behind owned `@uifn/dom` contracts. Dependency APIs are not re-exported.

| Dependency | Reviewed version | Purpose | License | Runtime boundary |
| --- | --- | --- | --- | --- |
| `@floating-ui/dom` | `1.8.0` | Placement, clipping/overflow middleware, virtual references, RTL-aware geometry, and lifecycle-safe auto-update primitives. | MIT | Private to `positioning.ts`; public declarations use only uifn-owned types. |
| `tabbable` | `6.5.0` | Native focusability/tabbability candidate rules, including details/summary, radio groups, contenteditable, inert/hidden state, and open shadow-root traversal hooks. | MIT | Private to `focusable.ts`; public declarations use DOM types and uifn options. |

Both dependencies are framework-free, contain no install scripts in the reviewed package metadata, and replace error-prone platform algorithms at the DOM boundary. Playwright `1.57.0` and Vite `5.4.21` are development-only browser-harness tools. The adapter browser scenarios in `browser/adapters` also use the development-only `svelte` `^5.55.7`, `solid-js` `^1.9.13`, `@sveltejs/vite-plugin-svelte` `4.0.3`, and `vite-plugin-solid` `2.11.12` to compile their fixtures; none of them is a runtime dependency of `@uifn/dom`. `svelte` `^5.55.7` covers the advisories against the repository-wide hoist (`5.46.4`). The plugin is pinned to `4.0.3`, one patch below the hoisted `4.0.4`, so npm nests it beside the patched `svelte` and it compiles with that copy; the hoisted plugin would compile with `5.46.4`, whose output the newer runtime cannot run. `browser/adapters/vite.config.mts` refuses to start if the two resolve to different copies. UIF-32 tracks moving the repository-wide hoist. The final release gate owns vulnerability, license, SBOM, provenance, and hard bundle-budget decisions using exact locked tarballs.
