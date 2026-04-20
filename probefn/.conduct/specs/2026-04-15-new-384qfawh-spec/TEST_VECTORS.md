# TV-CONFIG-001

- Description: Load a valid repo-root config and materialize defaults for a healthy Vite fixture.
- Input:
  ```json
  {
    "command": "config.load",
    "configPath": "test/fixtures/vite-healthy/probefn.config.ts"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "projectName": "vite-healthy",
      "artifactRoot": ".artifacts",
      "defaultBrowser": "chromium",
      "defaultMode": "mixed",
      "devServers": ["web"]
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "config.load",
      "configPath": "test/fixtures/invalid-browser/probefn.config.ts"
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_CONFIG_INVALID",
      "message": "Invalid browser engine \"safari\" in probefn config."
    }
    ```

# TV-SESSION-001

- Description: Start a session by spawning a managed Vite fixture server.
- Input:
  ```json
  {
    "command": "session.start",
    "fixture": "vite-healthy",
    "args": {
      "mode": "mixed",
      "browser": "chromium",
      "devServer": {
        "mode": "spawn",
        "name": "web",
        "command": "pnpm vite --config test/fixtures/vite-healthy/vite.config.ts --port 4173",
        "cwd": "repo root",
        "url": "http://127.0.0.1:4173",
        "readyPattern": "Local:",
        "timeoutMs": 120000
      }
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "sessionId": "sess_healthy",
      "runId": "run_healthy",
      "artifactRoot": ".artifacts/runs/run_healthy",
      "startedAt": "2026-04-15T12:43:55Z"
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "session.start",
      "fixture": "vite-hangs",
      "args": {
        "mode": "mixed",
        "browser": "chromium",
        "devServer": {
          "mode": "spawn",
          "name": "web",
          "command": "pnpm vite --config test/fixtures/vite-hangs/vite.config.ts --port 4174",
          "cwd": "repo root",
          "url": "http://127.0.0.1:4174",
          "readyPattern": "Local:",
          "timeoutMs": 5000
        }
      }
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_DEVSERVER_START_TIMEOUT",
      "message": "Dev server did not become ready within 5000ms."
    }
    ```

# TV-SESSION-002

- Description: Attach a session to an already-running local server.
- Input:
  ```json
  {
    "command": "session.start",
    "fixture": "vite-healthy-attached",
    "args": {
      "mode": "debug",
      "browser": "chromium",
      "devServer": {
        "mode": "attach",
        "name": "web",
        "url": "http://127.0.0.1:4175"
      }
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "sessionId": "sess_attach",
      "runId": "run_attach",
      "artifactRoot": ".artifacts/runs/run_attach",
      "startedAt": "2026-04-15T12:43:55Z"
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "session.start",
      "args": {
        "mode": "debug",
        "browser": "chromium",
        "devServer": {
          "mode": "attach",
          "name": "web",
          "url": "http://127.0.0.1:4999"
        }
      }
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_URL_UNREACHABLE",
      "message": "Could not reach http://127.0.0.1:4999 before session start."
    }
    ```

# TV-BROWSER-001

- Description: Launch a Chromium-backed browser session and persist the selected engine.
- Input:
  ```json
  {
    "command": "session.start",
    "fixture": "vite-healthy",
    "args": {
      "mode": "debug",
      "browser": "chromium"
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "sessionId": "sess_browser",
      "runId": "run_browser",
      "browser": "chromium"
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "session.start",
      "args": {
        "mode": "debug",
        "browser": "netscape"
      }
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_CONFIG_INVALID",
      "message": "Invalid browser engine \"netscape\"."
    }
    ```

# TV-ACTION-001

