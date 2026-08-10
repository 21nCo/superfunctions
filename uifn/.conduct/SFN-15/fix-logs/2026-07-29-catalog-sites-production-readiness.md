# Catalog sites production-readiness fix log

Date: 2026-07-29

## Scope and permanent package boundary

This closure upgrades the public uifn catalogs for the supported ecosystem:

- `@uifn/core` remains permanently unstyled and framework-independent.
- `@uifn/react`, `@uifn/svelte`, and `@uifn/solid` remain headless adapters.
- `@uifn/components-react`, `@uifn/components-svelte`, and `@uifn/components-solid` remain styled, precomposed packages.
- React, Svelte, and Solid are the supported catalog frameworks. Angular and Vue are not presented as supported catalog targets.

The public catalog renders the actual styled framework packages. It does not replace component output with screenshots or a catalog-only simulated DOM.

## Starting defects

- The deployed catalog was behind the local supported inventory and framework boundary.
- Public component pages lacked a complete documentation information architecture comparable to mature component catalogs.
- Several usage examples were handwritten generic wrappers and did not prove the real exported root/part anatomy.
- Accessibility copy could fall back to a generic editorial sentence instead of the primitive's canonical contract.
- Client-side routes did not all have route-specific static HTML, canonical metadata, social metadata, or JSON-LD.
- Unknown framework routes could fall through to a generic application shell instead of returning a useful HTTP 404.
- Search, theme, installation mode, preview/code mode, and mobile navigation were not all covered by a production browser gate.
- Dark-theme brand/current-link colors failed contrast during the first focused audit.
- Search-result links used `hidden`, but a stronger author `display` rule made filtered results remain visible.
- Long horizontally scrollable code examples were not keyboard-focusable.
- A physical trailing-slash component URL could return the correct static document while the client router normalized it to the framework home route, leaving the page title and content inconsistent with its URL.
- Catalog builds had no deterministic initial-payload budget.
- Public responses lacked an application-owned content security policy and baseline browser security headers.
- Deployment success did not prove that both the new asset release and new Worker code had converged across representative public paths.
- The production landing page lacked current inventory messaging, framework entry points, LLM-readable resources, and a catalog-specific social image.

## Truthful component documentation

- Generated each framework usage example from `STYLED_COMPONENT_CATALOG[*].demo`.
- Used the real component subpath, real named root export, real named part exports, canonical root props, part props, parent/child anatomy, and repeat cardinality.
- Removed the old generic and four-component handwritten snippet split.
- Added a compiler/export verifier covering all 61 components across React, Svelte, and Solid:
  - TypeScript parses every React and Solid example as JSX.
  - the Svelte compiler parses every Svelte example;
  - every imported root and part name exists in the built framework component subpath;
  - every example imports the shared styled-component stylesheet.
- Made the snippet verifier a blocking step in `build-uifn-catalogs.mjs`.

## Canonical accessibility documentation

- Added a deterministic generator from `uifn/catalog/generated/catalog.json` to the shared catalog source.
- Component pages now display the exact canonical native-semantics sentence, keyboard keys, focus requirements, and WCAG references for that primitive.
- Missing accessibility data throws during build instead of silently producing generic copy.
- The browser verifier compares rendered accessibility text with the canonical primitive entry on every component page.

## Documentation experience

- Added a persistent categorized 61-component navigation sidebar.
- Added Getting Started, Styling, Accessibility, and Registry/source-install guides.
- Added global command search, framework switching, copy-page output, GitHub navigation, and persistent light/dark theme switching.
- Added package versus owned-source installation tabs with npm, pnpm, yarn, and bun commands.
- Added preview/code tabs, copyable source-derived examples, props, anatomy, canonical accessibility requirements, states, QA links, capability summaries, and previous/next component navigation.
- Added a responsive off-canvas navigation drawer with focus transfer and restoration.
- Added explicit focus-visible styling for interactive documentation controls and scrollable code regions.

## Static delivery and discoverability

