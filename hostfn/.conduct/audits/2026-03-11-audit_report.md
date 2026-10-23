# HostFn Production Readiness Audit (Local + CI Deployments)

Date: 2026-03-11  
Auditor: Codex (GPT-5)  
Repo: `/Users/serro/Documents/dev/n/superfunctions`  
Branch: `next`  
Commit: `635bf2853807d9d76dba07a460dd0594f57d9147`

## Scope

This audit focuses on production readiness of `hostfn` deployment flows for:

1. Local operator deployments over SSH (`hostfn deploy production`)
2. CI/CD deployments from hosted runners (`hostfn deploy production --ci`)
3. CI/CD deployments from self-hosted runners (`hostfn deploy production --local --ci`)

Files audited include:

- `hostfn/cli/src/commands/deploy.ts`
- `hostfn/cli/src/core/{sync.ts,backup.ts,lock.ts,local.ts,ssh.ts,workspace.ts}`
- `hostfn/cli/src/runtimes/nodejs/pm2.ts`
- `hostfn/examples/github-actions-deploy.yml`
- `hostfn/cli/README.md`
- `hostfn/docs/content/docs/documentation/deployment/{ci-cd.mdx,local-mode.mdx,overview.mdx,monorepo.mdx}`

## Executive Summary

Readiness verdict: **NOT production-ready yet** for local and CI deploys.

- Overall readiness: **52/100**
- Blocking findings: **1 P0**
- High-priority findings: **6 P1**
- Medium findings: **3 P2**

Biggest risk: rollback reliability is compromised by deployment ordering and sync behavior, so a failed rollout may not recover a known-good release.

## What Is Working

- Config schema validation is present and strict (`hostfn/cli/src/config/schema.ts`).
- Deployment lock mechanism exists and is unit-tested (`hostfn/cli/src/core/lock.ts`, `hostfn/cli/src/__tests__/core/lock.test.ts`).
- Core unit suite passes: `60/60` tests (`cd hostfn/cli && npm test -- --run`).
- Workspace dependency bundling and lockfile generation have deterministic intent (`hostfn/cli/src/core/workspace.ts`).

## Findings (Ranked)

### P0-1: Rollback safety is broken by sync/backup sequence

**Evidence**

- Sync runs with `rsync --delete` into the live app directory (`hostfn/cli/src/core/sync.ts:24-27`, used by `deploy.ts:458-466`).
- Backups are stored inside the same deploy directory (`hostfn/cli/src/core/backup.ts:19`).
- Backups are created **after** sync/build (`hostfn/cli/src/commands/deploy.ts:473-551`), not before mutable operations.
- Default excludes do not include `backups` (`hostfn/cli/src/config/schema.ts:55-66`, `deploy.ts:451-453`).

**Impact**

- Existing backups can be deleted during sync.
- Backup snapshot may contain the just-built candidate (or mixed state), not the previous stable release.
- Auto-rollback cannot be trusted as a production safety net.

**Validation**

- Reproduced locally with rsync semantics: destination `backups/` removed when not excluded and `--delete` is enabled.

**Recommendation**

- Move to release-based deploy (`releases/<timestamp>` + atomic symlink switch).
- Keep backups outside sync target or explicitly exclude backup paths from sync.
- Take backup/snapshot before modifying live release state.

---

### P1-1: Rollback restore is incomplete (dist-only)

**Evidence**

- Backup stores `dist` and optional `package.json` (`backup.ts:42-45`).
- Restore only restores `dist` (`backup.ts:92-95`), leaving installed dependencies untouched.

**Impact**

- Dependency/version changes from failed release can remain after rollback.
- Restored app may still fail due to dependency mismatch.

**Recommendation**

- Roll back immutable full release artifact (code + lockfile + node_modules OR image tag).

---

### P1-2: "Zero-downtime" claim does not match implementation

**Evidence**

- Existing process path does `pm2 delete` then `pm2 start` (`deploy.ts:607-612`).
- This is a stop/start sequence, not graceful reload.

**Impact**

- User-visible downtime during redeploys.

**Recommendation**

- Use `pm2 reload <name> --update-env` with preloaded ecosystem updates.

---

### P1-3: Health check interval unit mismatch causes aggressive retries

**Evidence**

- Config/default interval is specified as `3` (documented as seconds) (`schema.ts:40`, `init.ts:151`).
- Deployment loop uses `setTimeout(interval)` directly (`deploy.ts:669`, `deploy.ts:688`), which is milliseconds.

**Impact**

- Retries run every ~3ms instead of 3s, causing premature health-check failure in real startup scenarios.

**Recommendation**

