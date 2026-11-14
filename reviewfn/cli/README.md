# @superfunctions/reviewfn-cli

Installs the `reviewfn` binary. Commands: `init` (`--panel` writes a panel policy template), `preflight`, `review`, `panel`, `report` (`--panel` re-renders a stored panel report), `publish`, `render`, and `evaluate`. See [panel review](../docs/panel.md) for `reviewfn panel` and its exit codes. The Codex harness adapter is a direct dependency; the `claude-code` and `cli` adapter packages are not published yet and will resolve once installed next to the CLI. Run from a Git worktree with Node.js 22 or newer.
