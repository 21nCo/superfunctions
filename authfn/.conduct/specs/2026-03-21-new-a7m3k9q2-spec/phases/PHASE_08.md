# Phase goal

Ship the Svelte adapter, shared OpenAPI integration, and full end-to-end hardening.

# In scope / Out of scope

- In scope: Svelte store helpers, OpenAPI generation wiring, final integration tests, documentation
- Out of scope: migration/cutover docs

# Deliverables

- `authfn/svelte/src/session-store.ts`
- `authfn/svelte/src/__tests__/session-store.test.ts`
- `authfn/core/src/openapi.ts`
- `authfn/core/src/__tests__/openapi.test.ts`
- `authfn/core/src/__tests__/integration-browser.test.ts`
- `authfn/core/README.md`
- `authfn/python/README.md`

# Requirements covered

- `CLIENT-001`
- `OAS-001`
- `OBS-001`

# Implementation tasks

1. Add Svelte helpers over the client.
2. Wire shared OpenAPI generation into `authfn`.
3. Add integration tests covering password, OTP, social, 2FA, API keys, region lookup, and sign-out in one composed deployment.
4. Update package READMEs with the new architecture and route surface.

# Verification steps

- Run `npm test --workspace @authfn/svelte`
- Run `npm test --workspace @authfn/core -- openapi integration-browser`
- Generate and inspect the OpenAPI document
- Expected outcome: end-to-end browser flows are covered and the OpenAPI document is stable.

# Stop condition

Report final package inventory, generated OpenAPI summary, and end-to-end verification results.