- Normalize to milliseconds (`intervalMs = intervalSeconds * 1000`) or rename config field to `intervalMs`.

---

### P1-4: Local mode sync is non-deterministic vs remote mode

**Evidence**

- Local mode uses `cpSync` with substring matching (`deploy.ts:428-440`), not glob semantics.
- Pattern `*.log` does not work with `includes` filter (validated in reproduction).
- Local mode does not delete stale files before copy (no `--delete` equivalent).

**Impact**

- Stale files can remain in local-mode deployments.
- Exclusion behavior differs from CI/remote mode, causing environment drift.

**Recommendation**

- Use same sync engine semantics in both modes (either rsync locally or a tested glob-based sync with delete behavior).

---

### P1-5: SSH host verification is explicitly disabled for file sync

**Evidence**

- Rsync SSH command uses `-o StrictHostKeyChecking=no`; CI also forces `UserKnownHostsFile=/dev/null` (`sync.ts:45`, `sync.ts:49`).

**Impact**

- MITM risk on deployment channel.

**Recommendation**

- Default to strict host verification with managed known_hosts.
- Allow explicit insecure opt-out only via flag/env for temporary use.

---

### P1-6: Critical deployment flow lacks integration tests

**Evidence**

- Current tests cover backup/health/lock/nginx/pm2/validation only.
- No tests for `deployCommand`, local mode, CI path, or end-to-end rollback behavior.

**Impact**

- Core regressions in release lifecycle can ship undetected.

**Recommendation**

- Add integration tests for:
  - local deploy path (`--local --ci`)
  - remote deploy with mock SSH/rsync
  - backup/rollback correctness across failed health checks
  - lock behavior under concurrent CI attempts

---

### P2-1: `--ci` flag is mostly cosmetic in deploy flow

**Evidence**

- `--ci` is logged but does not alter deploy behavior (`deploy.ts:288-291`).
- CI docs claim non-interactive and machine-readable CI behavior (`hostfn/docs/.../ci-cd.mdx:16-21`).

**Impact**

- Misleading operator expectations for CI behavior and output format.

**Recommendation**

- Implement explicit CI output mode and ensure all relevant commands support non-interactive operation.

---

### P2-2: `instances` config is accepted but ignored in PM2 generation

**Evidence**

- Schema supports environment/service `instances` (`schema.ts:11`, `schema.ts:86`).
- PM2 ecosystem hardcodes `instances: 'max'` (`pm2.ts:55`).

**Impact**

- Operators cannot enforce intended process counts.

**Recommendation**

- Pass resolved instances into runtime config and ecosystem generation.

---

### P2-3: Self-hosted CI examples are incomplete

**Evidence**

- Example self-hosted job runs `hostfn` without installing it (`hostfn/examples/github-actions-deploy.yml:31-40`, `hostfn/cli/README.md:533-542`).

**Impact**

- Users can copy a failing workflow directly from official examples.

**Recommendation**

- Add install/build step (or document preinstalled hostfn requirement) for self-hosted workflows.

## Deployment Path Readiness Matrix

| Path | Current Status | Reason |
|---|---|---|
| Local SSH deploy | **Blocked** | P0 rollback integrity issue + P1 health/zero-downtime/security gaps |
| CI hosted runner (`--ci`) | **Blocked** | Same deploy engine risks; CI-specific hardening incomplete |
| CI self-hosted (`--local --ci`) | **Blocked** | Local sync drift + same rollback and health issues |

## Recommended Fix Order

1. **Fix release safety model first (P0)**: separate releases, pre-change snapshot, backup isolation.
2. **Fix rollback completeness and PM2 strategy (P1-1, P1-2)**.
3. **Fix health interval units (P1-3)**.
4. **Align local sync semantics with remote (P1-4)**.
5. **Re-enable SSH trust verification by default (P1-5)**.
6. **Add deploy integration tests before next release (P1-6)**.
7. **Resolve CI/docs consistency items (P2 series)**.

## Production Gate

Do not mark HostFn production-ready for local or CI deployment until:

1. P0 is resolved and verified with integration tests.
2. All P1 findings are resolved or formally risk-accepted by platform owners.
3. At least one end-to-end failure-recovery test proves rollback returns to last known-good release.

## Commands Executed During Audit

- `cd hostfn/cli && npm test -- --run` (pass: 60/60)
- `cd hostfn/cli && npm run build` (pass)
- `cd hostfn/docs && npm run build` (failed in current workspace: `fumadocs-mdx: command not found`)
- Static source inspection via `rg`, `nl`, and `sed`
- Rsync behavior reproduction test confirming backup directory deletion risk under `--delete`
- Local `cpSync` filter reproduction test confirming glob mismatch (`*.log`)