- Generated physical `index.html` files for all 935 framework routes, or 2,805 framework route documents in total.
- Added route-specific title, description, canonical URL, robots directive, Open Graph metadata, Twitter metadata, theme color, and `WebPage` JSON-LD.
- Marked QA and fixture routes `noindex,follow`.
- Added `robots.txt`, `sitemap.xml`, `/components/llms.txt`, `/components/llms-full.txt`, and a 1200 by 630 PNG social image.
- Added a useful noindex catalog 404 and changed the Cloudflare Worker fallback to return it with HTTP 404.
- Added a delivered manifest containing the 61-component, 3-framework inventory and static-route counts.

## Performance budget

- Added a blocking catalog-build performance verifier that loads the staged
  Dialog documentation page in every framework.
- The gate rejects missing resources, console errors, HTML above 20 KB, more
  than 25 initial JS/CSS requests, more than 1.5 MB decoded JS/CSS, more than
  350 KB Brotli-equivalent JS/CSS, or any single Brotli-equivalent asset above
  120 KB.
- Current deterministic results:
  - React: 12 JS/CSS requests, 1,234,153 decoded bytes, 248,107
    Brotli-equivalent bytes;
  - Svelte: 17 requests, 827,270 decoded bytes, 155,066 Brotli-equivalent
    bytes;
  - Solid: 4 requests, 775,944 decoded bytes, 130,295 Brotli-equivalent bytes.
- A live cold-load probe from the verification environment measured total
  transfers of about 312 KB, 199 KB, and 165 KB respectively, with largest
  contentful paint between 604 and 704 milliseconds.

## Production security

Every Worker response now includes:

- a restrictive Content Security Policy with framing and object embedding
  denied and only the application plus Cloudflare's injected analytics endpoints
  allowed;
- `Cross-Origin-Opener-Policy: same-origin`;
- a restrictive camera, geolocation, and microphone permissions policy;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- `X-Content-Type-Options: nosniff`;
- `X-Frame-Options: DENY`;
- the exact staged catalog build identity and exact Worker source hash.

The remote delivery gate requires every security header and both identities.
The final all-framework security regression passed 35/35 checks with no CSP or
runtime console error.

## Accessibility defects found and fixed

### Dark-theme catalog chrome contrast

The focused Dialog audit found insufficient contrast for the sidebar brand mark and active component link after the theme toggle switched to dark mode.

Fix:

- the brand mark foreground now follows the catalog background token;
- active navigation text now uses the high-contrast catalog ink token.

### Search filtering

The search interaction test found all 61 links still visually present after filtering for Tree View because the link's authored `display:flex` overrode the hidden presentation.

Fix:

- added an explicit hidden-result rule;
- the interaction gate now requires exactly one visible Tree View result.

### Scrollable code regions

The first complete Chromium matrix found 63 `scrollable-region-focusable` violations, all on long source examples.

Fix:

- every scrollable source `<pre>` now has a descriptive accessible label and `tabindex="0"`;
- keyboard focus has a visible three-pixel outline.

The unchanged complete Chromium rerun passed after this fix.

### Trailing-slash component routing

A fresh request to `/components/{framework}/components/dialog/` loaded the
route-specific Dialog HTML, but the hydrated client router treated the trailing
slash as a different route and rendered the framework home page.

Fix:

- added one shared catalog-path normalizer and applied it at the route lookup,
  base-path stripping, and base-path construction boundaries;
- added unit coverage for root, component, and trailing-slash paths;
- added a real trailing-slash Dialog page to every framework's browser matrix,
  including its title, composition, modal keyboard behavior, accessibility scan,
  responsive layout, and mobile navigation assertions.

## Component-gap handling

No new styled-component behavior defect remained after the current full component matrix. Every public page mounted one complete canonical component composition with every expected anatomy part, and the declared framework behavior checks passed.

The gaps found in this closure were catalog-owned: invented/fallback documentation data, incomplete examples, inaccessible catalog chrome, and incomplete delivery behavior. Those gaps were fixed in the shared catalog presentation, static builder, Worker, and verification gate rather than hidden with catalog-only component markup.

## Local validation evidence

- Full production catalog build:
  - 61 components;
  - 3 frameworks;
  - 935 routes per framework;
  - 2,805 statically addressable framework routes.
