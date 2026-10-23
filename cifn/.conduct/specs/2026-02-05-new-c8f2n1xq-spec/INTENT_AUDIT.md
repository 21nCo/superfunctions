# Intent Audit: Intent Inventory → Spec Coverage

## Intent Inventory (from cifn/SPEC.md and superfunctions-ar-notes.md)

1. **Pipeline-as-config**: YAML/JSON pipeline definition with name, on, env, jobs (steps, runs-on, needs), GHA/CircleCI-familiar.
2. **Runner model**: Execute steps in containers or on hostfn-managed nodes; support self-hosted and optional cloud runners.
3. **Ecosystem**: Use hostfn for deploy, testfn for test, flowfn for orchestration/retries, logfn/watchfn for observability, secfn for secrets, filefn for artifacts.
4. **Self-deployable**: Control plane + runners deployable via hostfn; no dependency on commercial CI vendor.
5. **Interop**: Triggered by GitHub/GitLab webhooks (plugfn) or standalone (cron, manual, flowfn-scheduled).
6. **Control plane**: API + scheduler; stores pipeline configs and run history; dispatches work.
7. **Job queue**: flowfn for job distribution and retries.
8. **Runners**: Pull jobs, run steps (shell, testfn, hostfn), report back.
9. **Artifacts**: filefn for build outputs and caches (versioned, signed URLs).
10. **Secrets**: secfn vault for env and keys injected into jobs.
11. **Logs/metrics**: logfn and watchfn for pipeline logs and dashboards.
12. **Step types**: run, checkout, cache/restore, cache/save, artifact/upload, artifact/download, testfn/run, hostfn/deploy.
13. **Triggers**: on.push, on.pull_request, on.schedule, on.workflow_dispatch.
14. **Jobs/needs**: DAG; orchestrator runs jobs in order; artifacts via filefn.
15. **Default runner**: Single process or Docker per job; configurable image.
16. **hostfn-runner**: Executes on hostfn-managed node; deploy step can use hostfn deploy --local --ci.
17. **Self-hosted runner**: User registers with control plane (token from secfn); pull model.
18. **v1 scaling**: Fixed set of runners.
19. **Config path**: .ci/pipeline.yml or cifn.yml; configurable.
20. **Pipeline schema**: Defined and validated (JSON Schema).
21. **API**: Create run, get status, list runs, cancel, logs, artifacts.
22. **Single process runner**: Shell steps, report logs to logfn.
23. **Checkout step**: Clone repo at trigger ref (plugfn or git).
24. **Cache steps**: cachefn or filefn (restore/save).
25. **testfn step**: Invoke testfn SDK in runner.
26. **hostfn deploy step**: Call hostfn CLI with --ci and env from secfn.
27. **Deploy CiFn via hostfn**: cifn-server + cifn-runner as services in hostfn.config.
28. **Deploy CiFn via Docker/K8s**: Alternative to hostfn.
29. **CiFn secrets**: Runner registration, webhook signing in secfn; job secrets from secfn.
30. **Config in repo**: No pipeline stored only in vendor dashboard.
31. **CLI**: cifn run, cifn status, cifn logs.
32. **Same auth/secrets**: secfn; same logging logfn/watchfn.
33. **Optional sendfn**: Notify on failure/success.
34. **Dashboard**: uifn/docsfn style for run history and logs.
35. **Expression syntax**: ${{ }} for secrets., github., hashFiles; if, env, with.
36. **Job-level and step-level env and with**.
37. **Step condition if**: failure(), branch checks.
38. **runs-on**: default, hostfn-node, docker-ubuntu-22, hostfn-runner.
39. **Artifact upload/download by name; paths**.
40. **Cache key with expressions; paths for save**.
41. **ciFn as CI/CD (buildFn)**; similar to CircleCI, Buildkite (from notes).
42. **watchFn monitors flowFn**; CiFn pipelines as workflow (from notes).
43. **Non-goals**: Full GHA marketplace parity; native K8s job execution; built-in SaaS (explicitly deferred).

---

## Coverage matrix

