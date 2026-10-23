# CiFn Specification

> Self-hosted CI/CD for the superfunctions ecosystem — like CircleCI or GitHub Actions, but you own it.

**Version**: 0.1.0  
**Status**: Specification  
**Other names**: buildFn (in notes)

---

## 1. Overview

CiFn is a **CI/CD pipeline runner** in the superfunctions family: it runs pipelines (build → test → deploy) on your own infrastructure, using the same patterns as hostfn, flowfn, testfn, and friends. It is designed for **self-deployability**: you can run CiFn itself on the same stack you deploy with hostfn, and use it either as the **single source of CI** or as a **complement** to GitHub Actions / CircleCI (e.g. trigger from webhooks, run heavy jobs on your runners).

### 1.1 Goals

- **Pipeline-as-config**: YAML/JSON pipeline definition (jobs, steps, env, artifacts), familiar to GHA/CircleCI users.
- **Runner model**: Execute steps in containers or on hostfn-managed nodes; support self-hosted and optional cloud runners.
- **Ecosystem-native**: Use **hostfn** for deploy steps, **testfn** for test steps, **flowfn** for orchestration/retries, **logfn**/watchfn for observability, **secfn** for secrets, **filefn** for artifacts.
- **Self-deployable**: CiFn control plane + runners can be deployed via hostfn; no dependency on a commercial CI vendor for core flows.
- **Interop**: Can be triggered by GitHub/GitLab webhooks (via plugfn) or run standalone (cron, manual, flowfn-scheduled).

### 1.2 Non-Goals (v1)

- Full feature parity with GitHub Actions marketplace (reuse plugfn for integrations).
- Native Kubernetes job execution (later phase; v1 focuses on process/container on VMs).
- Built-in SaaS offering (self-hosted first).

---

## 2. Approach: How to Build CiFn

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         CiFn Control Plane                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │ Pipeline    │  │ Job Queue   │  │ Artifact    │  │ Triggers        │ │
│  │ Parser &    │  │ (flowfn     │  │ Store       │  │ (webhook,       │ │
│  │ Validator   │  │ queue)      │  │ (filefn)    │  │ cron, API)      │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘ │
│         │                │                │                   │         │
│         └────────────────┼────────────────┘                   │         │
│                          ▼                                      │         │
│  ┌─────────────────────────────────────────────────────────────▼───────┐ │
│  │                    Orchestrator (flowfn workflows)                  │ │
│  │  - Dispatch jobs to runners  - Collect artifacts  - Notify (sendfn)  │ │
│  └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
            ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
            │ Runner 1     │   │ Runner 2     │   │ Runner N     │
            │ (container   │   │ (hostfn      │   │ (self-hosted │
            │  or process) │   │  node)       │   │  or cloud)   │
            └──────────────┘   └──────────────┘   └──────────────┘
```

- **Control plane**: API + scheduler; stores pipeline configs, run history, and dispatches work.
- **Job queue**: Use **flowfn** queues for job distribution and retries (consistent with rest of superfunctions).
- **Runners**: Processes or containers that pull jobs, run steps (shell, testfn, hostfn deploy), and report back.
- **Artifacts**: Use **filefn** for build outputs and caches (versioned, signed URLs).
- **Secrets**: **secfn** vault for env vars and keys injected into jobs.
- **Logs / metrics**: **logfn** and **watchfn** for pipeline logs and dashboards.

### 2.2 Pipeline Config Shape (Familiar UX)

Keep the model close to GitHub Actions / CircleCI so migration and mental model are easy:

```yaml
# .ci/pipeline.yml or cifn.yml (configurable path)
name: build-and-deploy

on:
  push:
    branches: [main, production]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 2 * * *'   # optional nightly
  workflow_dispatch: {}   # manual trigger

env:
  NODE_VERSION: '20'