- Source-derived example gate: 183/183 checks passed with zero findings.
- Chromium: 215/215 checks passed, zero findings, zero failures.
- Firefox: 215/215 checks passed, zero findings, zero failures.
- WebKit: 215/215 checks passed, zero findings, zero failures.
- The final WebKit result comes from an isolated rerun with a 60-second navigation ceiling. A prior parallel run was discarded after host resource contention caused four empty navigation timeouts.
- Shared catalog tests: 15/15 passed, including the three routing-normalization regressions.
- Performance budgets: 3/3 framework checks passed with zero findings.
- All core dependencies and the React/Next.js, Svelte/SvelteKit, and Solid/SolidStart production catalogs built successfully.

Evidence:

- `uifn/.conduct/evidence/catalog-sites-chromium/verification.json`
- `uifn/.conduct/evidence/catalog-sites-firefox/verification.json`
- `uifn/.conduct/evidence/catalog-sites-webkit/verification.json`
- `uifn/.conduct/evidence/catalog-sites-smoke/verification.json`
- `uifn/.conduct/evidence/catalog-sites-production-smoke/verification.json`
- `uifn/.conduct/evidence/catalog-sites-production-security/verification.json`
- `uifn/.conduct/evidence/catalog-sites-production/verification.json`
- `uifn/.conduct/evidence/catalog-sites-performance/verification.json`
- `uifn/catalogs/dist/catalog-manifest.json`

## Deployment

Cloudflare production version:
`0d88fbf6-1cf2-4926-998e-9ca471caf169`

Public origins:

- `https://uifn.dev`
- `https://uifn-components.21n.workers.dev`

The first immediate public-domain verification reached an edge that was still
serving the previous 45-component release. The new release had uploaded
successfully, but the edge had not yet converged on the new manifest. That run
was rejected and retained as failed evidence rather than being described as a
catalog pass.

Fix:

- every response exposes the exact staged catalog build and a SHA-256 identity
  of the deployed Worker source;
- the deployment command checks the manifest, landing page, React/Svelte/Solid
  Dialog routes, and a real 404 until all six expose the exact asset and Worker
  identities plus the security policy for two consecutive passes;
- the remote browser verifier retries only explicit Playwright `net::ERR_*`
  navigation failures and records every retry separately, so temporary network
  loss cannot be confused with a product defect or silently ignored.

Final public verification:

- the public manifest reported 61 components and 2,805 statically addressable
  framework routes;
- `/components` returned a 308 redirect to `/components/`;
- slashless and trailing-slash Dialog component URLs returned HTTP 200;
- an unknown framework catalog route returned the useful catalog page with HTTP
  404;
- the focused production regression passed 38/38 checks with zero findings;
- the focused final security regression passed 35/35 checks with zero findings
  and zero runtime console errors;
- the complete production Chromium matrix passed 215/215 checks with zero
  findings, zero failures, and zero navigation retries after the final security
  Worker was deployed.

## Completion audit

- **Permanent package boundary:** source inspection confirms no authored styles
  in `@uifn/core` or the React/Svelte/Solid headless adapters; the styled
  packages depend on those adapters and the shared styled-component package.
- **Supported catalogs:** the only public catalog applications and manifest
  framework entries are React, Svelte, and Solid. Public catalog source contains
  no Angular or Vue target.
- **No invented components or examples:** all 183 framework/component examples
  parse and import real built exports; every public component page mounts the
  real styled package root and complete canonical anatomy.
- **Comparable documentation UX:** all three framework catalogs expose the
  complete 61-component navigation, guides, search, theme, package/source
  installation, preview/code, props, anatomy, accessibility, states, and
  previous/next navigation, with those interactions covered by the browser
  gate.
- **Accessibility:** canonical requirements are generated from the source
  catalog, missing data fails the build, and the complete component matrix has
  zero automated accessibility findings in Chromium, Firefox, and WebKit.
- **Production maturity:** deterministic static routing, SEO/discovery
  resources, useful HTTP 404 behavior, responsive behavior, performance
  budgets, security headers, exact build identities, atomic deployment
  sentinels, and public-domain verification are all implemented and passing.
- **Final identity:** the local and public catalog build is
  `2026-07-29T03:04:55.380Z`; the local and public Worker SHA-256 is
  `8f27c4a2d2f67f948536a250ec6724ad066409be96a69193293309de44162b59`.
