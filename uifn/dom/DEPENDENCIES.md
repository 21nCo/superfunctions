# DOM runtime dependency review

This package wraps focused browser algorithms behind owned `@uifn/dom` contracts. Dependency APIs are not re-exported.

| Dependency | Reviewed version | Purpose | License | Runtime boundary |
| --- | --- | --- | --- | --- |
| `@floating-ui/dom` | `1.8.0` | Placement, clipping/overflow middleware, virtual references, RTL-aware geometry, and lifecycle-safe auto-update primitives. | MIT | Private to `positioning.ts`; public declarations use only uifn-owned types. |
| `tabbable` | `6.5.0` | Native focusability/tabbability candidate rules, including details/summary, radio groups, contenteditable, inert/hidden state, and open shadow-root traversal hooks. | MIT | Private to `focusable.ts`; public declarations use DOM types and uifn options. |

Both dependencies are framework-free, contain no install scripts in the reviewed package metadata, and replace error-prone platform algorithms explicitly identified by PHASE_05. Playwright `1.57.0` and Vite `5.4.21` are development-only browser-harness tools. PHASE_20 owns the final release-candidate vulnerability, license, SBOM, provenance, and hard bundle-budget decision using exact locked tarballs.