- Description: Execute a deterministic click action against a role-based locator.
- Input:
  ```json
  {
    "command": "page.act",
    "sessionId": "sess_healthy",
    "action": {
      "kind": "click",
      "target": {
        "selector": "role=button[name=\"Save\"]"
      }
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "action": "click",
      "targetElementId": "el_save_button",
      "newConsoleErrors": 0,
      "newNetworkFailures": 0,
      "checkpointId": null
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "page.act",
      "sessionId": "sess_healthy",
      "action": {
        "kind": "click",
        "target": {
          "selector": "role=button[name=\"Does Not Exist\"]"
        }
      }
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_ACTION_TARGET_NOT_FOUND",
      "message": "No element matched selector role=button[name=\"Does Not Exist\"]."
    }
    ```

# TV-ACTION-002

- Description: Resolve and click a semantic query through the page model.
- Input:
  ```json
  {
    "command": "page.act",
    "sessionId": "sess_healthy",
    "action": {
      "kind": "click",
      "target": {
        "query": "Save button"
      }
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "action": "click",
      "targetElementId": "el_save_button",
      "usedVisionAssist": false,
      "newConsoleErrors": 0,
      "newNetworkFailures": 0
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "page.find",
      "sessionId": "sess_ambiguous",
      "query": "Save button"
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_ACTION_AMBIGUOUS",
      "message": "Multiple interactable elements matched the provided query."
    }
    ```

# TV-ACTION-003

- Description: Return an ambiguity error when more than one structurally valid target matches.
- Input:
  ```json
  {
    "command": "page.find",
    "sessionId": "sess_ambiguous",
    "query": "Primary CTA"
  }
  ```
- Expected output:
  ```json
  {
    "ok": false,
    "schemaVersion": "1.0",
    "error": {
      "code": "E_ACTION_AMBIGUOUS",
      "message": "Multiple interactable elements matched the provided query.",
      "retryable": true,
      "details": {
        "query": "Primary CTA",
        "candidateCount": 2
      }
    }
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "page.find",
      "sessionId": "sess_healthy",
      "query": "Imaginary CTA"
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_ACTION_TARGET_NOT_FOUND",
      "message": "No interactable element matched the provided query."
    }
    ```

# TV-ACTION-004

- Description: Reject a vision-ranked target when DOM confirmation shows the element is hidden behind an overlay.
- Input:
  ```json
  {
    "command": "page.act",
    "sessionId": "sess_overlay",
    "action": {
      "kind": "click",
      "target": {
        "query": "Checkout button",
        "requireDomConfirmation": true
      }
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": false,
    "schemaVersion": "1.0",
    "error": {
      "code": "E_ACTION_NOT_INTERACTABLE",
      "message": "Matched element is not safely interactable after DOM confirmation.",
      "retryable": true,
      "details": {
        "query": "Checkout button",
        "usedVisionAssist": true
      }
    }
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "page.act",
      "sessionId": "sess_overlay",
      "action": {
        "kind": "click",
        "target": {
          "query": "Checkout button",
          "requireDomConfirmation": false
        }
      }
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_CONFIG_INVALID",
      "message": "Vision-assisted actions must require DOM confirmation."
    }
    ```

# TV-CHECKPOINT-001

- Description: Create a complete checkpoint with required evidence artifacts.
- Input:
  ```json
  {
    "command": "checkpoint.create",
    "sessionId": "sess_healthy",
    "args": {
      "name": "landing",
      "includeTrace": true,
      "includeStyles": true
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "checkpointId": "chk_landing",
      "artifacts": [
        "checkpoints/landing/screenshot.png",
        "checkpoints/landing/dom.json",
        "checkpoints/landing/ax.json",
        "checkpoints/landing/layout.json",
        "checkpoints/landing/styles.json"
      ]
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "checkpoint.create",
      "sessionId": "sess_crash",
      "args": {
        "name": "after-crash"
      }
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_CHECKPOINT_CAPTURE_FAILED",
      "message": "Required checkpoint artifacts could not be captured."
    }
    ```

# TV-EVENT-001

