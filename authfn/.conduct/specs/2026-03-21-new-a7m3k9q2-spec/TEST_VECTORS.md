# AuthFn Test Vectors

## TV-AF-001

- Description: Core package composition returns deterministic schema and route output for a config using password, OTP, social, 2FA, API key, and multi-region plugins.
- Input:

```json
{
  "config": {
    "namespace": "authfn",
    "plugins": [
      "password",
      "emailOtp",
      "socialOAuth",
      "apiKey",
      "twoFactor",
      "multiRegion"
    ]
  }
}
```

- Expected output:

```json
{
  "ok": true,
  "data": {
    "tables": [
      "users",
      "sessions",
      "password_credentials",
      "otp_challenges",
      "oauth_accounts",
      "api_keys",
      "two_factor_enrollments",
      "two_factor_recovery_codes",
      "region_profiles"
    ],
    "routesIncluded": true
  }
}
```

- Negative variant(s):
  - Duplicate plugin schema field collision returns `AUTHFN_CONFLICT`.

## TV-AF-002

- Description: Password sign-up followed by current-session fetch issues cookies and returns the canonical envelope.
- Input:

```json
{
  "request": {
    "method": "POST",
    "path": "/auth/sign-up/password",
    "body": {
      "email": "ada@example.com",
      "password": "Sup3rSecurePassphrase!"
    }
  }
}
```

- Expected output:

```json
{
  "status": 200,
  "cookies": [
    "__Secure-authfn.session",
    "authfn.csrf"
  ],
  "body": {
    "ok": true,
    "data": {
      "session": {
        "type": "session",
        "actorType": "user",
        "primaryEmail": "ada@example.com",
        "methods": [
          "password"
        ]
      }
    }
  }
}
```

- Negative variant(s):
  - Weak or policy-rejected password returns `AUTHFN_VALIDATION_ERROR`.

## TV-AF-003

- Description: Password sign-in rejects wrong credentials with no session cookie issuance.
- Input:

```json
{
  "request": {
    "method": "POST",
    "path": "/auth/sign-in/password",
    "body": {
      "email": "ada@example.com",
      "password": "wrong-password"
    }
  }
}
```

- Expected output:

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

- Negative variant(s):
  - Missing email field returns `AUTHFN_VALIDATION_ERROR`.

## TV-AF-004

- Description: Email verification OTP send and verify succeeds exactly once.
- Input:

```json
{
  "send": {
    "method": "POST",
    "path": "/auth/otp/send",
    "body": {
      "purpose": "verify-email",
      "email": "ada@example.com"
    }
  },
  "verify": {
    "method": "POST",
    "path": "/auth/otp/verify",
    "body": {
      "purpose": "verify-email",
      "email": "ada@example.com",
      "code": "731942"
    }
  }
}
```

- Expected output:

```json
{
  "sendStatus": 200,
  "verifyStatus": 200,
  "verifyBody": {
    "ok": true,
    "data": {
      "verified": true
    }
  }
}
```

- Negative variant(s):
  - Reusing the same code returns `AUTHFN_OTP_REPLAYED`.
  - Expired code returns `AUTHFN_OTP_EXPIRED`.

## TV-AF-005

- Description: Password reset OTP flow updates the stored password after challenge verification.
- Input:

```json
{
  "start": {
    "method": "POST",
    "path": "/auth/password/reset/start",
    "body": {
      "email": "ada@example.com"
    }
  },
  "complete": {
    "method": "POST",
    "path": "/auth/password/reset/complete",
    "body": {
      "email": "ada@example.com",
      "code": "945183",
      "newPassword": "An0therSecurePassphrase!"
    }
  }
}
```

- Expected output:

```json
{
  "completeStatus": 200,
  "body": {
    "ok": true,
    "data": {
      "passwordUpdated": true
    }
  }
}
```

- Negative variant(s):
  - Using a `verify-email` code for reset returns `AUTHFN_OTP_INVALID`.

