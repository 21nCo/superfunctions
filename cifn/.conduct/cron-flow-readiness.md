# Actual FlowFn cron scheduling

Original 2026-02-05 PIPE-004 and INT-001 require schedule triggers and FlowFn integration. The prior CronScheduler ignored cronExpression and created intervals on every start; the built server never constructed it. A fake-clock baseline at 11:01 with hourly `0 * * * *` queued two runs in two seconds (`/tmp/cifn-cron-baseline.log`).

## Prerequisite and behavior

Merged the published FlowFn prerequisite 3f95e516ecfe72e93dc9c4bc52a0f26ef26772e4 ordinarily as 15f1c6655. Its current Scheduler already owns in-flight work, avoids stale timer rearming and advances after failure. Ci directly depends on and invokes that API; it does not duplicate a cron parser or copy the older scheduler. The merge resolved only lock metadata conflicts. Normal scoped npm 11 installation validated the dependency closure; subsequent lock edits add the dependency and normalize flags/order, without changing dependency versions.

Trusted bounded server configuration registers declared pipeline schedules. Flow evaluates five-field UTC patterns. Duplicate start shares ownership; registration changes require stop. Stop fences secret-resolution completion from admitting new runs, waits active admission, and preserves its stop fence if Flow cannot prove shutdown. The store remains open on uncertain scheduler shutdown. No provider or real repository access is required to queue a schedule.

Single-process scheduling is explicit. Restart chooses the next future occurrence, without backfill. This does not implement distributed ownership or durable occurrence receipts; a crash during admission can leave an uncertain occurrence, and a second simultaneous host can duplicate schedules. Existing durable dispatch handles runs already committed. No failed occurrence is automatically replayed. These remain production limitations, not waived requirements.

## Validation

Final evidence:

- Normal scoped npm 11 installation and `npm ci --dry-run` passed for Ci control/runner and Flow core; `/tmp/cifn-cron-install.log` and `/tmp/cifn-cron-lock-dryrun.log`. No dependency versions changed in the new lock diff, only the dependency edge and metadata normalization.
- All 241 control-plane tests across 18 files passed, including seven scheduler cases and actual SQLite state: `/tmp/cifn-cron-full-final.log`. Strict declarations passed: `/tmp/cifn-cron-types-final.log`.
- Actual Flow, Ci control and Runner builds passed: `/tmp/cifn-cron-flow-build.log`, `/tmp/cifn-cron-build-final.log`, `/tmp/cifn-cron-runner-build.log`.
- Standalone actual built-server fixture passed on Node 20: `/tmp/cifn-cron-server.log`. Fresh 12-tarball Node 22.22.0 consumer repeated the corrected fixture, ESM/CJS imports, strict declarations and audit zero: `/tmp/cifn-cron-packed-corrected.log`. It observed actual UTC due time, SQLite run creation, authenticated runner claim and graceful shutdown/reopen with no same-minute duplicate; no shell or provider was executed.
- Source tests prove no early enqueue, duplicate-start ownership, skipped missed occurrences, stop during held secret resolution, calendar ranges, invalid cron rejection, sanitized provider failures, no tight retry, and a timed-out stop retaining its restart fence. Flow's own zero-occurrence scheduling API validates every calendar pattern before any runtime timer starts.

The initial Node 22 source attempt failed because the existing better-sqlite3 binary targets Node 20; the unchanged Node 20 rerun passed. No ABI bypass/rebuild was used. An initial test assertion used nonexistent listRuns.total; it was corrected to the actual runs array. Initial full239 and installed12-package acceptance also passed before the final two failure/timeout cases and fixture timing correction.

`cifn/typescript/control-plane/scripts/verify-cron.mjs` is reproducible and uses an owned SQLite directory plus loopback server. It launches away from a minute boundary, allows bounded startup/request times, explicitly limits the same-minute restart observation, and bounds TERM/KILL cleanup. Failure to prove process exit retains the directory. It does not inject a production clock or claim distributed exact-once scheduling. The packed consumer invokes it automatically.

All final commands exited zero. Owned child processes, SQLite directories and the fresh consumer were removed. No external provider, deployment, settings or ignore changes occurred. The prerequisite is a separate ordinary merge; original production scope remains open as described above.
