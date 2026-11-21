# Agent instructions

## Repository model

Two repositories share this tree (SFNS-121):

- `21nCo/superfunctions`, base branch `dev`: the public repository. Published functions and every shared path are developed here.
- `21nCo/super-functions.next`, base branch `next`: private. It holds the functions that are not yet published, plus a copy of everything public that the sync keeps up to date.

**If this checkout is `21nCo/super-functions.next`, also read `NEXT.md`.** It holds the `next`-only instructions; this file states the model both repositories share. `git remote get-url origin` tells you which checkout you are in.

### The invariant

Every path has exactly one owner repository, and every npm package and Python project has exactly one publishing repository. Shared code flows one way only: from public `dev` to `next`, through the sync.

- `superfunctions.owners.json` lists everything the public repository owns: top-level directories, root files, release slugs and Python projects. It exists in both repositories. On `dev`, a path or package it does not list is an error.
- `superfunctions.owners.next.json` exists only on `next` and lists the `next`-owned entries. On `next`, a path it does not list is public-owned.
- `package-lock.json` and `Package.resolved` are generated: each repository regenerates its own and they are never ported.
- `node scripts/verify-owners.mjs` checks the manifests against the tree, and `node scripts/verify-public-boundary.mjs` fails when the public tree holds a path, package or dependency the public manifest does not allow, so `next`-only content stays out of the public repository. CI runs both.

### Find a path's owner

```sh
node scripts/owners.mjs <path>...     # prints "<path>: public", "next" or "generated"
```

Paths are relative to the repository root. On `dev` an unlisted path is an error (exit status 1); `--repo public|next` selects the other repository's rules. Edit a path only in the repository that owns it. A change to a public-owned path made on `next` is overwritten or conflicts at the next sync.

### Where shared fixes land

A shared fix needed by a `next` function lands on `dev` first and reaches `next` through the sync. Do not make it on `next`, even when only a `next` function needs it today. Packages publish only from the repository that owns them: the publish workflows refuse a tag for another repository's package.

### The sync

The sync is a real merge of `dev` into `next`, never a squash or rebase, so the merge base keeps advancing. It runs on `next` from the branch `sync/dev` as one standing PR, triggered by every push to `dev`, nightly and by hand. It merges itself when `next`'s CI and the ownership guard pass and every public-owned path is identical to `dev`. Otherwise the PR stays open, labelled `sync-blocked`, with the failing check named in a comment. Do not hand-port public changes to `next`; wait for the sync, or fix what blocks it.

Workflows in `.github/workflows` are public-owned and reach `next` through the sync. A job that must not run on `next` carries `if: github.repository == '21nCo/superfunctions'`, which `verify-owners` checks.

### Promotion

A `next` function moves to the public repository when it is ready to publish. `scripts/promote.mjs` imports its directory from `next` with history and makes it public-owned in the manifests and release lists. It moves code only: the operator moves the function's open Linear issues as the script lists. Follow `scripts/promote.md`. Never copy a `next` directory into `dev` by hand.

### Linear issues

Every Linear issue for either repository starts with a line naming the repository and base branch it changes:

```text
Repository: <repo>, base branch <branch>
```

For example `Repository: 21nCo/superfunctions, base branch dev` or `Repository: 21nCo/super-functions.next, base branch next`. Work in the checkout and branch it names; if the issue would change a path the other repository owns, stop and say so instead of editing it.

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
