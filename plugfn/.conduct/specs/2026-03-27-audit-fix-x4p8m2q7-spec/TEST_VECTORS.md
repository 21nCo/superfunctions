## TV-CONTRACT-001

- Description: the public PlugFn contract describes one general integration runtime and scopes production-ready claims to an explicit provider matrix.
- Input:

```json
{
  "files": [
    "plugfn/README.md",
    "plugfn/SPEC.md",
    "plugfn/typescript/README.md",
    "plugfn/python/README.md",
    "plugfn/.conduct/STATUS.md",
    "plugfn/docs/provider-readiness-matrix.md"
  ]
}
```

- Expected output:

```json
{
  "coreRuntime": "general shared integration runtime",
  "verticalScopeExplicit": true,
  "productionClaimBoundedToMatrix": true
}
```

- Negative variant(s):

```json
{
  "conflict": {
    "README": "generic production-ready integration runtime",
    "STATUS": "production ready for all features",
    "matrix": "missing vertical/core separation"
  },
  "expectedResult": {
    "errorCode": "PLUGFN_SCOPE_CONFLICT"
  }
}
```

## TV-PKG-001

- Description: package manifests and docs agree on the publishable package names.
- Input:

```json
{
  "typescriptPackageName": "plugfn",
  "cliPackageName": "@plugfn/cli",
  "grepTargets": [
    "plugfn/README.md",
    "plugfn/typescript/README.md",
    "plugfn/docs/getting-started.md"
  ]
}
```

- Expected output:

```json
{
  "docsContainInstallNames": ["plugfn", "@plugfn/cli"],
  "legacyPackageNamesAbsent": true
}
```

- Negative variant(s):

```json
{
  "invalidDocs": {
    "contains": "@superfunctions/plugfn"
  },
  "expectedResult": {
    "errorCode": "PLUGFN_PACKAGE_CONTRACT_INVALID"
  }
}
```

## TV-PLAT-001

- Description: PlugFn uses `@superfunctions/db` directly and declares first-class persistence mappings.
- Input:

```json
{
  "configFile": "plugfn/typescript/src/types/config.ts",
  "runtimeFiles": [
    "plugfn/typescript/src/core/connection-manager.ts",
    "plugfn/typescript/src/storage/connection-storage.ts"
  ]
}
```

- Expected output:

```json
{
  "databaseType": "@superfunctions/db.Adapter",
  "requiredModels": [
    "connections",
    "oauth_states",
    "oauth_tokens",
    "workflows",
    "workflow_executions"
  ],
  "syntheticOAuthStorageAbsent": true
}
```

- Negative variant(s):

```json
{
  "invalidRuntime": {
    "databaseType": "Partial<Adapter>",
    "syntheticOAuthStorage": "__oauth_state_system__"
  },
  "expectedResult": {
    "errorCode": "OAUTH_STORAGE_BACKEND_REQUIRED"
  }
}
```

## TV-OAUTH-001

- Description: OAuth callback persists connection and token state through first-class stores, not system connection records.
- Input:

```json
{
  "callbackInput": {
    "provider": "github",
    "code": "oauth-code",
    "state": "st_01"
  }
}
```

- Expected output:

```json
{
  "connectionRecordCreated": true,
  "oauthStateConsumed": true,
  "oauthTokenRecordCreated": true,
  "systemConnectionHackUsed": false
}
```

- Negative variant(s):

```json
{
  "invalidPersistence": {
    "oauthTokenStoredInConnectionRecord": true
  },
  "expectedResult": {
    "errorCode": "OAUTH_STORAGE_BACKEND_REQUIRED"
  }
}
```

## TV-OAUTH-002

- Description: the legacy OAuth import path emits deprecation guidance but remains wrapper-only.
- Input:

```json
{
  "file": "plugfn/typescript/src/auth/oauth-flow.ts"
}
```

- Expected output:

```json
{
  "warningCode": "DEPRECATED_PATH",
  "replacement": "@superfunctions/oauth-flow",
  "wrapperOnly": true
}
```

- Negative variant(s):

```json
{
  "invalidLegacyShim": {
    "contains": ["exchangeToken", "refreshToken", "MemoryOAuthStateStore"]
  },
  "expectedResult": {
    "errorCode": "OAUTH_LEGACY_SHIM_VIOLATION"
  }
}
```

## TV-ROUTER-001

- Description: TypeScript and Python expose the same canonical route inventory and envelopes.
- Input:

```json
{
  "canonicalRoutes": [
    "GET /callback",
    "POST /webhooks/:provider/:event",
    "GET /providers",
    "GET /connections",
    "POST /connections/auth",
    "POST /connections/disconnect",
    "GET /workflows",
    "GET /metrics"
  ]
}
```

- Expected output:

```json
{
  "typescriptRoutesMatch": true,
  "pythonRoutesMatch": true,
  "successEnvelopeStable": true,
  "errorEnvelopeStable": true
}
```

- Negative variant(s):

```json
{
  "missingPythonCallbackRoute": true,
  "expectedResult": {
    "errorCode": "RELEASE_GATE_FAILED"
  }
}
```

## TV-AUTH-001

- Description: non-webhook routes derive identity from auth and reject mismatched caller-supplied identity.
- Input:

```json
{
  "request": {
    "route": "/connections/auth",
    "derivedPrincipal": {
      "userId": "user_1",
      "tenantId": "tenant_1"
    },
    "body": {
      "userId": "user_2",
      "provider": "github",
      "redirectUri": "https://app.example.com/callback"
    }
  }
}
```

- Expected output:

```json
{
  "status": 403,
  "errorCode": "TENANT_ACCESS_DENIED"
}
```

- Negative variant(s):

```json
{
  "missingAuth": {
    "route": "/connections"
  },
  "expectedResult": {
    "status": 401,
    "errorCode": "PLUGFN_AUTH_REQUIRED"
  }
}
```

## TV-WEBHOOK-001

- Description: signed providers verify against raw bytes and fail on JSON reserialization mismatch.
- Input:

```json
{
  "provider": "github",
  "rawBody": "{\"action\":\"opened\",\"issue\":{\"id\":1}}",
  "headers": {
    "x-hub-signature-256": "sha256=valid-signature"
  },
  "secret": "whsec_123"
}
```

- Expected output:

```json
{
  "verified": true,
  "usedRawBytes": true
}
```

- Negative variant(s):

```json
{
  "invalidVerification": {
    "rawBody": "{\"issue\":{\"id\":1},\"action\":\"opened\"}",
    "parsedPayload": {
      "action": "opened",
      "issue": {
        "id": 1
      }
    }
  },
  "expectedResult": {
    "status": 401,
    "errorCode": "WEBHOOK_SIGNATURE_INVALID"
  }
}
```

## TV-WORKFLOW-001

- Description: workflow disable/delete detaches active trigger bindings.
- Input:

```json
{
  "workflowId": "wf_01",
  "operations": ["enable", "disable", "delete"]
}
```

- Expected output:

```json
{
  "triggerRegisteredOnEnable": true,
  "triggerUnregisteredOnDisable": true,
  "triggerUnregisteredBeforeDelete": true
}
```

- Negative variant(s):

```json
{
  "noopUnregister": true,
  "expectedResult": {
    "errorCode": "WORKFLOW_TRIGGER_UNREGISTER_FAILED"
  }
}
```

## TV-WORKFLOW-002

- Description: delayed/idempotent workflow execution survives restart and multi-instance resume.
- Input:

```json
{
  "workflowId": "wf_02",
  "triggerPayload": {
    "idempotencyKey": "evt_01"
  },
  "restartBetweenSteps": true
}
```

- Expected output:

```json
{
  "executionResumed": true,
  "completedOnce": true,
  "duplicateExecutionPrevented": true
}
```

- Negative variant(s):

```json
{
  "processLocalOnlyTimer": true,
  "expectedResult": {
    "errorCode": "WORKFLOW_DURABILITY_UNSUPPORTED"
  }
}
```

## TV-CLI-001

- Description: `plugfn test` performs real provider diagnostics and returns deterministic JSON + exit code.
- Input:

```json
{
  "command": "plugfn test --provider github --user-id user_1 --action issues.get --json"
}
```

- Expected output:

```json
{
  "exitCode": 0,
  "json": {
    "ok": true,
    "provider": "github",
    "action": "issues.get"
  }
}
```

- Negative variant(s):

```json
{
  "brokenConnection": true,
  "expectedResult": {
    "exitCode": 2,
    "errorCode": "CLI_PROVIDER_CHECK_FAILED"
  }
}
```

## TV-PY-001

- Description: Python imports cleanly, tests pass, and docs/status tell the truth.
- Input:

```json
{
  "commands": [
    "python3 -m pytest -q plugfn/python/tests"
  ],
  "files": [
    "plugfn/python/README.md",
    "plugfn/python/SUMMARY.md",
    "plugfn/.conduct/STATUS.md"
  ]
}
```

- Expected output:

```json
{
  "pytestExitCode": 0,
  "docsParityTruthful": true
}
```