| # | Intent item | SPEC.md section | Requirement IDs | Test vectors |
|---|-------------|-----------------|-----------------|--------------|
| 1 | Pipeline-as-config (YAML/JSON, name, on, env, jobs) | Overview, Public API, Data formats | PIPE-001, PIPE-006 | TV-PIPE-001, TV-PIPE-002, TV-PIPE-010 |
| 2 | Runner model (containers, hostfn nodes, self-hosted) | Glossary, Goals, Public API, Semantics | RUNNER-001, RUNNER-004, PIPE-008 | TV-RUNNER-001, TV-RUNNER-005 |
| 3 | Ecosystem (hostfn, testfn, flowfn, logfn, watchfn, secfn, filefn) | Overview, Goals, Semantics, Integrations | INT-001–INT-006, RUN-005–RUN-008 | TV-INT-* |
| 4 | Self-deployable (hostfn or Docker/K8s) | Overview, Self-Deployability (in root SPEC), Undefined | DASH-001; doc in root SPEC | N/A (operational) |
| 5 | Interop (webhooks, cron, manual) | Goals, Public API, Semantics | PIPE-004, INT-005 | TV-PIPE-007, TV-SEC-004 |
| 6 | Control plane (API, scheduler, store, dispatch) | Overview, Architecture (root SPEC), Semantics | API-*, RUN-*, INT-001 | TV-API-*, PLAN |
| 7 | Job queue flowfn | Semantics, Invariants | INT-001, API-002 | TV-INT-001 |
| 8 | Runners pull jobs, run steps, report | Semantics, Runner model | RUNNER-001, RUNNER-003, RUNNER-005 | TV-RUNNER-001, TV-RUNNER-004 |
| 9 | Artifacts filefn | Semantics, Limits | INT-002, RUN-005, API-007 | TV-INT-002, TV-API-014 |
| 10 | Secrets secfn | Security, Semantics | SEC-001, INT-003, RUN-008 | TV-SEC-003, TV-INT-004 |
| 11 | Logs/metrics logfn and watchfn | Observability, Semantics | INT-004, OBS-001, OBS-003 | TV-OBS-001, TV-OBS-003 |
| 12 | Step types (run, checkout, cache, artifact, testfn, hostfn) | Glossary, Public API, Semantics | PIPE-003, RUN-005–RUN-008 | TV-PIPE-005, TV-PIPE-006, TV-INT-* |
| 13 | Triggers push, pull_request, schedule, workflow_dispatch | Public API, Semantics | PIPE-004 | TV-PIPE-007 |
| 14 | Jobs/needs DAG; artifacts via filefn | Semantics, Invariants | PIPE-007, RUN-002, RUN-005 | TV-RUN-002, TV-RUN-003, TV-INT-002 |
| 15 | Default runner (process or Docker, image) | Runner model (root SPEC), Glossary | RUNNER-001, PIPE-008 | TV-RUNNER-001 |
| 16 | hostfn-runner and --local --ci | Runner model (root SPEC) | RUNNER-006, RUN-008 | TV-RUNNER-006, TV-INT-006 |
| 17 | Self-hosted runner (register with token, pull) | Public API, Semantics | RUNNER-002, RUNNER-004, API-010 | TV-RUNNER-002, TV-RUNNER-003, TV-RUNNER-005 |
| 18 | v1 fixed set of runners | Limits, Non-goals (root SPEC) | LIMIT-003 | N/A (doc) |
| 19 | Config path configurable; default .ci/pipeline.yml or cifn.yml | Public API, Invariants | PIPE-006, CLI-004 | TV-PIPE-010 |
| 20 | Pipeline schema and validation | Goals, Security, Public API | PIPE-002, SEC-003 | TV-PIPE-003, TV-PIPE-004 |
| 21 | API create run, get status, list runs, cancel, logs, artifacts | Public API | API-001–API-007 | TV-API-001–TV-API-014 |
| 22 | Single process runner, shell steps, logfn | Semantics, Integrations | RUNNER-005, INT-004 | TV-OBS-001 |
| 23 | Checkout step (clone at ref) | Semantics, Integrations | RUN-007, INT-005 | TV-INT-005 |
| 24 | Cache steps (cachefn or filefn) | Semantics | RUN-006 | TV-INT-003 |
| 25 | testfn step | Semantics | RUN-008, INT-004 (testfn) | TV-INT-004 |
| 26 | hostfn deploy step (CLI --ci, env from secfn) | Semantics | RUN-008, INT-006 | TV-INT-006 |
| 27 | Deploy CiFn via hostfn | Undefined / root SPEC | N/A (operational) | N/A |
| 28 | Deploy CiFn via Docker/K8s | Undefined / root SPEC | N/A (operational) | N/A |
| 29 | CiFn secrets (runner, webhook) and job secrets in secfn | Security | SEC-004, SEC-001 | TV-SEC-005, TV-SEC-003 |
| 30 | Config in repo; no vendor-only pipeline | Invariants | PIPE-006 | TV-PIPE-010 |
| 31 | CLI run, status, logs | Public API, CLI | CLI-001–CLI-003 | TV-CLI-001–TV-CLI-004 |
| 32 | Same auth and logging (secfn, logfn/watchfn) | Security, Observability | SEC-004, OBS-001 | TV-SEC-005, TV-OBS-001 |
| 33 | Optional sendfn | Observability (root SPEC), Requirements | DASH-002 | TV-DASH-002 |
| 34 | Dashboard (run list, detail, logs, artifacts) | Public API, Goals | DASH-001 | TV-DASH-001 |
| 35 | Expression ${{ }} (secrets., github., hashFiles) | Glossary, PIPE-005 | PIPE-005, PIPE-009 | TV-PIPE-008, TV-PIPE-009 |
| 36 | Job-level and step-level env and with | Pipeline config schema | PIPE-001 | TV-PIPE-001 |
| 37 | Step condition if | Semantics, Invariants | PIPE-009, RUN-003 | TV-PIPE-008 |
| 38 | runs-on values | PIPE-008, Public API | PIPE-008 | TV-RUNNER-001 |
| 39 | Artifact upload/download by name and path | Semantics | RUN-005 | TV-INT-002 |
| 40 | Cache key expressions; paths for save | Semantics | RUN-006 | TV-INT-003 |
| 41 | ciFn like CircleCI/Buildkite | Overview, Goals | Full spec | All |
| 42 | watchFn monitors flowFn; CiFn as workflow | Observability | OBS-003 | TV-OBS-003 |
| 43 | Non-goals (GHA parity, K8s, SaaS) | Non-goals, Undefined | Explicit in SPEC | N/A |

---

## Audit result

- **Intent items 1–42**: Each is covered by at least one SPEC section, one or more requirement IDs, and (where applicable) test vectors. Operational items (27, 28) are documented in root SPEC and Undefined/operational; no MUST requirements for deployment topology.
- **Intent item 43**: Explicitly listed under Non-goals and Undefined; no requirements assert GHA parity, K8s, or SaaS.

**No missing intent items.** The spec bundle (SPEC.md, REQUIREMENTS.md, TEST_VECTORS.md, PLAN.md, phases) covers the entire intent from cifn/SPEC.md and superfunctions-ar-notes.md. Priorities (P0/P1/P2) are used only for sequencing in phases; no scope is deferred except what is explicitly listed in Undefined / Non-goals.
