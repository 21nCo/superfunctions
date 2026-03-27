# Test Vectors

## TV-FLOW-001

- Description: `oauth-flow` prefers runtime resolver output over static runtime config and fails deterministically when the resolver does not return a usable `clientId`.
- Input:

```json
{
  "config": {
    "providerRuntimeConfig": {
      "github": {
        "clientId": "static-client",
        "allowlistedRedirectUris": ["https://app.example/callback"]
      }
    },
    "resolveProviderRuntimeConfig": "returns { clientId: \"resolver-client\", allowlistedRedirectUris: [\"https://app.example/callback\"] }"
  },
  "operation": {
    "type": "start",
    "providerId": "github",
    "tenantId": "tenant_1",
    "userId": "user_1",
    "redirectUri": "https://app.example/callback"
  }
}
```

- Expected output:

```json
{
  "authorizationUrlContains": [
    "client_id=resolver-client",
    "state="
  ],
  "error": null
}
```

- Negative variant(s):

```json
{
  "config": {
    "resolveProviderRuntimeConfig": "returns { allowlistedRedirectUris: [\"https://app.example/callback\"] }"
  },
  "expectedError": {
    "code": "OAUTH_RUNTIME_CONFIG_INVALID",
    "message": "Resolved OAuth runtime config missing clientId"
  }
}
```

## TV-FLOW-002

- Description: encrypted-required token storage rejects plaintext vaults by default and allows encrypted persistence.
- Input:

```json
{
  "config": {
    "tokenVault": "EncryptedTokenVault(memoryVault, cipher)",
    "tokenStorageMode": "encrypted-required"
  },
  "operation": {
    "type": "handleCallback",
    "providerId": "github",
    "state": "st_01",
    "code": "code_01",
    "redirectUri": "https://app.example/callback"
  }
}
```

- Expected output:

```json
{
  "tokenRecordWritten": true,
  "storedPayloadForm": "ciphertext",
  "error": null
}
```

- Negative variant(s):

```json
{
  "config": {
    "tokenVault": "MemoryTokenVault()",
    "tokenStorageMode": "encrypted-required"
  },
  "expectedError": {
    "code": "OAUTH_TOKEN_STORAGE_UNSAFE",
    "message": "encrypted token storage is required unless plaintext-unsafe mode is explicitly enabled"
  }
}
```

## TV-FLOW-003

- Description: disconnect cleanup reporting is truthful with and without a consumer cleanup hook.
- Input:

```json
{
  "config": {
    "identityHooks": {
      "onDisconnected": "returns { attempted: true, deleted: true, reason: \"deleted\" }"
    }
  },
  "operation": {
    "type": "disconnect",
    "providerId": "github",
    "connectionId": "conn_primary",
    "revokeRemote": true
  }
}
```

- Expected output:

```json
{
  "disconnected": true,
  "remoteRevokeAttempted": true,
  "localTokenDeleted": true,
  "connectionCleanup": {
    "attempted": true,
    "deleted": true,
    "reason": "deleted"
  },
  "connectionDeleted": true
}
```

- Negative variant(s):

```json
{
  "config": {
    "identityHooks": {}
  },
  "expectedOutput": {
    "connectionCleanup": {
      "attempted": false,
      "deleted": false,
      "reason": "not-configured"
    },
    "connectionDeleted": false
  }
}
```

## TV-FLOW-004

- Description: disconnect hook failures and invalid results stay deterministic and redaction-safe.
- Input:

```json
{
  "config": {
    "identityHooks": {
      "onDisconnected": "throws new Error(\"cleanup exploded\")"
    }
  },
  "operation": {
    "type": "disconnect",
    "providerId": "github",
    "connectionId": "conn_primary",
    "revokeRemote": false
  }
}
```

- Expected output:

```json
{
  "expectedError": {
    "code": "OAUTH_HOOK_FAILED",
    "message": "identity hook failed"
  },
  "localTokenDeleted": true,
  "eventDetailsMustNotContain": [
    "accessToken",
    "refreshToken",
    "clientSecret",
    "encryptedPayload"
  ]
}
```

- Negative variant(s):

```json
{
  "config": {
    "identityHooks": {
      "onDisconnected": "returns { deleted: true }"
    }
  },
  "expectedError": {
    "code": "VALIDATION_ERROR",
    "message": "disconnect hook returned invalid cleanup result"
  }
}
```

## TV-ROUTER-001

- Description: `oauth-router` route factories use secure defaults and explicit metadata overrides.
- Input:

```json
{
  "connectionRoutes": {
    "basePath": "/oauth/connections",
    "routeMeta": {}
  },
  "browserRoutes": {
    "basePath": "/auth/social",
    "routeMeta": {
      "disconnect": {
        "auth": {
          "mode": "none"
        }
      }
    }
  }
}
```

- Expected output:

```json
{
  "connectionRouteMeta": {
    "start": "hybrid",
    "callback": "none",
    "disconnect": "hybrid"
  },
  "browserRouteMeta": {
    "start": "none",
    "callback": "none",
    "disconnect": "none"
  }
}
```

- Negative variant(s):

```json
{
  "withoutOverride": {
    "browserDisconnectAuthModeMustNotBe": "none",
    "connectionDisconnectAuthModeMustNotBe": "none"
  }
}
```

## TV-PROVIDER-001

- Description: provider policy registry writes durable consent and audit records through async stores.
- Input:

