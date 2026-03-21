# Shared Packages Test Vectors

## TV-PKG-001

- Description: Shared auth abstractions represent user/API-key/service actors in TypeScript and Python with matching semantics.
- Input:

```json
{
  "session": {
    "id": "sess_01",
    "type": "session",
    "subject": {
      "actorId": "user_01",
      "actorType": "user",
      "regionId": "eu-west-1"
    },
    "methods": [
      "password"
    ]
  }
}
```

- Expected output:

```json
{
  "typescriptValid": true,
  "pythonValid": true
}
```

- Negative variant(s):
  - Missing `actorType` fails validation with `AUTH_VALIDATION_ERROR`.

## TV-PKG-002

- Description: Shared HTTP cookie helpers and Python response cookies preserve two cookies deterministically.
- Input:

```json
{
  "cookies": [
    {
      "name": "__Secure-authfn.session",
      "value": "opaque_1"
    },
    {
      "name": "authfn.csrf",
      "value": "csrf_1"
    }
  ]
}
```

- Expected output:

```json
{
  "setCookieHeaders": [
    "__Secure-authfn.session=opaque_1; Path=/; Secure; HttpOnly; SameSite=Lax",
    "authfn.csrf=csrf_1; Path=/; Secure; SameSite=Lax"
  ]
}
```

- Negative variant(s):
  - Invalid SameSite value fails with `HTTP_META_INVALID`.

## TV-PKG-003

- Description: `oauth-core` validates a browser-auth intent and redirect allowlist before authorization request creation.
- Input:

```json
{
  "intent": {
    "kind": "browser-auth",
    "intentId": "intent_01",
    "returnTo": "https://app.example.com/post-auth"
  },
  "provider": "google"
}
```

- Expected output:

```json
{
  "ok": true,
  "authorizationUrlCreated": true
}
```

- Negative variant(s):
  - Disallowed redirect returns `OAUTH_REDIRECT_DISALLOWED`.

## TV-PKG-004

- Description: `oauth-flow` completes a browser-auth callback with structured events and hook wrapping.
- Input:

```json
{
  "start": {
    "subject": {
      "kind": "browser-auth",
      "intentId": "intent_01"
    },
    "providerId": "google"
  },
  "callback": {
    "state": "st_01",
    "code": "code_01"
  }
}
```

- Expected output:

```json
{
  "startEvent": "oauth.flow.started",
  "callbackEvent": "oauth.flow.callback.success",
  "result": {
    "providerId": "google"
  }
}
```

- Negative variant(s):
  - Hook failure returns `OAUTH_HOOK_FAILED`.
  - Replayed state returns `OAUTH_STATE_REPLAYED`.

## TV-PKG-005

- Description: `oauth-storage` persists and consumes state/token/consent records with deterministic schemas.
- Input:

```json
{
  "stores": [
    "oauth_states",
    "oauth_tokens",
    "oauth_consents",
    "oauth_revocation_failures"
  ]
}
```

- Expected output:

```json
{
  "schemaTablesExist": true,
  "stateSingleUse": true
}
```

- Negative variant(s):
  - Consuming the same state twice returns `OAUTH_STATE_REPLAYED`.

## TV-PKG-006

- Description: `oauth-router` creates reusable browser-auth routes on top of `@superfunctions/http`.
- Input:

```json
{
  "mode": "browser-auth",
  "basePath": "/auth/social"
}
```

- Expected output:

```json
{
  "routes": [
    "/auth/social/start",
    "/auth/social/callback/:provider",
    "/auth/social/disconnect/:provider"
  ]
}
```

- Negative variant(s):
  - Missing provider resolver config returns `OAUTH_RUNTIME_CONFIG_INVALID`.

## TV-PKG-007

- Description: Shared provider/runtime layers support Google, Apple, and GitHub with Apple secret resolution.
- Input:

```json
{
  "providers": [
    "google",
    "apple",
    "github"
  ],
  "appleSecretResolver": "runtime"
}
```

- Expected output:

```json
{
  "providersLoaded": true,
  "appleSecretResolved": true
}
```

- Negative variant(s):
  - Secret resolution failure returns `OAUTH_SECRET_RESOLUTION_FAILED`.

## TV-PKG-008

- Description: `http-openapi` generates a deterministic document from route metadata.
- Input:

```json
{
  "routes": [
    {
      "path": "/auth/session",
      "meta": {
        "openapi": {
          "operationId": "getSession"
        }
      }
    }
  ]
}
```

- Expected output:

```json
{
  "paths": {
    "/auth/session": {
      "get": {
        "operationId": "getSession"
      }
    }
  }
}
```

- Negative variant(s):
  - A route explicitly marked for inclusion but lacking `operationId` fails with `OPENAPI_META_INCOMPLETE`.

## TV-PKG-009

- Description: `@superfunctions/cli` discovers `@authfn/core` and generates plugin-composed schema output.
- Input:

```json
{
  "library": "@authfn/core",
  "plugins": [
    "password",
    "emailOtp",
    "socialOAuth"
  ]
}
```

- Expected output:

```json
{
  "schemaGenerated": true,
  "tables": [
    "users",
    "sessions",
    "password_credentials",
    "otp_challenges",
    "oauth_accounts"
  ]
}
```

- Negative variant(s):
  - Missing `getSchema` export fails generation with a structured CLI error.

## TV-PKG-010

- Description: Python shared HTTP/OpenAPI support preserves repeated cookies and route metadata through FastAPI/Flask adapters.
- Input:

```json
{
  "frameworks": [
    "fastapi",
    "flask"
  ],
  "cookies": [
    "__Secure-authfn.session",
    "authfn.csrf"
  ]
}
```

- Expected output:

```json
{
  "fastapiSetCookieCount": 2,
  "flaskSetCookieCount": 2,
  "openapiGenerated": true
}
```

- Negative variant(s):
  - If cookies collapse into one header, the adapter test fails with `HTTP_META_INVALID`.

## TV-PKG-011

- Description: Shared flow/router observability stays redaction-safe.
- Input:

```json
{
  "event": "oauth.flow.callback.success"
}
```

- Expected output:

```json
{
  "containsSecrets": false
}
```

- Negative variant(s):
  - Snapshot containing access token or client secret fails verification.

## TV-PKG-012

- Description: `authfn` can consume the shared packages end to end without bespoke OAuth/router/openapi implementations.
- Input:

```json
{
  "consumer": "@authfn/core"
}
```

- Expected output:

```json
{
  "buildsAgainstSharedPackages": true,
  "noCustomOauthRouterRequired": true,
  "noCustomOpenApiGeneratorRequired": true
}
```

- Negative variant(s):
  - Missing shared package dependency blocks the integration smoke test.
