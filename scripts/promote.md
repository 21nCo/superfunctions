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
   `next`, read every historical patch, merge changes and side branches a merge discarded included, for credentials,
   customer data or private planning notes (a file list such as `--stat` does not show contents; `--full-history`
   keeps git from skipping a side branch whose changes the merge did not keep, which promotion still imports):

   ```sh
   git log -p -m --text --full-history <pin> -- <path>...
   ```

   The script then lists every non-text or image file version it imports (see "After the script"); you inspect
   those there.

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
  anyway. When that leaves conflicts (exit status 2), this checkout stays as it was and the merge waits, with the
  manifest and release edits staged, in a worktree on the promotion branch whose path the script prints: resolve the
  conflicts there, `git add` them and `git commit`, then `git worktree remove <path>` and `git switch <branch>` here;
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
- (`checkout-policy`) git would build the branch under other configuration than this checkout's: the script builds
  it in a linked worktree and refuses rather than emulate configuration there. That is the case when git loads
  different configuration in a linked worktree (an `includeIf "gitdir:..."` that matches only this checkout's git
  directory or only linked worktrees, an `includeIf "onbranch:..."` for the current branch, `config.worktree`), when
  `core.hooksPath` is relative, when another value climbs out of the work tree with `..` (a `gpg.program`,
  `core.fsmonitor` or merge driver; include paths and URLs excepted), also when only the promotion branch's `onbranch`
  configuration sets it, or when `core.worktree` is set. Run it from a detached checkout as shown above; if it still refuses, run it from a separate
  clone without checkout-specific configuration rather than weakening this checkout's;
- this checkout's commit, branch or working tree changes while the script runs (the branch is planned from the commit
  it started on), or an object of the imported history cannot be read;
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
2. Inspect every version under "Historical non-text and image versions" in the script's output: the object id, the
   kind (`image` for anything to render, also when stored as text: SVG, PNM, XPM, XBM, PostScript/EPS, PDF; or
   `binary`) and every path it was imported under, as JSON strings. The script reads these from the
   exact filtered history it imports, deleted and side-branch versions included, and stops if any object cannot be
   read. Save each one with `git cat-file blob <id> > <file>` and open it; render every `image` version, also those
   stored as text (an ASCII PPM, an SVG), which the patch review above shows only as numbers or markup. If any
   version holds something private, return to the commit you started from (`git switch --detach ORIG_HEAD`, which
   the script sets to it), delete the branch (`git branch -D <branch>`) and import the
   content without history instead (D9).
3. Run `npm install` to refresh `package-lock.json`, then `node scripts/verify-owners.mjs` and
   `node scripts/verify-public-boundary.mjs`. Commit any lockfile change.
4. Bump the version of any package that was already published from `next` above its highest npm version (D8).
5. Push the branch and open a PR to `dev`. **Merge it with a merge commit**: a squash or rebase merge drops the
   imported history.
6. On `next`, remove the entries the script lists under "On next" from `superfunctions.owners.next.json`,
   `release-packages.next.json` and `python-release-packages.next.json` before the next sync merges the promotion;
   otherwise the owner and release checks on `next` fail with duplicate entries.
7. Move Linear issues (D11): every open SF Next issue of the promoted code moves to its public team (for example
   Docsfn or Probefn), or to SFNS when none exists. Closed issues stay. Start from the issue identifiers and search
   terms the script prints.
8. Lift the freeze on `next` once the sync carrying the promotion has merged there.