## TV-AF-006

- Description: Google social sign-in start and callback complete issue a session and link a provider account.
- Input:

```json
{
  "start": {
    "method": "POST",
    "path": "/auth/social/start",
    "body": {
      "provider": "google",
      "returnTo": "https://app.example.com/post-auth"
    }
  },
  "callback": {
    "method": "GET",
    "path": "/auth/social/callback/google?code=abc123&state=st_google_01"
  }
}
```

- Expected output:

```json
{
  "startStatus": 200,
  "callbackStatus": 303,
  "cookies": [
    "__Secure-authfn.session",
    "authfn.csrf"
  ],
  "redirect": "https://app.example.com/post-auth"
}
```

- Negative variant(s):
  - Replayed OAuth state returns `AUTHFN_OAUTH_STATE_REPLAYED`.
  - Disallowed `returnTo` returns `AUTHFN_REDIRECT_URI_DISALLOWED`.

## TV-AF-007

- Description: Apple sign-in accepts provider runtime credentials from the shared OAuth layer and links the local account.
- Input:

```json
{
  "provider": "apple",
  "callback": {
    "method": "GET",
    "path": "/auth/social/callback/apple?code=apple_code&state=st_apple_01"
  }
}
```

- Expected output:

```json
{
  "status": 303,
  "body": null
}
```

- Negative variant(s):
  - Missing required Apple callback claims returns `AUTHFN_OAUTH_CALLBACK_INVALID`.

## TV-AF-008

- Description: GitHub social sign-in links to an existing verified local user by email when configured to do so.
- Input:

```json
{
  "provider": "github",
  "existingUserEmail": "ada@example.com"
}
```

- Expected output:

```json
{
  "status": 200,
  "body": {
    "ok": true,
    "data": {
      "linked": true,
      "provider": "github"
    }
  }
}
```

- Negative variant(s):
  - Token exchange failure returns `AUTHFN_INTERNAL_ERROR` or a provider-mapped auth error with no secret leakage.

## TV-AF-009

- Description: API key create, list, and revoke remain available inside the broader auth platform.
- Input:

```json
{
  "create": {
    "method": "POST",
    "path": "/auth/api-keys",
    "body": {
      "name": "server-to-server",
      "scopes": [
        "read"
      ]
    }
  },
  "revoke": {
    "method": "DELETE",
    "path": "/auth/api-keys/key_01"
  }
}
```

- Expected output:

```json
{
  "createStatus": 201,
  "createBody": {
    "ok": true,
    "data": {
      "keyId": "key_01",
      "secretReturnedOnce": true
    }
  },
  "revokeStatus": 200
}
```

- Negative variant(s):
  - Authenticating with the revoked key returns `AUTHFN_API_KEY_REVOKED`.

## TV-AF-010

- Description: 2FA enrollment, confirmation, challenge, and recovery code flows behave as a plugin-layered second factor.
- Input:

```json
{
  "enroll": {
    "method": "POST",
    "path": "/auth/2fa/enroll"
  },
  "confirm": {
    "method": "POST",
    "path": "/auth/2fa/confirm",
    "body": {
      "challengeId": "tfa_01",
      "code": "123456"
    }
  },
  "challenge": {
    "method": "POST",
    "path": "/auth/2fa/challenge",
    "body": {
      "challengeId": "signin_2fa_01",
      "code": "123456"
    }
  }
}
```

- Expected output:

```json
{
  "confirmStatus": 200,
  "challengeStatus": 200,
  "body": {
    "ok": true,
    "data": {
      "twoFactorSatisfied": true
    }
  }
}
```

- Negative variant(s):
  - Invalid TOTP returns `AUTHFN_2FA_INVALID_CODE`.
  - Reused recovery code returns `AUTHFN_2FA_INVALID_CODE`.

## TV-AF-011

- Description: Multi-region lookup and region mismatch handling return deterministic routing guidance.
- Input:

