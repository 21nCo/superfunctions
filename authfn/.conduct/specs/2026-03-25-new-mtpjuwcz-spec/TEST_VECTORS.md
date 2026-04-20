# Test Vectors

## TV-EXAUTH-001

- Description: Workspace discovery finds the full authfn example portfolio and shared package.
- Input:

```json
{
  "paths": [
    "authfn/examples/shared/package.json",
    "authfn/examples/password-sessions/package.json",
    "authfn/examples/otp-recovery/package.json",
    "authfn/examples/social-oauth/package.json",
    "authfn/examples/account-settings/package.json",
    "authfn/examples/multi-region-routing/package.json"
  ],
  "rootWorkspaceEntries": [
    "authfn/examples/*",
    "authfn/examples/*/*"
  ]
}
```

- Expected output:

```json
{
  "ok": true,
  "data": {
    "workspaceEntriesPresent": true,
    "exampleRootCount": 5,
    "sharedPackagePresent": true
  }
}
```

- Negative variant(s):
  - Missing `authfn/examples/*/*` workspace entry yields `AUTHFN_EXAMPLE_UI_CONTRACT_MISSING`-style validation failure with message `Nested example packages are not reachable from npm workspaces`.
  - A single `authfn/examples/all-in-one` package with no focused roots fails the portfolio structure check.

## TV-EXAUTH-002

- Description: Shared demo harness reset succeeds and produces an empty deterministic baseline.
- Input:

```json
{
  "request": {
    "method": "POST",
    "path": "/demo/reset",
    "body": {
      "scenario": "baseline"
    }
  }
}
```

- Expected output:

```json
{
  "status": 200,
  "body": {
    "ok": true,
    "data": {
      "scenario": "baseline",
      "seeded": true
    },
    "requestId": "<non-empty-string>"
  }
}
```

- Negative variant(s):
  - Unknown scenario returns:

```json
{
  "status": 400,
  "body": {
    "ok": false,
    "error": {
      "code": "AUTHFN_EXAMPLE_SCENARIO_UNKNOWN",
      "message": "Unknown example seed scenario",
      "retryable": false
    },
    "requestId": "<non-empty-string>"
  }
}
```

## TV-EXAUTH-003

- Description: Example server schema generation produces the Drizzle auth schema file from authfn source configuration.
- Input:

```json
{
  "cwd": "authfn/examples/password-sessions/server",
  "command": "npm run db:generate"
}
```

- Expected output:

```json
{
  "ok": true,
  "data": {
    "generatedFile": "src/db/generated/authfn-schema.ts",
    "tables": [
      "users",
      "sessions",
      "password_credentials"
    ]
  }
}
```

- Negative variant(s):
  - If the generated file is absent after the command, verification fails with message `Generated authfn schema file missing`.

## TV-EXAUTH-004

- Description: CLI plus authfn bundled-plugin descriptor resolution handles a plugin-rich auth config.
- Input:

```json
{
  "configSource": "createAuthFn({ namespace: 'authfn_pw_demo', plugins: [authFnPasswordPlugin(), authFnApiKeyPlugin({ secretPrefix: 'demo' })] })",
  "command": "superfunctions generate-schema --config ./superfunctions.config.ts --library authfn --adapter drizzle --output ./src/db/generated --force"
}
```

- Expected output:

```json
{
  "ok": true,
  "data": {
    "resolvedFactories": [
      "authFnPasswordPlugin",
      "authFnApiKeyPlugin"
    ],
    "tables": [
      "users",
      "sessions",
      "password_credentials",
      "api_keys"
    ]
  }
}
```

- Negative variant(s):
  - Unknown plugin descriptor returns:

```json
{
  "status": 400,
  "body": {
    "ok": false,
    "error": {
      "code": "AUTHFN_CONFIG_INVALID",
      "message": "Unsupported authfn schema plugin descriptor",
      "retryable": false,
      "details": {
        "factoryName": "customPlugin"
      }
    }
  }
}
```

## TV-EXAUTH-005

- Description: Password and session example covers sign-up, sign-in, list sessions, revoke session, and sign-out.
- Input:

```json
{
  "steps": [
    "POST /auth/sign-up/password { email: 'ada@example.com', password: 'Sup3rSecurePassphrase!' }",
    "GET /auth/session",
    "GET /auth/sessions",
    "POST /auth/sessions/:sessionId/revoke",
    "POST /auth/sign-out"
  ]
}
```