- Description: Persist console errors, page errors, network failures, and dev-server logs as separate sinks.
- Input:
  ```json
  {
    "command": "run.flow",
    "sessionId": "sess_console_error",
    "file": "test/fixtures/vite-console-error/flows/trigger-error.yaml"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "consoleSink": "checkpoints/after-submit/console.ndjson",
      "pageErrorSink": "checkpoints/after-submit/page-errors.ndjson",
      "networkSink": "checkpoints/after-submit/network.ndjson",
      "devServerStdoutSink": "devserver/stdout.ndjson",
      "devServerStderrSink": "devserver/stderr.ndjson"
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "read.eventSink",
      "sessionId": "sess_console_error",
      "sink": "devserver/missing.ndjson"
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_STORAGE_WRITE_FAILED",
      "message": "Requested event sink does not exist."
    }
    ```

# TV-DELTA-001

- Description: Return post-action delta summaries without rereading full sinks.
- Input:
  ```json
  {
    "command": "page.act",
    "sessionId": "sess_console_error",
    "action": {
      "kind": "click",
      "target": {
        "query": "Submit order"
      }
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "action": "click",
      "newConsoleErrors": 1,
      "newPageErrors": 0,
      "newNetworkFailures": 1,
      "checkpointId": "chk_after_submit"
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "page.act",
      "sessionId": "sess_healthy",
      "action": {
        "kind": "click",
        "target": {
          "query": "Save button"
        }
      }
    }
    ```
    Expected output:
    ```json
    {
      "ok": true,
      "schemaVersion": "1.0",
      "data": {
        "action": "click",
        "newConsoleErrors": 0,
        "newPageErrors": 0,
        "newNetworkFailures": 0,
        "checkpointId": null
      },
      "warnings": []
    }
    ```

# TV-STORAGE-001

- Description: Persist a run using the required run-scoped artifact layout and append-only manifests.
- Input:
  ```json
  {
    "command": "report.export",
    "sessionId": "sess_healthy",
    "format": "json"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "reportPath": ".artifacts/runs/run_healthy/report.json",
      "runManifestPath": ".artifacts/runs/run_healthy/session.json",
      "checkpointRoot": ".artifacts/runs/run_healthy/checkpoints"
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "session.inspect",
      "sessionId": "sess_missing"
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_SESSION_NOT_FOUND",
      "message": "Session sess_missing was not found."
    }
    ```

# TV-LIMITS-001

- Description: Enforce event and artifact caps explicitly.
- Input:
  ```json
  {
    "command": "run.flow",
    "sessionId": "sess_spam",
    "file": "test/fixtures/vite-log-spam/flows/spam-console.yaml",
    "overrides": {
      "eventCap": 3
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "eventSink": "checkpoints/spam/console-0002.ndjson"
    },
    "warnings": [
      "Event cap reached; rollover sink console-0002.ndjson created."
    ]
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "checkpoint.create",
      "sessionId": "sess_spam",
      "args": {
        "name": "oversized"
      },
      "overrides": {
        "artifactCapBytes": 1
      }
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_STORAGE_CAP_EXCEEDED",
      "message": "Artifact cap exceeded before checkpoint oversized could be committed."
    }
    ```

# TV-DESIGN-001

- Description: Detect overflow, clipping, overlap, and responsive breakage in a broken-design fixture.
- Input:
  ```json
  {
    "command": "audit.design",
    "sessionId": "sess_overflow",
    "checkpointId": "chk_mobile"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "findings": [
        {
          "findingId": "df_overflow",
          "severity": "high",
          "category": "overflow",
          "summary": "Pricing grid overflows the viewport by 24px at 390px width."
        },
        {
          "findingId": "df_clip",
          "severity": "medium",
          "category": "clipping",
          "summary": "Secondary CTA label is clipped on the right edge."
        }
      ]
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "audit.design",
      "sessionId": "sess_healthy",
      "checkpointId": "chk_mobile"
    }
    ```
    Expected output:
    ```json
    {
      "ok": true,
      "schemaVersion": "1.0",
      "data": {
        "findings": []
      },
      "warnings": []
    }
    ```

