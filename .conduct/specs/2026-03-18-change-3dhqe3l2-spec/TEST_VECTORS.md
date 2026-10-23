# TV-PLUG-001

- **Description**: Conduct dependency graph uses PlugFn provider actions rather than Conduct-specific integration code.
- **Input**:
  ```json
  {
    "conductIntegrationCall": "plug.linear['comments.create']({ issueId: 'ENG-1234', body: 'Spec created' })",
    "customConductProviderCodePresent": false
  }
  ```
- **Expected output**:
  ```json
  {
    "integrationRuntime": "plugfn",
    "customConductProviderCodePresent": false
  }
  ```
- **Negative variant(s)**:
  - If Conduct must import provider-internal files or define ad hoc PM client wrappers, return `PROVIDER_RUNTIME_BYPASS`.

# TV-LIN-001

- **Description**: Linear provider supports issue get, comment create, issue search, and verified update/comment triggers.
- **Input**:
  ```json
  {
    "actions": [
      {"name": "issues.get", "input": {"issueId": "ENG-1234"}},
      {"name": "comments.create", "input": {"issueId": "ENG-1234", "body": "Phase 1 complete"}},
      {"name": "issues.search", "input": {"query": "OAuth", "first": 20}}
    ],
    "trigger": {
      "name": "issue_comment.created",
      "verified": true
    }
  }
  ```
- **Expected output**:
  ```json
  {
    "actionsAvailable": true,
    "triggerAvailable": true
  }
  ```
- **Negative variant(s)**:
  - Missing comment trigger or unverified webhook payloads MUST fail with provider-validation errors.

# TV-GH-001

- **Description**: GitHub provider supports issue updates, PR creation, review creation, and comment/closure triggers.
- **Input**:
  ```json
  {
    "actions": [
      {"name": "issues.update", "input": {"owner": "21nCo", "repo": "super-functions", "issueNumber": 42, "state": "closed"}},
      {"name": "pulls.create", "input": {"owner": "21nCo", "repo": "super-functions", "title": "Conduct phase 1", "head": "feat/conduct-phase-1", "base": "next"}},
      {"name": "pulls.createReview", "input": {"owner": "21nCo", "repo": "super-functions", "pullNumber": 42, "body": "Audit summary", "event": "COMMENT"}}
    ],
    "trigger": {
      "name": "issue_comment.created",
      "verified": true
    }
  }
  ```
- **Expected output**:
  ```json
  {
    "actionsAvailable": true,
    "triggerAvailable": true
  }
  ```
- **Negative variant(s)**:
  - If Conduct cannot post a PR review or receive issue comment events through public provider APIs, return `GITHUB_PROVIDER_GAP`.

# TV-CLICKUP-001

- **Description**: ClickUp provider exposes the required task/comment actions and update/status triggers.
- **Input**:
  ```json
  {
    "provider": "clickup",
    "actions": ["tasks.create", "tasks.get", "tasks.update", "tasks.list", "comments.create", "spaces.list"],
    "triggers": ["task.updated", "task.statusChanged"]
  }
  ```
- **Expected output**:
  ```json
  {
    "registered": true,
    "oauthEnabled": true
  }
  ```
- **Negative variant(s)**:
  - Missing trigger registration or absent OAuth configuration MUST fail package verification.

# TV-CLIFN-001

- **Description**: `clifn` exports stable subpaths and deterministic stdio/config behavior.
- **Input**:
  ```json
  {
    "imports": [
      "clifn/credentials",
      "clifn/config",
      "clifn/client",
      "clifn/ui",
      "clifn/stdio",
      "clifn/prompt"
    ],
    "stdin": "{\"prompt\":\"/spec OAuth\"}"
  }
  ```
- **Expected output**:
  ```json
  {
    "importsResolved": true,
    "parsedJson": {"prompt": "/spec OAuth"}
  }
  ```
- **Negative variant(s)**:
  - Invalid JSON MUST fail deterministically.
  - Missing subpath exports MUST fail package build/tests.

# TV-READY-001

- **Description**: Ready packages pass a Conduct dependency harness without source changes.
- **Input**:
  ```json
  {
    "packages": [
      "@superfunctions/db",
      "@superfunctions/storage-s3",
      "@superfunctions/http",
      "@superfunctions/auth",
      "@superfunctions/webhooks",
      "@superfunctions/queue"
    ]
  }
  ```
- **Expected output**:
  ```json
  {
    "harnessStatus": "pass",
    "packagesModified": []
  }
  ```
- **Negative variant(s)**:
  - If a package requires changes, the harness output MUST identify the precise failing behavior and the change request.

# TV-SCHEMA-001

- **Description**: Conduct schema requirements are supported either by codegen or direct Drizzle fallback.
- **Input**:
  ```json
  {
    "constraintRequirement": {
      "unique": ["spec_id", "phase_number"],
      "check": "status IN ('pending','in_progress','complete','failed','blocked')"
    }
  }
  ```
- **Expected output**:
  ```json
  {
    "supportedPath": "direct-drizzle-fallback",
    "verified": true
  }
  ```
- **Negative variant(s)**:
  - If neither codegen nor fallback can express the required schema, return `SCHEMA_SUPPORT_BLOCKED`.

# TV-WORKSPACE-001

- **Description**: `clifn` package placement follows repo conventions and root workspaces include it.
- **Input**:
  ```json
  {
    "workspaceCandidate": "clifn/core",
    "rootWorkspaces": ["plugfn/*", "packages/*", "authfn/*"]
  }
  ```
- **Expected output**:
  ```json
  {
    "acceptedLayout": true,
    "updatedWorkspacePatternPresent": true
  }
  ```
- **Negative variant(s)**:
  - Flat package placement that bypasses workspace conventions or introduces a nested monorepo MUST fail review.

# TV-TEST-001

- **Description**: Dependency-level tests cover provider actions, webhook verification, and `clifn` behavior locally.
- **Input**:
  ```json
  {
    "testSuites": [
      "plugfn linear provider tests",
      "plugfn github provider tests",
      "plugfn clickup provider tests",
      "clifn tests",
      "conduct dependency harness"
    ]
  }
  ```
- **Expected output**:
  ```json
  {
    "allPass": true
  }
  ```
- **Negative variant(s)**:
  - If provider additions land without local test coverage, return `DEPENDENCY_TEST_GAP`.

# TV-DOCS-001

- **Description**: New shared-package capabilities are documented through public READMEs/docs.
- **Input**:
  ```json
  {
    "artifacts": [
      "clifn README",
      "PlugFn Linear docs",
      "PlugFn GitHub docs",
      "PlugFn ClickUp docs"
    ]
  }
  ```
- **Expected output**:
  ```json
  {
    "publicExamplesPresent": true
  }
  ```
- **Negative variant(s)**:
  - If the new APIs exist only in Conduct-local notes or private implementation comments, return `SHARED_PACKAGE_DOC_GAP`.