```json
{
  "lookup": {
    "method": "POST",
    "path": "/auth/regions/lookup",
    "body": {
      "identifier": "ada@example.com"
    }
  },
  "mismatchSignIn": {
    "method": "POST",
    "path": "/auth/sign-in/password",
    "host": "us.account.example.com",
    "body": {
      "email": "ada@example.com",
      "password": "Sup3rSecurePassphrase!"
    }
  }
}
```

- Expected output:

```json
{
  "lookupStatus": 200,
  "lookupBody": {
    "ok": true,
    "data": {
      "regionId": "eu-west-1",
      "authority": "https://eu.account.example.com"
    }
  },
  "mismatchStatus": 409,
  "mismatchBody": {
    "ok": false,
    "error": {
      "code": "AUTHFN_REGION_MISMATCH",
      "details": {
        "redirectTo": "https://eu.account.example.com"
      }
    }
  }
}
```

- Negative variant(s):
  - Unknown identifier/unknown region authority returns `AUTHFN_REGION_NOT_FOUND`.

## TV-AF-012

- Description: Plugin hooks run deterministically; a failing `before*` hook aborts, while a failing `after*` hook does not roll back committed state.
- Input:

```json
{
  "plugins": [
    "multiRegion",
    "customAudit"
  ],
  "hookFailure": {
    "plugin": "customAudit",
    "hook": "beforeUserCreate"
  }
}
```

- Expected output:

```json
{
  "status": 500,
  "body": {
    "ok": false,
    "error": {
      "code": "AUTHFN_PLUGIN_ABORTED"
    }
  }
}
```

- Negative variant(s):
  - `afterUserCreate` failure still leaves the user committed and returns success for the main operation.

## TV-AF-013

- Description: Browser client and Svelte adapter fetch current session and enforce CSRF on sign-out.
- Input:

```json
{
  "clientCall": "getSession",
  "signOut": {
    "method": "POST",
    "path": "/auth/sign-out",
    "headers": {
      "x-authfn-csrf": "csrf_01"
    }
  }
}
```

- Expected output:

```json
{
  "getSession": {
    "ok": true
  },
  "signOutStatus": 200
}
```

- Negative variant(s):
  - Missing or mismatched CSRF token returns `AUTHFN_CSRF_INVALID`.

## TV-AF-014

- Description: Python route surface and schema output match TypeScript semantics.
- Input:

```json
{
  "runtime": "python",
  "plugins": [
    "password",
    "emailOtp",
    "socialOAuth",
    "apiKey",
    "twoFactor",
    "multiRegion"
  ]
}
```

- Expected output:

```json
{
  "routesMatch": true,
  "errorCodesMatch": true,
  "schemaTablesMatch": true
}
```

- Negative variant(s):
  - Missing provider runtime configuration for social auth returns `AUTHFN_VALIDATION_ERROR`.

## TV-AF-015

- Description: OpenAPI generation succeeds from authfn route metadata.
- Input:

```json
{
  "openApi": true
}
```

- Expected output:

```json
{
  "ok": true,
  "data": {
    "paths": [
      "/auth/session",
      "/auth/sign-up/password",
      "/auth/sign-in/password",
      "/auth/otp/send",
      "/auth/social/start"
    ]
  }
}
```

- Negative variant(s):
  - Missing required route metadata fails generation with `AUTHFN_INTERNAL_ERROR` during verification builds.

## TV-AF-016

- Description: Session listing and revocation are consistent across multiple active sessions.
- Input:

```json
{
  "sessions": [
    "sess_a",
    "sess_b"
  ],
  "revoke": "sess_b"
}
```

- Expected output:

```json
{
  "listBefore": [
    "sess_a",
    "sess_b"
  ],
  "listAfter": [
    "sess_a"
  ]
}
```

- Negative variant(s):
  - Revoked session cookie subsequently returns `AUTHFN_SESSION_REVOKED`.