jobs:
  build:
    runs-on: default      # or: hostfn-node, docker-ubuntu-22
    image: node:20        # optional; when set, default runner executes run steps in Docker
    steps:
      - uses: checkout
      - uses: cache/restore
        with:
          key: deps-${{ hashFiles('package-lock.json') }}
      - run: npm ci
      - run: npm run build
      - uses: cache/save
        with:
          key: deps-${{ hashFiles('package-lock.json') }}
          paths: node_modules
      - uses: artifact/upload
        with:
          name: dist
          path: dist/

  test:
    needs: build
    runs-on: default
    steps:
      - uses: checkout
      - uses: cache/restore
        with:
          key: deps-${{ hashFiles('package-lock.json') }}
      - run: npm ci
      - uses: testfn/run
        with:
          config: vitest.config.ts
          reporter: json
      - uses: artifact/upload
        if: failure()
        with:
          name: test-results
          path: test-results/

  deploy:
    needs: [build, test]
    if: github.ref == 'refs/heads/main'
    runs-on: hostfn-runner
    env:
      HOSTFN_SSH_KEY: ${{ secrets.HOSTFN_SSH_KEY }}
    steps:
      - uses: artifact/download
        with:
          name: dist
      - uses: hostfn/deploy
        with:
          environment: production
          ci: true
