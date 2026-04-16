# Phase goal

Implement the `datafn/extfn` package with background authority, proxy clients, remote sync, and subscription fanout, aligned to the current public `@datafn/client` surface on `next`, then validate it with an example extension.

# In scope / Out of scope

- In scope:
  - `datafn/extfn` package
  - background authority startup
  - proxy clients for non-background contexts
  - DataFn request and subscription routes
  - Svelte DataFn example extension
- Out of scope:
  - `authfn` or `searchfn` extension integrations

# Deliverables

- Create `datafn/client/src/extension/index.ts`
- Modify `datafn/client/src/index.ts`
- Create `datafn/extfn/src/index.ts`
- Create `datafn/extfn/src/plugin.ts`
- Create `datafn/extfn/src/authority.ts`
- Create `datafn/extfn/src/proxyClient.ts`
- Create `datafn/extfn/src/subscriptions.ts`
- Create `datafn/extfn/src/routes.ts`
- Create `datafn/extfn/__tests__/authority.test.ts`
- Create `datafn/extfn/__tests__/proxyClient.test.ts`
- Create `datafn/extfn/__tests__/subscriptions.test.ts`
- Create `extfn/examples/svelte-datafn-demo/extfn.config.ts`
- Create `extfn/examples/svelte-datafn-demo/vite.config.ts`
- Create `extfn/examples/svelte-datafn-demo/svelte.config.js`
- Create `extfn/examples/svelte-datafn-demo/src/background/index.ts`
- Create `extfn/examples/svelte-datafn-demo/src/popup/*`
- Create `extfn/examples/svelte-datafn-demo/src/options/*`
- Create `extfn/examples/svelte-datafn-demo/src/contents/*`

# Requirements covered

- `DFX-001`
- `DFX-002`
- `DFX-003`
- `MSG-001`
- `MSG-003`
- `EX-001`
- `REUSE-001`

# Implementation tasks

- Reuse or adapt existing `datafn/client` extension transport semantics in a repository-owned package under `datafn/extfn`.
- Expose any needed extension helpers from `@datafn/client` through a public export surface before `@datafn/extfn` consumes them.
- Compose existing `@datafn/client` primitives for extension transport, remote subscription management, and IndexedDB-backed storage before introducing any new extfn-specific wrapper code.
- Keep `DatafnExtfnOptions` aligned to the real `DatafnClientConfig` shape on this branch and remove unsupported configuration such as `authContext`.
- Ensure `createDatafnExtfnProxyClient()` returns a `DatafnClient`-compatible surface rather than an untyped placeholder.
- Ensure active proxy subscriptions recover cleanly after background restart or fail explicitly without duplicate registration.
- Implement background authority startup that creates the canonical DataFn client and owns storage and sync.
- Implement proxy client creation for popup, options, sidepanel, and content contexts.
- Implement request routes for query, mutation, transact, seed, clone, pull, push, reconcile, subscribe, and unsubscribe.
- Implement subscription fanout from background to proxy contexts.
- Prevent non-background contexts from starting authority mode.
- Create a Svelte example extension that demonstrates background-owned DataFn storage with popup and content-script consumers.

# Verification steps

- Run `npm run test -- --filter=@datafn/extfn`
- Run `npm run build -- --filter=svelte-datafn-demo`
- Expected outcomes:
  - authority startup tests pass in background fixtures
  - non-background authority startup fails with the expected error code
  - subscription cleanup tests show no leaked registrations
  - reconnect tests show one restored subscription or one explicit failure, never duplicate registrations

# Stop condition

Stop after DataFn authority, proxy, and subscription tests pass and the DataFn example builds.
