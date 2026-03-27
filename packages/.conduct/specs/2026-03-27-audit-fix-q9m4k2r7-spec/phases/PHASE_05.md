# Phase goal

Repair shared OAuth documentation and package ergonomics so public guidance matches the hardened contracts.

# In scope / Out of scope

- In scope: package READMEs, shared docs pages, auth docs navigation, architecture guidance
- Out of scope: verification runner implementation details beyond documenting the commands

# Deliverables

- `packages/oauth-core/README.md`
- `packages/oauth-http/README.md`
- `packages/oauth-storage/README.md`
- `packages/oauth-providers/README.md`
- `packages/oauth-flow/README.md`
- `packages/oauth-testing/README.md`
- `packages/oauth-router/README.md`
- `docs/content/docs/authentication/meta.json`
- `docs/content/docs/authentication/oauth-storage.mdx`
- `docs/content/docs/authentication/oauth-flow.mdx`
- `docs/content/docs/authentication/oauth-providers.mdx`
- `docs/content/docs/authentication/oauth-router.mdx`
- `docs/content/docs/architecture/oauth-flow-architecture.mdx`

# Requirements covered

- `DOCS-001`
- `DOCS-002`
- `COMPAT-001`

# Implementation tasks

1. Correct `oauth-storage` default table/model references from `oauth_token_vault` to `oauth_tokens`.
2. Rewrite `oauth-flow` quick-start and production examples so encrypted storage is the primary path.
3. Add provider-policy durability caveats to `oauth-providers` docs and README.
4. Add a new `oauth-router` docs page and register it in auth docs navigation.
5. Add package-local READMEs for every audited OAuth package with boundary, install, quick start, safety caveats, and compatibility notes.
6. Update the architecture page to mention `oauth-router`, encrypted-default storage, and policy persistence.

# Verification steps

- Run `rg -n 'oauth_token_vault' packages/oauth-storage/README.md docs/content/docs/authentication/oauth-storage.mdx`
- Run `rg -n 'EncryptedTokenVault|plaintext-unsafe|in-memory convenience|oauth-router' packages/oauth-*/README.md docs/content/docs/authentication/*.mdx docs/content/docs/architecture/oauth-flow-architecture.mdx`
- Expected outcome: old incorrect storage-name references are gone from the targeted docs, encrypted-first guidance is present, and router docs/readme inventory is complete.

# Stop condition

Report the final README/docs inventory and the exact docs files that changed production guidance.

