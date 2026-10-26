# Packed runtime acceptance

Validated 2026-10-15 using actual local tarballs for drawfn 0.0.2, @drawfn/react 0.0.3 and @drawfn/svelte 0.0.3. `drawfn/scripts/packed-consumer.mjs` installs all three into an isolated npm consumer, with TypeScript, declarations, and esbuild in development dependencies.

All checks pass:

- TypeScript 5.9.3 strict Node16 and NodeNext `.mts`/`.cts` consumers, including Svelte component subpath declarations and explicit dynamic imports from CommonJS.
- ESM imports of all three packages, CommonJS imports of core/React, and dynamic Svelte imports from CommonJS.
- React SSR and actual compiled Svelte component SSR without browser globals.
- Runtime checks on Node 18.18.0 (declared minimum), 20.20.2, and 22.23.3.
- `npm audit --omit=dev`: zero vulnerabilities, with 29 production dependencies. The npm metadata total includes 32 development dependencies and optional platform packages; the vulnerability audit excludes development tools.

The Svelte package now has an explicit ESM-only contract, matching its dependency's runtime. Its declaration surface uses the public `Readable` subscribe type rather than leaking the removed `Invalidator` type. It requires patched Svelte ^5.57.2 for development and consumers. Core/React retain ESM and CJS.

The earlier Svelte 4.2.20 functional consumer was affected by six upstream advisories grouped as one moderate vulnerable package. Svelte 4 is intentionally excluded from the final supported peer range; functional browser compatibility alone did not satisfy the runtime security gate. Its historical audit remains at `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/drawfn-framework-matrix-kJbSly/svelte-4/audit-runtime.json`.

Final packed consumer, runtime versions, full audit JSON, tarballs and compiler fixtures are retained at `/var/folders/cy/t2l5q3kn0wq2zjr9ljyqhwzc0000gn/T/drawfn-packed-consumer-Tm60Yy`. Run `node drawfn/scripts/packed-consumer.mjs` after building all three packages to reproduce; it uses npm/npx to install the isolated consumer and exact Node runtimes.