# TV-DESIGN-002

- Description: Detect token drift and accessibility-adjacent design issues when token config is present.
- Input:
  ```json
  {
    "command": "audit.design",
    "sessionId": "sess_token_drift",
    "checkpointId": "chk_desktop"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "findings": [
        {
          "findingId": "df_token",
          "severity": "medium",
          "category": "token-drift",
          "summary": "Primary button background #1B5FFF deviates from configured token color #0044CC."
        },
        {
          "findingId": "df_focus",
          "severity": "medium",
          "category": "focus-state",
          "summary": "Focused CTA has no visible outline."
        }
      ]
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "audit.design",
      "sessionId": "sess_no_tokens",
      "checkpointId": "chk_desktop"
    }
    ```
    Expected output:
    ```json
    {
      "ok": true,
      "schemaVersion": "1.0",
      "data": {
        "findings": []
      },
      "warnings": [
        "Token configuration unavailable; token-drift checks skipped."
      ]
    }
    ```

# TV-BASELINE-001

- Description: Record a deterministic baseline keyed by route, viewport, browser, and deterministic settings.
- Input:
  ```json
  {
    "command": "baseline.record",
    "sessionId": "sess_healthy",
    "checkpointId": "chk_landing",
    "baselineKey": "home.desktop.chromium.light.1440x900.utc"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "baselineKey": "home.desktop.chromium.light.1440x900.utc",
      "registryPath": ".artifacts/baselines/registry.json",
      "sourceCheckpointId": "chk_landing"
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "baseline.record",
      "sessionId": "sess_healthy",
      "checkpointId": "chk_landing",
      "baselineKey": "home.desktop.chromium.light.390x844.utc"
    }
    ```
    Expected output:
    ```json
    {
      "ok": true,
      "schemaVersion": "1.0",
      "data": {
        "baselineKey": "home.desktop.chromium.light.390x844.utc",
        "registryPath": ".artifacts/baselines/registry.json",
        "sourceCheckpointId": "chk_landing"
      },
      "warnings": [
        "Baseline key dimensions differ from checkpoint viewport; a distinct baseline entry was recorded."
      ]
    }
    ```

# TV-BASELINE-002

- Description: Compare a checkpoint to a matching baseline with no meaningful regression.
- Input:
  ```json
  {
    "command": "baseline.compare",
    "sessionId": "sess_healthy",
    "checkpointId": "chk_landing",
    "baselineKey": "home.desktop.chromium.light.1440x900.utc"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "baselineKey": "home.desktop.chromium.light.1440x900.utc",
      "status": "pass",
      "pixelDiffPercent": 0.0,
      "findings": []
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "baseline.compare",
      "sessionId": "sess_healthy",
      "checkpointId": "chk_landing",
      "baselineKey": "missing.key"
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_BASELINE_NOT_FOUND",
      "message": "Baseline missing.key was not found."
    }
    ```

# TV-BASELINE-003

- Description: Compare a broken checkpoint against a matching baseline and report meaningful regressions.
- Input:
  ```json
  {
    "command": "baseline.compare",
    "sessionId": "sess_regression",
    "checkpointId": "chk_mobile",
    "baselineKey": "home.mobile.chromium.light.390x844.utc"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "baselineKey": "home.mobile.chromium.light.390x844.utc",
      "status": "fail",
      "pixelDiffPercent": 7.2,
      "findings": [
        {
          "findingId": "rf_missing_cta",
          "severity": "critical",
          "category": "missing-element",
          "summary": "Primary CTA is absent in the current checkpoint but present in the baseline."
        }
      ]
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "baseline.compare",
      "sessionId": "sess_regression",
      "checkpointId": "chk_mobile",
      "baselineKey": "home.desktop.chromium.light.1440x900.utc"
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_BASELINE_MISMATCH",
      "message": "Baseline dimensions do not match the checkpoint dimensions."
    }
    ```