```

- **Triggers**: `on` → implemented via **plugfn** webhooks (GitHub/GitLab) + cron from **flowfn** scheduler + API for `workflow_dispatch`.
- **Jobs / needs**: DAG of jobs; orchestrator uses **flowfn** workflow or a simple DAG executor to run jobs in order and pass artifacts (via **filefn**).
- **Steps**: 
  - `run`: shell in runner.
  - `uses: checkout`: clone repo at trigger ref (plugfn or git CLI).
  - `uses: cache/restore`, `cache/save`: **cachefn** or filefn-backed cache.
  - `uses: artifact/upload`, `artifact/download`: **filefn**.
  - `uses: testfn/run`: invoke **testfn** SDK in runner (same process or subprocess).
  - `uses: hostfn/deploy`: call **hostfn** CLI with `--ci` and env (e.g. `HOSTFN_SSH_KEY` from **secfn**).

### 2.3 Runner Model

- **Default runner**: Single process or Docker container per job; configurable image (e.g. `node:20`, `ubuntu:22.04`).
- **runs-on dispatch**: Job `runs-on` is matched to runner labels (for example `default`, `hostfn-runner`, `docker-ubuntu-22`).
- **hostfn-runner**: Runner that executes on a hostfn-managed node (e.g. same box as app); useful for deploy step so SSH is local (`hostfn deploy production --local --ci`).
- **Self-hosted**: User registers runner with control plane (token from secfn); control plane dispatches jobs to that runner (pull model).
- **Scaling**: v1 = fixed set of runners; later = scale via flowfn + provider APIs (e.g. spin up VM per job).

### 2.4 Implementation Phases (Suggested)

| Phase | Scope |
|-------|--------|
| **0** | Schema for `cifn.yml` / pipeline config; validation; doc. |
| **1** | Control plane: API (create run, get status, list runs); job queue (flowfn); single process runner (run shell steps, report logs to logfn). |
| **2** | Triggers: webhook from plugfn (GitHub), cron from flowfn; checkout step. |
| **3** | Artifacts: filefn upload/download steps; cache steps (cachefn or filefn). |
| **4** | testfn step; hostfn deploy step (with secfn for secrets). |
| **5** | Docker runner; optional hostfn-runner type. |
| **6** | Dashboard (uifn/docsfn style) for run history and logs. |

---

## 3. How CiFn Helps the Superfunctions Ecosystem

### 3.1 Unifies Build → Test → Deploy

- **hostfn** already has `deploy ... --ci` and expects to be called from CI. Today that’s GHA/CircleCI. CiFn makes it **native**: a `hostfn/deploy` step in the same ecosystem, with secrets from **secfn** and logs in **logfn**/watchfn.
- **testfn** runs in CI as a step; results can be stored in testfn’s storage and optionally surfaced in a shared dashboard.
- **flowfn** gets a concrete use case: pipeline DAGs and retries; scheduled pipelines (cron) use flowfn’s scheduler.

### 3.2 Single Stack for “Where does CI run?”

- Teams that want “everything on my infra” can run CiFn on the same VMs/containers they deploy with hostfn. No need to depend on GitHub’s or CircleCI’s runners for the critical path.
- **Self-deployability**: Install CiFn (control plane + runner) via hostfn; config in repo; triggers from plugfn webhooks. No vendor lock-in for execution.

### 3.3 Reuse of Existing Superfunctions

| Need | Superfunction | Use in CiFn |
|------|----------------|-------------|
| Deploy | hostfn | `hostfn deploy <env> --ci` step; optional hostfn-runner. |
| Workflow / queue | flowfn | Job queue, DAG execution, cron triggers. |
| Test execution | testfn | `testfn/run` step in pipeline. |
| Logs / observability | logfn, watchfn | Pipeline logs, step duration, failure alerts. |
| Secrets | secfn | Inject `HOSTFN_SSH_KEY`, API keys, etc. into job env. |
| Artifacts & cache | filefn, cachefn | Upload/download artifacts; cache restore/save. |
| Notifications | sendfn | Notify on failure/success (optional). |
| Repo access / webhooks | plugfn | GitHub/GitLab OAuth + webhook for push/PR events. |

### 3.4 Better DX for Superfunctions Users

- One config file (`cifn.yml`) in repo; one CLI: `cifn run` (local or trigger remote), `cifn status`, `cifn logs`.
- Same auth and secrets story as the rest of the stack (secfn); same logging and monitoring (logfn, watchfn).

---

## 4. Self-Deployability

### 4.1 What “Self-Deploy” Means Here

- **CiFn control plane** and **runners** run on infrastructure you control (same as hostfn: your VM, your Docker, or your cloud account).
- **No required SaaS**: You don’t need CircleCI or GitHub Actions to run pipelines; you can use CiFn as the only CI or as an internal runner for GHA (self-hosted runner pattern).
- **Config in repo**: Pipeline lives in `.ci/pipeline.yml` (or similar); no pipeline config stored only in a vendor dashboard.

### 4.2 Deploying CiFn Itself

- **Option A**: Deploy CiFn with **hostfn** (e.g. `cifn-server` + `cifn-runner` as services in `hostfn.config`). Control plane talks to flowfn, filefn, secfn, logfn on the same network.
- **Option B**: Docker Compose or Kubernetes for CiFn control plane + runners; still use hostfn for deploying the *applications* that CiFn builds and tests.
- **Secrets**: CiFn’s own secrets (runner registration, webhook signing) in **secfn**; job secrets (e.g. `HOSTFN_SSH_KEY`) also from secfn.

### 4.3 Hybrid Use (Optional)

- **Trigger from GitHub**: Use GitHub Actions only to send a webhook to CiFn (e.g. on push to `main`); CiFn runs the full pipeline and deploy. Reduces GHA usage to “trigger” only.
- **Or the reverse**: CiFn runs tests and builds artifacts; a final step calls a GHA workflow (via API) or just uploads artifacts to a registry; deploy can still be hostfn from CiFn.

---

## 5. Suggested File Layout (CiFn Repo)

```
cifn/
├── SPEC.md                 # This document
├── typescript/
│   ├── control-plane/      # API, pipeline parse, job dispatch
│   │   ├── src/
│   │   │   ├── api/
│   │   │   ├── pipeline/
│   │   │   ├── queue/       # flowfn client
│   │   │   ├── triggers/   # webhook, cron
│   │   │   └── runners/    # runner registration
│   │   └── package.json
│   ├── runner/             # Job runner (pull from queue, run steps)
│   │   ├── src/
│   │   │   ├── executor/
│   │   │   ├── steps/      # checkout, run, testfn, hostfn, artifact
│   │   │   └── reporting/  # logfn
│   │   └── package.json
│   └── sdk/                # TypeScript SDK for defining pipelines / triggering
│       └── src/
├── python/                 # Python SDK (later)
├── schemas/
│   └── pipeline.schema.json
└── examples/
    ├── cifn.yml
    └── monorepo/