- Expected output:

```json
{
  "status": "pass",
  "assertions": {
    "sessionIssued": true,
    "sessionListed": true,
    "sessionRevoked": true,
    "signedOut": true
  }
}
```

- Negative variant(s):
  - Wrong password sign-in returns:

```json
{
  "status": 401,
  "body": {
    "ok": false,
    "error": {
      "code": "AUTHFN_INVALID_CREDENTIALS",
      "message": "Invalid email or password",
      "retryable": false
    }
  }
}
```

## TV-EXAUTH-006

- Description: OTP and recovery example covers verify-email OTP, OTP sign-in, and password reset.
- Input:

```json
{
  "steps": [
    "POST /auth/otp/send { purpose: 'verify-email', email: 'ada@example.com' }",
    "GET /demo/otp/latest?purpose=verify-email&email=ada@example.com",
    "POST /auth/otp/verify { purpose: 'verify-email', email: 'ada@example.com', code: '731942' }",
    "POST /auth/password/reset/start { email: 'ada@example.com' }",
    "GET /demo/otp/latest?purpose=reset-password&email=ada@example.com",
    "POST /auth/password/reset/complete { email: 'ada@example.com', code: '731942', newPassword: 'An0therSecurePassphrase!' }"
  ]
}
```

- Expected output:

```json
{
  "status": "pass",
  "assertions": {
    "verifyEmailSucceeded": true,
    "otpSignInSucceeded": true,
    "passwordResetSucceeded": true
  }
}
```

- Negative variant(s):
  - Reusing the same OTP returns:

```json
{
  "status": 409,
  "body": {
    "ok": false,
    "error": {
      "code": "AUTHFN_OTP_REPLAYED",
      "message": "OTP code has already been used",
      "retryable": false
    }
  }
}
```

## TV-EXAUTH-007

- Description: Social OAuth example completes a local fake-provider browser flow and disconnects the linked account.
- Input:

```json
{
  "steps": [
    "POST /auth/social/start { provider: 'google', returnTo: 'http://127.0.0.1:4013/post-auth' }",
    "GET /demo/providers/google/authorize?...",
    "GET /auth/social/callback/google?code=demo-google-code&state=demo-google-state",
    "POST /auth/social/disconnect/google"
  ]
}
```

- Expected output:

```json
{
  "status": "pass",
  "assertions": {
    "oauthStartSucceeded": true,
    "oauthCallbackIssuedSession": true,
    "disconnectSucceeded": true
  }
}
```

- Negative variant(s):
  - Disallowed `returnTo` returns:

```json
{
  "status": 400,
  "body": {
    "ok": false,
    "error": {
      "code": "AUTHFN_REDIRECT_URI_DISALLOWED",
      "message": "Redirect target is not allowed",
      "retryable": false
    }
  }
}
```

## TV-EXAUTH-008

- Description: Account settings example demonstrates 2FA and API-key lifecycle end to end.
- Input:

```json
{
  "steps": [
    "POST /auth/2fa/enroll",
    "POST /auth/2fa/confirm { code: '<valid-demo-totp>' }",
    "POST /auth/sign-out",
    "POST /auth/sign-in/password { email: 'ada@example.com', password: 'Sup3rSecurePassphrase!' }",
    "POST /auth/2fa/challenge { challengeId: '<pending-id>', code: '<valid-demo-totp>' }",
    "POST /auth/api-keys { name: 'playwright', scopes: ['read'] }",
    "GET /auth/api-keys",
    "DELETE /auth/api-keys/:keyId"
  ]
}
```

- Expected output:

```json
{
  "status": "pass",
  "assertions": {
    "twoFactorEnabled": true,
    "twoFactorChallengeSatisfied": true,
    "apiKeyCreated": true,
    "apiKeyRevoked": true
  }
}
```

- Negative variant(s):
  - Invalid 2FA code returns:

```json
{
  "status": 400,
  "body": {
    "ok": false,
    "error": {
      "code": "AUTHFN_2FA_INVALID_CODE",
      "message": "Two-factor authentication code is invalid",
      "retryable": false
    }
  }
}
```

  - Using the revoked API key on a protected example endpoint returns:

```json
{
  "status": 401,
  "body": {
    "ok": false,
    "error": {
      "code": "AUTHFN_API_KEY_REVOKED",
      "message": "API key has been revoked",
      "retryable": false
    }
  }
}
```

