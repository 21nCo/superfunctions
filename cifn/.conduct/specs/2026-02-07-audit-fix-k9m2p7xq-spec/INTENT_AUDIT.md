# Intent Audit (authoritative intent → spec coverage)

This document is the completeness checklist: every intent item extracted from authoritative sources is mapped to where it is specified and how it is verified.

## Authoritative intent sources read

- `/Users/ar/dev/superfunctions/cifn/SPEC.md`
- `/Users/ar/dev/agent/intent/super functions/superfunctions-ar-notes.md`

## Intent Inventory (numbered; exhaustive)

1. CiFn is **self-hosted CI/CD** for the superfunctions ecosystem; runs pipelines on user-controlled infra.
2. Pipelines are **pipeline-as-config** in repo as YAML/JSON, familiar to GHA/CircleCI users.
3. Pipeline config lives at a **config path** (defaults include `.ci/pipeline.yml` or `cifn.yml`, path is configurable).
4. Trigger types: `push`, `pull_request`, `schedule` (cron), `workflow_dispatch` (manual/API).
5. Trigger wiring: push/PR via plugfn/webhooks; schedule via flowfn scheduler/cron; manual via API.
6. A control plane exists: API + scheduler; stores run history; dispatches work.
7. Orchestration uses flowfn for queueing/scheduling and (optionally) retries.
8. Run model: runs comprise jobs and steps; jobs have statuses; steps have statuses.
9. Job dependencies via `needs` form a DAG and are respected at runtime.
10. Determinism: given same pipeline + trigger inputs, job and step ordering are deterministic.
11. Runner model: runners execute jobs as processes or containers.
12. Default runner supports per-job Docker execution via an optional `image`.
13. `runs-on` dispatch selects runners by labels/types (default, hostfn-runner, arbitrary labels).
14. hostfn-runner executes on a hostfn-managed node; deploy can run locally (`hostfn deploy <env> --local --ci`).
15. Self-hosted runners can be registered with the control plane and pull jobs.
16. Supported step types include: `run`, `checkout`, `cache/restore`, `cache/save`, `artifact/upload`, `artifact/download`, `testfn/run`, `hostfn/deploy`.
17. Checkout semantics: clones the repo at trigger ref; workspace becomes clone root.
18. Cache semantics: cache restore/save with keys that can use `hashFiles(...)`.
19. Artifact semantics: artifacts uploaded/downloaded via filefn; can pass build outputs across jobs.
20. Test semantics: `testfn/run` uses testfn (ecosystem-native test runner).
21. Deploy semantics: `hostfn/deploy` uses hostfn with secrets from secfn.
22. Ecosystem-native integrations include: hostfn, testfn, flowfn, logfn/watchfn, secfn, filefn, plugfn, sendfn (optional).
23. Secrets: job secrets come from secfn; MUST NOT be logged; SHOULD NOT be persisted in plaintext.
24. Observability: logs in logfn; optional metrics in watchfn; dashboard can surface runs/logs/artifacts.
25. Self-deployability: CiFn control plane + runners deployable via hostfn; Docker Compose/K8s acceptable; no required SaaS dependency.
26. Hybrid usage patterns are supported as optional adoption paths (e.g. use GitHub Actions only as trigger; CiFn runs heavy jobs).
27. Limits/caps exist with concrete values (pipeline 500KB; jobs/steps/depth; API paging; expression length; artifact/cache key lengths).
28. Performance targets exist as best-effort guidance (parse/validate; dispatch; listing).
29. Scaling notes: v1 fixed runner pool; no autoscaling.
30. Dashboard exists: run list, run detail, logs, artifacts list; auth same as API.
31. CLI exists: `cifn run`, `cifn status`, `cifn logs`; must not leak secrets.
32. Explicit non-goals (v1): full GHA marketplace parity; Kubernetes-native execution; SaaS offering.
33. “Must not” rule: secrets must not appear in logs/dashboards/CLI; CI should be safe by default.