# TV-DEBUG-001

- Description: Correlate action, console, and network evidence into a root-cause hypothesis.
- Input:
  ```json
  {
    "command": "report.export",
    "sessionId": "sess_console_error",
    "format": "json"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "hypotheses": [
        {
          "hypothesisId": "rh_submit_plan",
          "confidence": 0.87,
          "statement": "The submit handler reads a missing plan object after the order form submit.",
          "evidenceEventIds": ["evt_console_1", "evt_network_1"]
        }
      ]
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "report.export",
      "sessionId": "sess_unknown_failure",
      "format": "json"
    }
    ```
    Expected output:
    ```json
    {
      "ok": true,
      "schemaVersion": "1.0",
      "data": {
        "hypotheses": [],
        "unresolvedReason": "Insufficient evidence to assert a root cause."
      },
      "warnings": []
    }
    ```

# TV-REPORT-001

- Description: Export both JSON and Markdown reports with artifact references.
- Input:
  ```json
  {
    "command": "report.export",
    "sessionId": "sess_healthy",
    "format": "markdown"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "reportPath": ".artifacts/runs/run_healthy/report.md",
      "includes": [
        "runMetadata",
        "checkpointIndex",
        "findings",
        "artifactReferences"
      ]
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "report.export",
      "sessionId": "sess_missing",
      "format": "markdown"
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_SESSION_NOT_FOUND",
      "message": "Session sess_missing was not found."
    }
    ```

# TV-AUTH-001

- Description: Save and load a local auth profile for a logged-in fixture app.
- Input:
  ```json
  {
    "command": "auth.profile.save",
    "sessionId": "sess_auth",
    "profileId": "customer-admin"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "profileId": "customer-admin",
      "storageStatePath": ".artifacts/auth-profiles/customer-admin/storage-state.json"
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "session.start",
      "args": {
        "mode": "debug",
        "browser": "chromium",
        "authProfileId": "missing-profile"
      }
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_AUTH_PROFILE_NOT_FOUND",
      "message": "Auth profile missing-profile was not found."
    }
    ```

# TV-SECURITY-001

- Description: Redact secrets from request headers, cookies, and dev-server output before persistence.
- Input:
  ```json
  {
    "command": "run.flow",
    "sessionId": "sess_secret_leak",
    "file": "test/fixtures/vite-secret-leak/flows/leak.yaml"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "redactedValues": 3,
      "reportPath": ".artifacts/runs/run_secret_leak/report.json"
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "run.flow",
      "sessionId": "sess_bad_redaction",
      "file": "test/fixtures/vite-secret-leak/flows/redaction-failure.yaml"
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_REDACTION_FAILURE",
      "message": "Redaction pipeline failed before sensitive data could be persisted safely."
    }
    ```

# TV-DETERMINISM-001

- Description: Run a deterministic capture with fixed environment settings.
- Input:
  ```json
  {
    "command": "session.start",
    "fixture": "vite-healthy",
    "args": {
      "mode": "visual-regression",
      "browser": "chromium",
      "deterministic": {
        "enabled": true,
        "viewport": { "width": 1440, "height": 900 },
        "locale": "en-US",
        "timezone": "UTC",
        "colorScheme": "light",
        "reducedMotion": "reduce",
        "animationPolicy": "freeze",
        "networkIdleMs": 500
      }
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "sessionId": "sess_deterministic",
      "runId": "run_deterministic",
      "deterministic": {
        "enabled": true,
        "viewport": { "width": 1440, "height": 900 },
        "locale": "en-US",
        "timezone": "UTC",
        "colorScheme": "light",
        "reducedMotion": "reduce",
        "animationPolicy": "freeze",
        "networkIdleMs": 500
      }
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "session.start",
      "args": {
        "mode": "visual-regression",
        "browser": "chromium",
        "deterministic": {
          "enabled": true,
          "viewport": { "width": 0, "height": 900 }
        }
      }
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_CONFIG_INVALID",
      "message": "Deterministic viewport must have positive width and height."
    }
    ```