## TV-EXAUTH-009

- Description: Multi-region example shows lookup and wrong-authority correction across two local authorities.
- Input:

```json
{
  "steps": [
    "POST http://127.0.0.1:3015/auth/regions/lookup { identifier: 'ada@example.com' }",
    "POST http://127.0.0.1:3015/auth/sign-in/password { email: 'ada@example.com', password: 'Sup3rSecurePassphrase!' }",
    "POST http://127.0.0.1:3016/auth/sign-in/password { email: 'ada@example.com', password: 'Sup3rSecurePassphrase!' }"
  ]
}
```

- Expected output:

```json
{
  "status": "pass",
  "assertions": {
    "lookupReturnedAuthority": "http://127.0.0.1:3016",
    "wrongAuthorityRejected": true,
    "correctAuthoritySucceeded": true
  }
}
```

- Negative variant(s):
  - Wrong-authority sign-in returns:

```json
{
  "status": 409,
  "body": {
    "ok": false,
    "error": {
      "code": "AUTHFN_REGION_MISMATCH",
      "message": "Request must continue on a different region authority",
      "retryable": false,
      "details": {
        "redirectTo": "http://127.0.0.1:3016"
      }
    }
  }
}
```

## TV-EXAUTH-010

- Description: Expanded browser client methods cover account-settings and region-routing use cases.
- Input:

```json
{
  "clientCalls": [
    "client.createApiKey({ name: 'cli-generated' })",
    "client.listApiKeys()",
    "client.completeTwoFactorChallenge({ challengeId: 'challenge_1', code: '123456' })",
    "client.lookupRegion({ identifier: 'ada@example.com' })",
    "client.getRuntime()"
  ]
}
```

- Expected output:

```json
{
  "status": "pass",
  "assertions": {
    "methodsExist": true,
    "typedEnvelopesReturned": true
  }
}
```

- Negative variant(s):
  - `client.disableTwoFactor({ code: 'wrong' })` returns `AUTHFN_2FA_INVALID_CODE`.

## TV-EXAUTH-011

- Description: Stable UI selector and demo-route contract exists for Playwright.
- Input:

```json
{
  "selectors": [
    "example-title",
    "auth-state-panel",
    "event-log-panel",
    "sign-up-form",
    "otp-inbox-panel",
    "social-google-button",
    "two-factor-enroll-button",
    "region-lookup-form"
  ]
}
```

- Expected output:

```json
{
  "status": "pass",
  "assertions": {
    "allSelectorsPresent": true,
    "demoRoutesReachable": true
  }
}
```

- Negative variant(s):
  - Missing documented selector fails deterministic UI-contract verification with `AUTHFN_EXAMPLE_UI_CONTRACT_MISSING`.

## TV-EXAUTH-012

- Description: Portfolio and per-example documentation commands match the actual scripts.
- Input:

```json
{
  "docs": [
    "authfn/examples/README.md",
    "authfn/examples/password-sessions/README.md",
    "authfn/examples/otp-recovery/README.md",
    "authfn/examples/social-oauth/README.md",
    "authfn/examples/account-settings/README.md",
    "authfn/examples/multi-region-routing/README.md"
  ],
  "requiredScripts": [
    "dev:server",
    "dev:client",
    "db:generate",
    "db:push",
    "test:e2e"
  ]
}
```

- Expected output:

```json
{
  "status": "pass",
  "assertions": {
    "portfolioReadmePresent": true,
    "allExamplesDocumented": true,
    "documentedScriptsExist": true
  }
}
```

- Negative variant(s):
  - A README command that does not exist in the referenced package scripts fails documentation verification with message `README command matrix is stale`.

## TV-EXAUTH-013

- Description: Deterministic verification succeeds without live external network dependencies.
- Input:

```json
{
  "command": "npm run test:e2e",
  "networkPolicy": "deny outbound requests except localhost"
}
```

- Expected output:

```json
{
  "status": "pass",
  "assertions": {
    "allProvidersWereLocal": true,
    "allTestsPassed": true
  }
}
```

- Negative variant(s):
  - Any request to a non-local OAuth/email host fails with:

```json
{
  "status": 500,
  "body": {
    "ok": false,
    "error": {
      "code": "AUTHFN_EXAMPLE_EXTERNAL_NETWORK_FORBIDDEN",
      "message": "External network access is forbidden for authfn example verification",
      "retryable": false
    }
  }
}
```
