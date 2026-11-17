# Agent instructions

## Codex hooks (Entire)

- Entire's Codex hooks live in the global Codex config (`~/.codex/hooks.json`). Do not add or commit a repo-level `.codex/hooks.json`.
- `entire enable` and `entire agent add codex` write `.codex/hooks.json` into the repo. If you run either one, delete that file afterwards; it is gitignored so it should never reach a commit.
- If the Entire hooks are missing on your machine, add them to `~/.codex/hooks.json`, not to this repo.

## Test fixtures and secret scanning

GitGuardian scans every commit of every PR. A later commit cannot clear a value it flags, so each finding needs manual triage in the dashboard. In 30 days to 2026-11-17, all 11 findings on this repository were made-up test values.

- Made-up tokens, keys, secrets, passwords, IDs and signatures in tests, fixtures, docs and examples must look fake: low entropy and self-describing, such as `test-app-account-token`, `test-password`, `example-api-key` or the UUID `00000000-0000-4000-8000-000000000001`. Do not put random-looking strings (generated UUIDs, base64, long hex) under names like `token`, `secret`, `key`, `password` or `auth`.
- When a format check needs a realistic shape, build the value in the test (for example, base64-encode a readable string) rather than committing an opaque literal.
- When a test needs a published external vector, such as the Standard Webhooks signing vectors or an RFC example, do not change its values, and cite its source in a comment next to it. Build its secret-shaped parts at runtime from their bytes or plain text instead of committing the encoded literal, as `referenceSecret` does in `billfn/provider-dodo/src/__tests__/contract.test.ts` (or `btoa('Aladdin:open sesame')` for the RFC 7617 example). Only when that is not possible, commit it verbatim and say in the PR description that GitGuardian may flag it as a test credential.
- Credentials for throwaway CI services are built per run, never written as literals (see the `format()` values in `.github/workflows/storage-r2-minio.yml`).
- Never commit a real secret, even temporarily.
