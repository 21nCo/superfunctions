# Phase 09: Docker runner and hostfn-runner

## Phase goal
Support running jobs in a Docker container (default runner type with image) and support hostfn-runner type that executes on a hostfn-managed node and can run hostfn deploy --local --ci.

## In scope
- Docker runner: when job runs-on default (or label that maps to Docker), control plane or runner spawns container with image (from config or job); injects workspace (volume or copy); runs step commands inside container; collects logs and status; optional image from job (e.g. node:20).
- hostfn-runner: runner process that identifies as type hostfn-runner (label or runs-on); registers with same control plane; claims only jobs with runs-on: hostfn-runner; when executing hostfn/deploy step, use --local --ci when runner is on same node as deploy target.
- runs-on dispatch: job with runs-on: default goes to default (process or Docker) runner; runs-on: hostfn-runner goes to hostfn-runner; optional runs-on: docker-ubuntu-22 matched by runner labels.

## Out of scope
- Kubernetes job execution; auto-scaling runners.

## Deliverables
- `cifn/typescript/runner/src/docker-executor.ts` or runner mode docker: run job in container with image; mount workspace; execute steps; stream logs.
- Runner registration with labels: default, hostfn-runner, or custom (e.g. docker-ubuntu-22); control plane dispatches job to runner whose labels match runs-on.
- hostfn-runner runner type: same executor but on hostfn node; hostfn/deploy step passes --local when configured.
- Tests: TV-RUNNER-001, TV-RUNNER-006.

## Requirements covered
- RUNNER-001, RUNNER-004, RUNNER-006, PIPE-008.

## Implementation tasks
1. Docker executor: given job spec and workspace path, create container (docker run or Docker API) with image from job or default (e.g. node:20); mount workspace; run each step as shell in container; capture output; on completion remove container (or reuse). Integrate with existing runner loop: when runs-on indicates Docker, use Docker executor instead of local process.
2. Runner labels: at register, runner sends labels (e.g. ["default"] or ["hostfn-runner"]); store with runner; when dispatching job, filter runners by runs-on matching label; default runner has label "default"; hostfn-runner has label "hostfn-runner".
3. hostfn-runner runner: separate runner binary or mode that registers with label hostfn-runner; runs on same host as hostfn target; hostfn/deploy step: when runner is hostfn-runner and option local true (or default for this type), call hostfn deploy <env> --local --ci.
4. Tests: create run with job runs-on default and image node:20; assert job runs in container. Create run with job runs-on hostfn-runner and hostfn/deploy; assert --local used when runner is hostfn-runner (mock or real hostfn).
5. Document runner types and runs-on in SPEC or README.

## Verification steps
- Job with runs-on: default and Docker image runs in container; logs and status reported. TV-RUNNER-001.
- Job with runs-on: hostfn-runner and hostfn/deploy step; when runner is hostfn-runner, hostfn CLI invoked with --local --ci. TV-RUNNER-006.
- Run tests: `npm test` for Docker and hostfn-runner.

## Stop condition
- Docker runner and hostfn-runner implemented; job dispatch by runs-on works. Report: "Phase 09 complete; runner types ready for Phase 10 (dashboard)."