## Intent → Spec coverage (per item)

For each item: **SPEC.md coverage** → **Requirements** → **Test vectors**.

1. **Self-hosted CI/CD**
   - **SPEC.md**: Overview; Goals
   - **Requirements**: DEPLOY-001, API-002, INT-001
   - **Tests**: TV-DEPLOY-001, TV-API-001, TV-INT-001

2. **Pipeline-as-config YAML/JSON**
   - **SPEC.md**: Goals; Semantics
   - **Requirements**: PIPE-001, PIPE-002
   - **Tests**: TV-PIPE-001, TV-PIPE-002, TV-PIPE-004, TV-PIPE-005

3. **Config path defaults + configurable**
   - **SPEC.md**: Semantics → Pipeline resolution; CLI
   - **Requirements**: PIPE-006, CLI-001
   - **Tests**: TV-API-001 (default path resolution), TV-CLI-001, TV-CLI-002

4. **Triggers: push/PR/schedule/workflow_dispatch**
   - **SPEC.md**: Goals; Public API; Webhook API
   - **Requirements**: PIPE-004, SEC-002
   - **Tests**: TV-PIPE-008, TV-PIPE-009, TV-SEC-005

5. **Trigger wiring: plugfn/flowfn/API**
   - **SPEC.md**: Public API; Webhook API; Semantics
   - **Requirements**: INT-001, INT-005, RUN-010
   - **Tests**: TV-INT-005, TV-INT-001

6. **Control plane: API + scheduler + run history**
   - **SPEC.md**: Public API; Semantics; Observability
   - **Requirements**: API-002..API-007, OBS-001
   - **Tests**: TV-API-001..016, TV-OBS-001

7. **flowfn orchestration**
   - **SPEC.md**: Overview; Semantics
   - **Requirements**: INT-001
   - **Tests**: TV-INT-001

8. **Run model: runs/jobs/steps**
   - **SPEC.md**: Semantics; Invariants
   - **Requirements**: RUN-001, RUN-002, API-004
   - **Tests**: TV-API-011, TV-RUN-002

9. **DAG semantics via needs**
   - **SPEC.md**: Semantics → Job DAG execution
   - **Requirements**: PIPE-007, RUN-003
   - **Tests**: TV-RUN-001, TV-RUN-003, TV-PIPE-013

10. **Determinism**
   - **SPEC.md**: Invariants (Determinism); Compatibility
   - **Requirements**: PIPE-007, RUN-004, PIPE-010
   - **Tests**: TV-RUN-004, TV-EXPR-007

11. **Runner model: process/container**
   - **SPEC.md**: Goals; Semantics → Step semantics
   - **Requirements**: RUNNER-001, RUNNER-002
   - **Tests**: TV-RUNNER-008, TV-RUNNER-007

12. **Default runner + Docker image**
   - **SPEC.md**: Semantics → Step semantics
   - **Requirements**: RUNNER-002
   - **Tests**: TV-RUNNER-008

13. **runs-on dispatch**
   - **SPEC.md**: Semantics → Job DAG execution
   - **Requirements**: PIPE-008
   - **Tests**: TV-RUNNER-001

14. **hostfn-runner local deploy**
   - **SPEC.md**: Step semantics → hostfn/deploy
   - **Requirements**: RUNNER-004, INT-007
   - **Tests**: TV-RUNNER-002, TV-INT-007

15. **Self-hosted runner register + pull model**
   - **SPEC.md**: Public API → runners/register + heartbeat
   - **Requirements**: API-010, API-011, RUNNER-003, SEC-004
   - **Tests**: TV-RUNNER-003..006, TV-SEC-006

16. **Step types list**
   - **SPEC.md**: Semantics → Step semantics
   - **Requirements**: PIPE-003, PIPE-011
   - **Tests**: TV-PIPE-006, TV-PIPE-014..016

17. **Checkout clones at ref; workspace root**
   - **SPEC.md**: Semantics → Step semantics → checkout
   - **Requirements**: RUN-007
   - **Tests**: TV-RUN-007

