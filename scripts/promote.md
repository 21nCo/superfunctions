# Runbook: promote a path from `next` to public `dev`

`scripts/promote.mjs` (SFNS-127) moves a function directory, or individual paths, from `21nCo/super-functions.next`
(`next`) to public `dev` with their history (SFNS-121 D9). It makes them public-owned in `superfunctions.owners.json`,
moves their release entries out of `next`'s overlays (D3, D8) and prints the Linear move list (D11). It moves code
only: it pushes nothing and moves no Linear issues.

This runbook lives under `scripts/` rather than `docs/`, because `docs/` is imported from `next` by SFNS-129 and a
`docs/` directory on `dev` would conflict with that import.

## Before you start

1. **Freeze the path on `next`.** Announce the promotion and hold every open `next` PR that touches the path (mark
   them draft or label them `promotion-freeze`). Do not merge anything into the path on `next` until the promotion
   PR has merged on `dev` and the next `dev` → `next` sync has landed; a commit after the pin is not imported, and the
   sync would then conflict with it.
2. **Archive `.conduct/` on `next`** (D1). The script refuses a pin whose tree still holds `.conduct` files under the
   path. Older commits that held them are stripped from the imported history.
3. **Check the whole history is publishable.** Every imported commit and every file version in it becomes public,
   including content deleted or overwritten before the pin; the Public boundary check reads only the final tree. On
   `next`, read every historical patch, merge changes included, for credentials, customer data or private planning
   notes (a file list such as `--stat` does not show contents):

   ```sh
   git log -p -m --text <pin> -- <path>...
   ```

   Then list the binary files the history ever held, and inspect each historical version of each one separately
   (`git cat-file -p <blob> > <file>`, then open it):

   ```sh
   git log -m --numstat --format= <pin> -- <path>... | awk -F'\t' '$1 == "-" { print $3 }' | sort -u
   git log -m --raw --no-abbrev --format= <pin> -- <binary path> | awk '{ print $4 }' | sort -u   # blob ids
   ```

   If any version holds something private, do not promote with history: import the content without history instead
   (D9).
4. Install `git-filter-repo`: `python3 -m pip install git-filter-repo` (or `brew install git-filter-repo`).

## Promote

```sh
git fetch origin dev && git fetch next
git switch --detach origin/dev            # or any clean branch that contains origin/dev
node scripts/promote.mjs <fn>             # a whole function directory, pinned at next/next
node scripts/promote.mjs --path <path> [--path <path>...] --pin <next-sha>
```

Record the pin the script prints. The script refuses, and changes nothing, when:

- the working tree has uncommitted or untracked changes;
- the current branch does not contain `origin/dev` (`--base` names another ref);
- a path already exists on the branch with content or a file mode that differs from `next` at the pin. `--reconcile` merges it
  anyway and leaves the conflicts for you (exit status 2): resolve them, `git add` them and `git commit`;
- a `--path` lies inside a top-level directory `superfunctions.owners.json` does not list (promote the whole
  directory instead), or names a file the script edits or a `next`-only file (manifests, release lists, lockfiles);
- a release slug or npm name it would move is already listed in `release-packages.json` with other values, or two
  imported entries share a slug or npm name: fix `next`'s overlay first;
- the imported Python projects do not form one consistent set (names are compared in canonical form): two imported
  `pyproject.toml` files share a name; two `python-release-packages.next.json` entries under the paths share a name or
  a directory; an overlay entry does not name the imported `pyproject.toml` project in its own directory; or this
  branch (a `pyproject.toml` or a `TARGETS` entry) holds an imported name in another directory, or another name in an
  imported project directory; or a released project (an overlay entry under the paths, or a `TARGETS` entry here)
  is not spelled exactly as its canonical name in both its `pyproject.toml` and the overlay or `TARGETS`
  (`scripts/python_release.py` matches the tag name to `project.name` exactly). Fix `next` first;
- a file it reads (`release-packages.json`, the manifest, a `pyproject.toml` at the pin) is malformed;
- `git-filter-repo` is missing (it prints the install command).

`--source <repo>` fetches the pin from another repository: a URL, or a local path resolved against your current
directory. It needs `--pin`, since the `next/next` default exists only in this checkout.

It creates `promote/<fn or first path>` from the current commit with:

1. a merge commit (`--allow-unrelated-histories`) whose second parent is the imported history of the paths;
2. a commit that sets the paths, release slugs and Python projects to `public` in `superfunctions.owners.json`,
   appends the moved entries to `release-packages.json` and adds moved Python projects to `TARGETS` in
   `scripts/python_release.py`. Paths and packages that were already public produce no commit.

For a pin from before `next` had `release-packages.next.json`, release entries come from `next`'s
`release-packages.json`. Entries `dev` already lists identically (in `release-packages.json` or `TARGETS`) are not
appended again, but they are still set to `public` in the manifest and listed under "On next" for removal, so a
retry or a partial cutover leaves no duplicates on `next`.

## After the script

1. Check the result: `git log --follow -- <path>/<file>` shows the `next` history, and
   `git diff <next-sha> HEAD -- <path>` is empty (the script already checks this unless `--reconcile` was used).
2. Run `npm install` to refresh `package-lock.json`, then `node scripts/verify-owners.mjs` and
   `node scripts/verify-public-boundary.mjs`. Commit any lockfile change.
3. Bump the version of any package that was already published from `next` above its highest npm version (D8).
4. Push the branch and open a PR to `dev`. **Merge it with a merge commit**: a squash or rebase merge drops the
   imported history.
5. On `next`, remove the entries the script lists under "On next" from `superfunctions.owners.next.json`,
   `release-packages.next.json` and `python-release-packages.next.json` before the next sync merges the promotion;
   otherwise the owner and release checks on `next` fail with duplicate entries.
6. Move Linear issues (D11): every open SF Next issue of the promoted code moves to its public team (for example
   Docsfn or Probefn), or to SFNS when none exists. Closed issues stay. Start from the issue identifiers and search
   terms the script prints.
7. Lift the freeze on `next` once the sync carrying the promotion has merged there.