- Negative variant(s):

```json
{
  "importFailure": "Provider object has no field auth_config",
  "expectedResult": {
    "errorCode": "PYTHON_PARITY_INCOMPLETE"
  }
}
```

## TV-PY-002

- Description: Python adapters derive auth identity and verify webhooks against raw bytes.
- Input:

```json
{
  "adapter": "fastapi",
  "request": {
    "queryUserId": "user_from_query",
    "derivedPrincipal": {
      "userId": "user_from_auth"
    },
    "rawBody": "{\"type\":\"issue.updated\"}"
  }
}
```

- Expected output:

```json
{
  "usedDerivedPrincipal": true,
  "queryUserIdIgnoredAsAuthority": true,
  "rawWebhookBytesUsed": true
}
```

- Negative variant(s):

```json
{
  "placeholderAuthPath": true,
  "expectedResult": {
    "errorCode": "PLUGFN_AUTH_REQUIRED"
  }
}
```

## TV-PY-003

- Description: Python exports and tests the declared core provider set.
- Input:

```json
{
  "imports": [
    "github_provider",
    "linear_provider",
    "clickup_provider",
    "gmail_provider"
  ]
}
```

- Expected output:

```json
{
  "allImportsResolve": true,
  "matrixStatuses": {
    "github": "production",
    "linear": "production",
    "clickup": "production",
    "gmail": "production"
  }
}
```

- Negative variant(s):

```json
{
  "missingProviderExport": "linear_provider",
  "expectedResult": {
    "errorCode": "PYTHON_PARITY_INCOMPLETE"
  }
}
```

## TV-PROVIDER-001

- Description: the provider readiness matrix names the core provider set and truthfully marks all other provider states.
- Input:

```json
{
  "matrixFile": "plugfn/docs/provider-readiness-matrix.md"
}
```

- Expected output:

```json
{
  "containsCoreProviders": ["github", "linear", "clickup", "gmail"],
  "allowedStatusesOnly": true,
  "typescriptPythonColumnsPresent": true
}
```

- Negative variant(s):

```json
{
  "unsupportedClaim": {
    "provider": "google-drive",
    "status": "production"
  },
  "expectedResult": {
    "errorCode": "PROVIDER_STATUS_UNSUPPORTED"
  }
}
```

## TV-SDK-001

- Description: the browser/client boundary remains thin and server-delegating.
- Input:

```json
{
  "clientOperation": "refreshToken"
}
```

- Expected output:

```json
{
  "allowedOperations": ["getProviderCatalog", "startConnection"],
  "serverOnlyOperationsRejected": true
}
```

- Negative variant(s):

```json
{
  "invalidBrowserOperation": "verifyWebhookSignature",
  "expectedResult": {
    "errorCode": "CLIENT_SDK_SERVER_ONLY_OPERATION"
  }
}
```

## TV-DOCS-001

- Description: PlugFn docs/status/release artifacts are truthful and contain no machine-specific absolute paths.
- Input:

```json
{
  "files": [
    "plugfn/README.md",
    "plugfn/typescript/README.md",
    "plugfn/python/README.md",
    "plugfn/python/SUMMARY.md",
    "plugfn/.conduct/STATUS.md",
    "plugfn/docs/getting-started.md",
    "plugfn/docs/operations/release-gates.md"
  ]
}
```

- Expected output:

```json
{
  "containsAbsolutePaths": false,
  "productionClaimMatchesGate": true,
  "pythonReadinessClaimsConsistent": true
}
```

- Negative variant(s):

```json
{
  "badDocs": {
    "contains": "{absolute_path_prefix}"
  },
  "expectedResult": {
    "errorCode": "PLUGFN_PACKAGE_CONTRACT_INVALID"
  }
}
```

## TV-REL-001

- Description: the repo-root release gate passes for runtime, CLI, Python, docs, and end-to-end checks.
- Input:

```json
{
  "commands": [
    "npm run gate:plugfn-release",
    "npm test --workspace plugfn",
    "npm test --workspace @plugfn/cli",
    "python3 -m pytest -q plugfn/python/tests"
  ]
}
```

- Expected output:

```json
{
  "allExitCodes": 0,
  "oauthE2E": "pass",
  "webhookE2E": "pass",
  "docsInventory": "pass"
}
```

- Negative variant(s):

```json
{
  "failingGate": {
    "command": "npm run gate:plugfn-release",
    "reason": "python parity or e2e check failed"
  },
  "expectedResult": {
    "errorCode": "RELEASE_GATE_FAILED"
  }
}
```