# TV-DETERMINISM-002

- Description: Mark findings as unstable when hot reload occurs during capture.
- Input:
  ```json
  {
    "command": "audit.design",
    "sessionId": "sess_hmr",
    "checkpointId": "chk_mobile"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "findings": [
        {
          "findingId": "df_hmr_overflow",
          "severity": "medium",
          "category": "overflow",
          "summary": "Layout overflow observed during hot reload.",
          "unstable": true
        }
      ]
    },
    "warnings": [
      "Checkpoint chk_mobile was captured during dev-server instability."
    ]
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "audit.design",
      "sessionId": "sess_healthy",
      "checkpointId": "chk_mobile"
    }
    ```
    Expected output:
    ```json
    {
      "ok": true,
      "schemaVersion": "1.0",
      "data": {
        "findings": []
      },
      "warnings": []
    }
    ```

# TV-MCP-001

- Description: Serve MCP tools and execute a tool with the same logical payload as CLI JSON mode.
- Input:
  ```json
  {
    "command": "mcp.toolCall",
    "tool": "probefn_page_get_console",
    "args": {
      "sessionId": "sess_console_error"
    }
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "events": [
        {
          "type": "console",
          "level": "error",
          "text": "TypeError: Cannot read properties of undefined (reading 'plan')"
        }
      ]
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "mcp.toolCall",
      "tool": "probefn_page_get_console",
      "args": {
        "session": "sess_console_error"
      }
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_MCP_INVALID_ARGS",
      "message": "Missing required field sessionId."
    }
    ```

# TV-CLI-001

- Description: Emit the canonical JSON envelope from the CLI.
- Input:
  ```json
  {
    "command": "probefn page find --session sess_healthy --query \"Save button\" --json"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "elements": [
        {
          "elementId": "el_save_button",
          "role": "button",
          "name": "Save"
        }
      ]
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "probefn page find --session sess_missing --query \"Save button\" --json"
    }
    ```
    Expected output:
    ```json
    {
      "ok": false,
      "schemaVersion": "1.0",
      "error": {
        "code": "E_SESSION_NOT_FOUND",
        "message": "Session sess_missing was not found.",
        "retryable": false,
        "details": {
          "sessionId": "sess_missing"
        }
      }
    }
    ```

# TV-OBS-001

- Description: Record a Playwright trace and link it from the exported report.
- Input:
  ```json
  {
    "command": "report.export",
    "sessionId": "sess_trace",
    "format": "json"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "tracePath": ".artifacts/runs/run_trace/browser.trace.zip",
      "reportPath": ".artifacts/runs/run_trace/report.json"
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "report.export",
      "sessionId": "sess_trace_missing",
      "format": "json"
    }
    ```
    Expected output:
    ```json
    {
      "ok": true,
      "schemaVersion": "1.0",
      "data": {
        "tracePath": null,
        "reportPath": ".artifacts/runs/run_trace_missing/report.json"
      },
      "warnings": [
        "Trace artifact was not recorded for this run."
      ]
    }
    ```

# TV-FIXTURE-001

- Description: Execute the full repo-root golden-vector suite against fixture applications.
- Input:
  ```json
  {
    "command": "pnpm test:vectors"
  }
  ```
- Expected output:
  ```json
  {
    "ok": true,
    "schemaVersion": "1.0",
    "data": {
      "vectorsPassed": 28,
      "vectorsFailed": 0
    },
    "warnings": []
  }
  ```
- Negative variant(s):
  - Input:
    ```json
    {
      "command": "pnpm test:vectors -- --fixture missing-fixture"
    }
    ```
    Expected error:
    ```json
    {
      "code": "E_CONFIG_INVALID",
      "message": "Unknown fixture missing-fixture."
    }
    ```
