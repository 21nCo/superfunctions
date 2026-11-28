# Agent instructions

## Repository model

Two repositories share this tree (SFNS-121):

- `21nCo/superfunctions`, base branch `dev`: the public repository. Every shared path and every public-owned function is developed here.
- `21nCo/super-functions.next`, base branch `next`: private. It holds the `next`-owned functions, plus a copy of everything public that the sync keeps up to date.

The ownership manifests below decide where a path or package lives, not whether it has been published. The target is that a function moves to the public repository when it is ready to publish. A function already published from `next` stays `next`-owned until it is promoted, and only `next` may publish it; for now the release gate (`scripts/assert-release-ci.mjs`) refuses every CI-gated `next` release until SFNS-160 proves `next`'s CI.

**If this checkout is `21nCo/super-functions.next`, also read `NEXT.md`.** It holds the `next`-only instructions; this file states the model both repositories share. `git remote get-url origin` tells you which checkout you are in.

### The invariant

Every path has exactly one owner repository, and every npm package and Python project has exactly one publishing repository. Shared code flows one way only: from public `dev` to `next`, through the sync.

- `superfunctions.owners.json` lists everything the public repository owns: top-level directories, root files, release slugs and Python projects. It exists in both repositories. On `dev`, a path or package it does not list is an error.
- `superfunctions.owners.next.json` exists only on `next` and lists the `next`-owned entries. On `next`, a path it does not list is public-owned.
- `package-lock.json` and `Package.resolved` are generated: each repository regenerates its own and they are never ported.
- `node scripts/verify-owners.mjs` checks the manifests against the tree, and `node scripts/verify-public-boundary.mjs` fails when the public tree has a tracked top-level path or a release or workspace package that `superfunctions.owners.json` does not list, or a `*fn` import or dependency that is neither a public workspace package nor allowed in `scripts/public-boundary.allow.json`. CI runs both. The boundary check covers only those rules: it does not look for other `next`-only content in files under allowed directories, or in the history a promotion imports, so review those yourself (see `scripts/promote.md`).

### Find a path's owner

```sh
node scripts/owners.mjs <path>...     # prints "<path>: public", "next" or "generated"
```

Paths are relative to the repository root. On `dev` an unlisted path is an error (exit status 1). `--repo public|next` selects which repository's rules apply; the default is `next` when `superfunctions.owners.next.json` is present and `public` otherwise. Only a `next` checkout has the `next` manifest, so on `dev` `--repo next` answers only for paths the public manifest lists and fails (exit status 1) for any other path, such as `NEXT.md`, instead of guessing: ask in a `next` checkout. Edit a path only in the repository that owns it. A change to a public-owned path made on `next` is overwritten or conflicts at the next sync.

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

For example `Repository: 21nCo/superfunctions, base branch dev` or `Repository: 21nCo/super-functions.next, base branch next`. Work in the checkout and branch it names. An issue that creates a new `next`-owned entry registers it in `superfunctions.owners.next.json` on `next`, because an unregistered path there is public-owned. A change to an existing public-owned path lands on `dev` first, never on `next`. If the issue would change a path the other repository owns in any other way, stop and say so instead of editing it.

## Bare npm package names

- Every product's unscoped (bare) npm package is its front door. `superfunctions` (bare) is the Superfunctions CLI (`@superfunctions/cli`, bins `superfunctions` and `sfs`), never a barrel of all packages.
  - With a CLI, the bare package's `bin` maps the product name to the CLI executable, so `npx <name>` runs it. With a core SDK, `exports["."]` is that core (a re-export of `@<scope>/core` is fine), so `import … from "<name>"` gives the core.
  - A product with a CLI but no SDK ships only the bin. An SDK with no CLI ships only the core export, and adds the bin later (adding it doesn't break importers). A product with neither gets no bare package.
- A bare package belongs to, publishes from and is registered in the owners manifest of the same repository as the product's scoped packages. `publish-tag.yml` builds it in the same release, at the same version as whichever of `@<scope>/core` and `@<scope>/cli` the product has, through OIDC trusted publishing (one trusted publisher per bare name; never npm tokens). The README's name-claim step (a `0.0.0` publish so the trusted publisher can be attached) still applies to a new bare name; no placeholder ships past it.
- When the bare package also exports a core, keep the CLI's heavy dependencies out of its default install graph, direct or through `@<scope>/cli`: the bin loads them lazily and makes the version-matched CLI available when it runs, so SDK importers don't install, load or bundle them. A CLI-only bare package such as `superfunctions` just depends on what its CLI needs.
- Scoped packages stay canonical for granular imports. Names npm refused as "too similar" use their scopes only. No placeholder bare packages: each released one is the CLI and/or the core.

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