```

---

## 7. Limits and Performance Expectations

### 7.1 Pipeline Limits

CiFn enforces the following limits to ensure reasonable resource usage and validation times:

| Resource | Limit | Enforcement |
|----------|-------|-------------|
| Pipeline document size | 500 KB | Parse-time rejection |
| Jobs per pipeline | 100 | Validation-time rejection |
| Steps per job | 100 | Validation-time rejection |
| Needs depth (DAG) | 10 levels | Validation-time rejection |
| GET /runs limit per request | 100 | API returns 400 if exceeded |
| Expression length | 2 KB | Expression evaluation error |
| Artifact name length | 256 characters | Upload step failure |
| Cache key length | 1 KB | Cache step failure |

**Why these limits?**
- **500 KB pipeline**: Ensures parse + validate completes in < 500ms (see performance targets below).
- **100 jobs/steps**: Prevents accidentally creating runaway pipelines; forces users to be intentional about complex DAGs.
- **10 needs depth**: Prevents overly deep dependency chains that make reasoning about execution order difficult.
- **256 char artifact names**: Aligns with common filesystem limits; prevents excessively long identifiers.
- **1 KB cache keys**: Allows reasonable key composition (e.g. `deps-{{ hashFiles(...) }}-v1`) without abuse.

### 7.2 Performance Targets

CiFn aims for the following performance characteristics (v1, best effort):

| Metric | Target | Notes |
|--------|--------|-------|
| Pipeline parse + validate | < 500ms | For pipelines up to 500 KB |
| Job dispatch to runner | < 5s p99 | When runner is available |
| GET /runs with paging | < 2s | For 1000 runs in store |

**v1 Scaling Notes:**
- **Fixed runner pool**: v1 does not auto-scale runners; queue depth is bounded by flowfn capacity.
- **Artifact/cache limits**: Bounded by filefn storage limits (not enforced by CiFn itself).
- **Concurrent runs**: Limited by runner availability; no hard cap on queued runs.

### 7.3 Optional Notifications (SendFn)

CiFn supports optional notifications on run completion (success or failure) via **sendfn** integration:

**Configuration:**
- Per-pipeline or global configuration flag: `notifyOnRunComplete: true`
- Webhook URL or email address for notifications
- When not configured: no notification sent (opt-in feature)

**Notification payload:**
- `runId`, `status` (success/failure), `pipelineRef`, `trigger`, `createdAt`, `completedAt`, `summary`
- Sent as HTTP POST to configured webhook or via email service

**Use cases:**
- Alert team when nightly build fails
- Send Slack/email notification on deploy completion
- Integrate with external monitoring/alerting systems

---

## 8. Summary

| Topic | Recommendation |
|-------|----------------|
| **Approach** | Pipeline-as-YAML; control plane + runners; job queue via flowfn; artifacts via filefn; steps for run, checkout, cache, testfn, hostfn deploy. |
| **Ecosystem** | CiFn is the “CI/CD superfunction”: ties hostfn (deploy), testfn (test), flowfn (queue/schedule), logfn/watchfn (observability), secfn (secrets), filefn (artifacts), plugfn (webhooks). |
| **Self-deployability** | CiFn runs on your infra (hostfn or Docker/K8s); no required SaaS; config in repo; optional hybrid with GHA/CircleCI as trigger or consumer. |

This gives you a clear path to implement **cifn** in the superfunctions ecosystem while keeping everything self-hostable and composable with existing *fns.
