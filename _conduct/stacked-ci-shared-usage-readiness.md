# Stacked pull-request CI and portable shared-usage guard

General CI now accepts pull requests targeting any branch, including readiness stacks. Push triggers remain limited to dev, next, and main. The existing affected-workspace planner still compares the pull request's actual base SHA and retains its existing package/dependent selection; no broader unconditional build replaces it. The Plan job runs the planning/guard regression tests before generating outputs.

The LangFn duplication gate no longer requires an externally installed ripgrep executable. Its shared-usage check scans Git-listed tracked and nonignored untracked files beneath langfn/typescript and langfn/python using Node. Symbolic links and binary files are excluded. Both directories must exist. It retains the original combined criterion: at least one text file contains `@superfunctions/` or `superfunctions.`; this is not a per-language semantic import verifier. Missing inputs, read errors, and absent matching usage fail with paths/error codes or scanned-file counts. The clone scan and 5% threshold are unchanged.

Validation on 2026-10-20:

- `node --test scripts/check-shared-usage.test.mjs scripts/ci-stacked-pr.test.mjs`: 8 passing cases. Includes TS/Python imports, ignored dependency/binary/symlink rejection, missing-directory CLI failure, an environment containing Git but no ripgrep, and a real disposable Git history whose stacked base contains unrelated changes. The child selects only its changed package. A tracked file deleted from the working tree is skipped before finding a valid remaining import; missing scan roots and other I/O errors still fail.
- `npm run check:duplication`: passes, 170 files, 392 duplicated lines, 2.1631166537909725%, threshold 5%.
- Ruby YAML parser verifies workflow syntax, unrestricted pull-request bases, and unchanged push branches. Node syntax check and `git diff --check` pass.
- Local command logs: `/tmp/shared-ci-guard-tests.log`, `/tmp/shared-ci-duplication.log`. Disposable test repositories are removed by test cleanup.

Hosted execution remains unverified: Actions billing/spending-limit no-starts require account action and a subsequent run. This change does not alter Vercel entitlements, external security findings, branch bases, or package dependency cycles. The previous guard failure suppressed the underlying subprocess error; unavailable ripgrep was a plausible cause, not a proven diagnosis. Removing that dependency and preserving actionable errors addresses the portability defect directly.
