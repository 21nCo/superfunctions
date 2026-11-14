---
title: Panel review CLI
description: Run a review panel, its exit codes, harness adapters, outputs and report rendering.
---

A panel review runs several harness slots over one frozen change and combines their findings into one advisory panel report. The panel policy, slot identity, quorum and report contract are described in the [panel report schema](panel-report-schema.md). This page covers the CLI.

## Commands

```sh
reviewfn init --panel
reviewfn panel --base REF --head REF [--since SHA] [--issue KEY] [--pull-request N] [--panel FILE] [--output DIR] [--trusted-config-from-base] [--json]
reviewfn report --panel [--input FILE]
reviewfn publish --input .reviewfn/output/panel-report.json --repository OWNER/REPO --pull-request N --head SHA
```

- `reviewfn init --panel` writes `.reviewfn/panel.json` and refuses to overwrite an existing file. The template has a general stage-1 slot, which also extracts requirements, and a general stage-2 slot, both on the Codex harness. Each slot's `harness.version` is the exact version the harness reports, such as the output of `codex --version`. Update it to match the installed harness; a run that reports another version never counts.
- `reviewfn panel` loads `.reviewfn/config.json`, `.reviewfn/policy.json` and `.reviewfn/panel.json`. In GitHub Actions, or with `--trusted-config-from-base`, it reads them from the base revision, and a head copy of the panel policy may only tighten the base copy. It reviews a private snapshot of the repository at the head commit. `--since` names an earlier reviewed commit. Slots review only the change since that commit (a delta panel) when the panel policy sets `incremental: "delta"`; the `init --panel` template sets `"full"`, under which every slot reviews the whole change and `--since` only records the commit in the report. `--issue` selects the issue for context adapters. `--pull-request` binds the run to a pull request, as in 0.1. `--panel FILE` reads the panel policy from another repository-relative path.
- `reviewfn report --panel` re-renders a stored panel report (`.reviewfn/output/panel-report.json` by default) after checking its structure. Without `--panel`, it renders a 0.1 `report.json`.
- `reviewfn publish` accepts a panel report as well as a 0.1 report. A panel report publishes under the `panel` profile only, as one summary comment and one neutral `ReviewFn / panel` check. Publishing the same run again updates them; a canceled run is never published. Publication stays a separate, credentialed job.

## Outputs

The run writes `panel-report.json` and `panel-report.md` to the output directory (`.reviewfn/output` by default). Its evidence, including each slot's redacted output, the context manifest and the stored panel report, is kept in the content-addressed store under `.reviewfn/artifacts`, with the retention the policy sets. The two report copies have the same report retention (the smaller of the config and policy `reportDays`): each run expires old artifacts and copies, and idle stores need the scheduled cleanup described in [security](security.md). Add both directories to the repository's ignore rules.

Without `--json`, the rendered Markdown is printed on stdout. With `--json`, stdout carries exactly one JSON line, printed only after the run's private snapshot is removed, `{"report":"<absolute path of panel-report.json>","runId":"<run ID>"}`, for scripting. Either output is printed only for exit 0, exit 2, and an exit 4 whose saved report records the cancellation, and only when the private snapshot was removed. Every other exit, including an exit 1 after the report was saved (retention cleanup failed or the private snapshot could not be removed), leaves stdout empty. Each error is one JSON object per line on stderr, `{ "error": "<code>", "message": "…", "details": … }`. A private snapshot that cannot be removed always adds a `REVIEWFN_SNAPSHOT_CLEANUP_FAILED` line whose `details.snapshot` names the directory to delete; it turns exit 0 or 2 into exit 1 and leaves exits 1, 3 and 4 unchanged.

## Exit codes

The exit codes form a closed set. The verdict never changes the exit code, because panel output is advisory.

| Code | Meaning |
| --- | --- |
| 0 | The run completed and its coverage is complete. |
| 2 | The run completed with incomplete coverage, or a stage's quorum was not met. The report is written. |
| 3 | Preflight failed: invalid configuration or panel policy, a panel policy the head weakens, an unsupported or missing harness adapter, a `--base`, `--head` or `--since` ref that does not name a commit, or a component's preflight refused the run. No report is written. |
| 4 | The run was canceled (SIGINT or SIGTERM). A failure while canceled before the report copies are saved, including a preflight or setup step that the cancellation interrupted or a report copy that could not be written, also exits 4. A run that exits 4 leaves one of two results. Either nothing of the run is saved: no artifact is imported into `.reviewfn/artifacts` and no report copy is written. Retention cleanup, which runs first, may still expire earlier copies whose retention has ended, and if a failed write also fails to restore the earlier `panel-report.md`, the error says so. Or both copies are saved, and the report records the cancellation; `reviewfn publish` and the GitHub publisher refuse such a report as canceled. Saving writes the two copies first and then imports the evidence. A cancellation that arrives once the copies are being written does not stop the save, and the run exits as if it had not been canceled (0, 2, or 1 if a later step fails). |
| 1 | Any other error, such as an invalid argument (including a value flag given without a value or with an empty one, such as `--output=`), a private repository snapshot or run directory that cannot be created, an output directory that cannot be written (neither copy is then written), a run whose copies were saved but whose evidence could not be imported, a completed run whose retention cleanup failed (`REVIEWFN_RETENTION_CLEANUP_FAILED`), or a completed run whose private repository snapshot could not be removed. In the last two cases the report is saved, but stdout stays empty. |

## Harness adapters

A slot's `harness.adapter` is resolved through a fixed table to an installed package, and adapters are never loaded from arbitrary module paths. The intended model is that adapters are optional peer installs. In this release the Codex adapter, `@superfunctions/reviewfn-harness-codex`, ships as a direct dependency of the CLI. The `claude-code` and `cli` packages are not published yet; once they are, each resolves when it is installed next to the CLI, and until then a slot naming them fails with `REVIEWFN_HARNESS_NOT_INSTALLED`:

| `harness.adapter` | Package | Export |
| --- | --- | --- |
| `codex` | `@superfunctions/reviewfn-harness-codex` | `CodexHarnessAdapter` |
| `claude-code` | `@superfunctions/reviewfn-harness-claude-code` | `ClaudeCodeHarnessAdapter` |
| `cli` | `@superfunctions/reviewfn-harness-cli` | `CliHarnessAdapter` |

The CLI constructs each adapter once with `{ executable?, environment }`. The executable is passed only to the adapter that `config.harness` names. A slot whose adapter package is not installed fails preflight with `REVIEWFN_HARNESS_NOT_INSTALLED`. An adapter outside the table fails with `REVIEWFN_HARNESS_UNSUPPORTED`. A package that does not export a matching adapter fails with `REVIEWFN_HARNESS_LOAD_FAILED`. For an adapter other than the configured harness, the adapter contract version is read from its capabilities before any preflight. Verifier slots are not run by this release, so their adapters are not loaded.

## Report rendering

The Markdown report shows:

- the run summary: run ID, reviewed head, base, coverage, verdict and finding counts;
- coverage limits;
- a table with each slot's stage, lens, harness, model and terminal state, with the reasons for a `void` run and, for a `collapsed` run, the slot whose identity it shares;
- the requirements summary, when the panel extracted requirements;
- reported findings, grouped by severity and then by file. Each finding shows its origins, its verification verdict and its on-base label (also present on base, new in this change, or not checked against base);
- dropped and suppressed findings, with their reasons, in a collapsed section;
- the gate receipts.

`renderPanelMarkdownReport` in `@superfunctions/reviewfn-core` produces this rendering, and the GitHub summary uses the same text.