```json
{
  "registryOptions": {
    "consentStore": "async store stub",
    "auditStore": "async audit store stub",
    "idGenerator": "returns consent_fixed_01 then audit_fixed_01",
    "now": "returns 2026-03-27T00:00:00.000Z"
  },
  "operations": [
    {
      "type": "validateScopes",
      "providerId": "google",
      "feature": "mail.read.metadata",
      "requestedScopes": ["https://www.googleapis.com/auth/gmail.readonly"],
      "tenantId": "tenant_1",
      "userId": "user_1",
      "purpose": "mail preview"
    },
    {
      "type": "recordPolicyVersionUpdate",
      "providerId": "google",
      "newVersion": "2026-03-27",
      "actor": "admin_1",
      "reason": "compliance-update"
    }
  ]
}
```

- Expected output:

```json
{
  "consentStoreWrites": 1,
  "auditStoreWrites": 1,
  "consentRecord": {
    "consentId": "consent_fixed_01",
    "policyVersion": "2026-03-11"
  },
  "auditEvent": {
    "fromVersion": "2026-03-11",
    "toVersion": "2026-03-27"
  }
}
```

- Negative variant(s):

```json
{
  "registryOptions": {
    "consentStore": "throws write failure"
  },
  "expectedError": {
    "code": "PROVIDER_POLICY_STORE_FAILED",
    "message": "failed to persist provider policy consent record"
  }
}
```

## TV-PROVIDER-002

- Description: the default provider policy registry remains usable as an in-memory convenience path with deterministic test IDs when injected.
- Input:

```json
{
  "registryFactory": "createDefaultProviderPolicyRegistry",
  "options": {
    "idGenerator": "returns consent_test_01",
    "now": "returns 2026-03-27T00:00:00.000Z"
  },
  "operation": {
    "type": "validateScopes",
    "providerId": "github",
    "feature": "profile.basic",
    "requestedScopes": ["read:user", "user:email"],
    "tenantId": "tenant_1",
    "userId": "user_1",
    "purpose": "profile import"
  }
}
```

- Expected output:

```json
{
  "authorized": true,
  "consentRecord": {
    "consentId": "consent_test_01"
  }
}
```

- Negative variant(s):

```json
{
  "operation": {
    "type": "getPolicy",
    "providerId": "unknown"
  },
  "expectedError": {
    "code": "VALIDATION_ERROR",
    "message": "provider policy not found: unknown"
  }
}
```

## TV-DOCS-001

- Description: docs and READMEs correct the audited storage-name and production-safety mistakes.
- Input:

```json
{
  "files": [
    "packages/oauth-storage/README.md",
    "docs/content/docs/authentication/oauth-storage.mdx",
    "docs/content/docs/authentication/oauth-flow.mdx",
    "docs/content/docs/authentication/oauth-providers.mdx",
    "docs/content/docs/architecture/oauth-flow-architecture.mdx"
  ]
}
```

- Expected output:

```json
{
  "mustContain": [
    "oauth_tokens",
    "EncryptedTokenVault",
    "in-memory convenience",
    "oauth-router"
  ],
  "mustNotContain": [
    "oauth_token_vault"
  ]
}
```

- Negative variant(s):

```json
{
  "forbiddenProductionPattern": "docs/content/docs/authentication/oauth-flow.mdx shows MemoryTokenVault as the only primary production example"
}
```

## TV-DOCS-002

- Description: package README and router docs inventory is complete and discoverable.
- Input:

```json
{
  "expectedFiles": [
    "packages/oauth-core/README.md",
    "packages/oauth-http/README.md",
    "packages/oauth-storage/README.md",
    "packages/oauth-providers/README.md",
    "packages/oauth-flow/README.md",
    "packages/oauth-testing/README.md",
    "packages/oauth-router/README.md",
    "docs/content/docs/authentication/oauth-router.mdx"
  ],
  "navFile": "docs/content/docs/authentication/meta.json"
}
```

- Expected output:

```json
{
  "allFilesExist": true,
  "navContains": [
    "oauth-router"
  ]
}
```

- Negative variant(s):

```json
{
  "missingFileOrNavEntry": {
    "result": "verification failure",
    "message": "shared OAuth package documentation inventory is incomplete"
  }
}
```

## TV-GATE-001

- Description: the shared OAuth release gate succeeds from `repo root` and package-local test commands resolve sibling workspaces without manual prebuild steps.
- Input:

```json
{
  "commands": [
    "npm run gate:packages-oauth-shared",
    "npm test --workspace @superfunctions/oauth-core",
    "npm test --workspace @superfunctions/oauth-http",
    "npm test --workspace @superfunctions/oauth-storage",
    "npm test --workspace @superfunctions/oauth-providers",
    "npm test --workspace @superfunctions/oauth-flow",
    "npm test --workspace @superfunctions/oauth-testing",
    "npm test --workspace @superfunctions/oauth-router"
  ]
}
```

- Expected output:

```json
{
  "allExitCodes": 0,
  "manualDistPrebuildRequired": false
}
```

- Negative variant(s):

```json
{
  "failureCase": {
    "command": "npm test --workspace @superfunctions/oauth-flow",
    "expectedGateResult": "non-zero exit",
    "messageContains": "Cannot find package"
  }
}
```

## TV-COMPAT-001

- Description: compatibility guidance exists for every breaking or deprecating change introduced by this spec.
- Input:

```json
{
  "files": [
    "packages/oauth-flow/README.md",
    "packages/oauth-providers/README.md"
  ],
  "runtimeCheck": {
    "disconnectResult": {
      "connectionCleanup": {
        "attempted": true,
        "deleted": false,
        "reason": "not-found"
      },
      "connectionDeleted": false
    }
  }
}
```

- Expected output:

```json
{
  "docsContain": [
    "deprecated alias",
    "encrypted-required",
    "plaintext-unsafe",
    "async"
  ],
  "runtimeAliasConsistent": true
}
```

- Negative variant(s):

```json
{
  "invalidAliasState": {
    "connectionCleanup": {
      "deleted": false
    },
    "connectionDeleted": true
  },
  "expectedResult": "test failure"
}
```