18. **Cache restore/save + hashFiles**
   - **SPEC.md**: Semantics → `${{ ... }}` interpolation; Limits/caps
   - **Requirements**: RUN-006, PIPE-010
   - **Tests**: TV-EXPR-007, TV-RUN-006

19. **Artifacts via filefn**
   - **SPEC.md**: Public API → artifacts; Semantics → artifacts
   - **Requirements**: RUN-005, INT-002, API-007
   - **Tests**: TV-RUN-005, TV-API-016, TV-INT-002

20. **Tests via testfn**
   - **SPEC.md**: Semantics → testfn/run
   - **Requirements**: INT-006, RUN-008
   - **Tests**: TV-INT-006

21. **Deploy via hostfn + secrets**
   - **SPEC.md**: Semantics → hostfn/deploy; Security
   - **Requirements**: INT-007, SEC-001
   - **Tests**: TV-INT-007, TV-SEC-001

22. **Ecosystem-native integrations**
   - **SPEC.md**: Overview; Observability; Security
   - **Requirements**: INT-001..INT-008, DEPLOY-001
   - **Tests**: TV-INT-001..008, TV-DEPLOY-001

23. **Secrets from secfn; not logged/persisted**
   - **SPEC.md**: Security; Invariants
   - **Requirements**: SEC-001, SEC-006, INT-003
   - **Tests**: TV-SEC-001, TV-SEC-004, TV-INT-003

24. **Observability via logfn/watchfn**
   - **SPEC.md**: Observability
   - **Requirements**: INT-004, OBS-001, OBS-002
   - **Tests**: TV-OBS-001, TV-OBS-002, TV-OBS-002N

25. **Self-deployability**
   - **SPEC.md**: Overview/Goals; Security (secrets); Compatibility
   - **Requirements**: DEPLOY-001, DEPLOY-002
   - **Tests**: TV-DEPLOY-001, TV-DEPLOY-002, TV-DEPLOY-003/003N

26. **Hybrid usage patterns (optional)**
   - **SPEC.md**: Goals → Hybrid usage patterns (optional)
   - **Requirements**: INT-008
   - **Tests**: TV-INT-008, TV-INT-008N

27. **Concrete limits/caps**
   - **SPEC.md**: Limits / caps
   - **Requirements**: PIPE-012, LIMIT-001
   - **Tests**: TV-LIMIT-001, TV-LIMIT-002, TV-LIMIT-003

28. **Performance targets**
   - **SPEC.md**: Context; Limits/caps
   - **Requirements**: LIMIT-002
   - **Tests**: TV-LIMIT-004, TV-LIMIT-004N

29. **Fixed runner pool (no autoscaling)**
   - **SPEC.md**: Context; Undefined section
   - **Requirements**: LIMIT-003
   - **Tests**: TV-LIMIT-005, TV-LIMIT-005N

30. **Dashboard**
   - **SPEC.md**: Public API; Dashboard
   - **Requirements**: DASH-001
   - **Tests**: TV-DASH-001

31. **CLI**
   - **SPEC.md**: CLI
   - **Requirements**: CLI-001..CLI-005
   - **Tests**: TV-CLI-001..006

32. **Non-goals**
   - **SPEC.md**: Non-goals; Undefined / Explicitly user-deferred only
   - **Requirements**: N/A (documented as non-goals)
   - **Tests**: N/A

33. **Must-not: secrets in logs/dash/cli**
   - **SPEC.md**: Security; Invariants
   - **Requirements**: SEC-001, RUNNER-005, CLI-004, OBS-003
   - **Tests**: TV-SEC-001, TV-CLI-005, TV-OBS-003

## Final completeness statement

**No missing intent items.** Every item extracted from authoritative intent sources is covered by this spec bundle (SPEC/REQUIREMENTS/TEST_VECTORS/PLAN/phases) with explicit verification vectors where applicable.

