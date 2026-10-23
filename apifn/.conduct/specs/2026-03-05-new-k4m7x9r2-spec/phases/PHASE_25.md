# Phase 25: CI/CD Integration

## Phase Goal
Create reusable CI/CD tooling for API validation, diff, and testing in pipelines.

## In Scope
- GitHub Actions reusable workflow
- PR comment with diff summary and test results
- Non-zero exit code enforcement
- Report output formats (JSON, markdown)
- Example workflow files

## Out of Scope
- GitLab CI, Jenkins, etc. (document CLI usage for those)
- Deployment automation

## Deliverables
- `apifn/.github/workflows/api-check.yml` — reusable workflow
- `apifn/examples/ci-cd/github-actions.yml` — example usage
- `apifn/cli/src/commands/` — ensure all commands support `--format json` for machine parsing
- Documentation for CI/CD usage

## Requirements Covered
- CI-001, CI-002, CI-003, CI-004

## Implementation Tasks
1. [ ] Create reusable GitHub Actions workflow: inputs for spec path, collection path, base branch
2. [ ] Implement validation step: `apifn validate` with exit code check
3. [ ] Implement diff step: `apifn diff` against base branch spec with exit code
4. [ ] Implement test step: `apifn test` with exit code
5. [ ] Implement PR comment step: use `gh` CLI or actions/github-script to post summary
6. [ ] Implement markdown summary generation from JSON reports
7. [ ] Create example workflow showing typical usage
8. [ ] Test workflow manually on a sample repository
9. [ ] Document CI/CD usage in README

## Verification Steps
1. Workflow YAML is valid (actionlint validation)
2. Example workflow references correct action inputs
3. `apifn diff --format json` produces parseable JSON
4. `apifn test --reporter json` produces parseable JSON
5. TV-CI-001 through TV-CI-004

## Stop Condition
Workflow is valid and documented. Example workflow demonstrates the full CI flow. Report workflow steps.
