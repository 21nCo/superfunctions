# Optional framework package acceptance

2026-10-20 checkpoint. Run after building WatchFn and its shared dependency closure:

```sh
NPM_CLI=/path/to/npm-cli.js node watchfn/scripts/packed-adapters-acceptance.mjs
```

The script packs fresh local tarballs, creates five independent temporary consumers, and installs only the selected framework and its shared HTTP adapter alongside WatchFn/core dependencies. It asserts that the other four frameworks are absent. Installation uses normal peer resolution with neither force nor legacy-peer flags. All temporary consumers are removed.

On Node20.20.0 with npm11.21.0, all ten runtime cases passed: ESM imports and genuine synchronous CommonJS `require()` for each optional subpath.

| Integration | Framework tested | Request execution |
| --- | --- | --- |
| Express | 4.22.1 | Real loopback HTTP server |
| Fastify | 5.6.2 | Framework injection |
| Hono | 4.11.9 | Framework request handler |
| Next | 15.5.12 | App Router handler with request/context fixture |
| SvelteKit | 2.69.3 | Route handler with RequestEvent fixture |

Every case verifies that invalid credentials return401, authenticated ingestion returns202 with accepted count1, the complete event envelope survives storage/query, and request tracking emits exactly once per request with statuses401/202. Both the core and selected adapter subpath load without installing unrelated frameworks.

This is optional-adapter runtime/package evidence. Next/SvelteKit checks do not run complete framework applications, deployment or framework builds. Adapter declarations and additional Node/framework versions are not established by this script. No full-framework dependency audit success is claimed; the known Svelte dependency finding remains unresolved. Broader WatchFn production readiness remains open.
