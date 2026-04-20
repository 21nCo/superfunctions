# Test Vectors

## TV-PKG-001-P

- Description: TypeScript package metadata and README align on the public package name `sendfn`.
- Input:
  ```json
  {
    "packageJson": { "name": "sendfn" },
    "readmeInstall": "npm install sendfn @superfunctions/db @superfunctions/http",
    "readmeImport": "import { sendfn } from 'sendfn';"
  }
  ```
- Expected output:
  ```json
  { "valid": true, "errors": [] }
  ```
- Negative variant(s): N/A

## TV-PKG-001-N

- Description: TypeScript packaging gate rejects mismatched published package name vs README import.
- Input:
  ```json
  {
    "packageJson": { "name": "@sendfn/core" },
    "readmeImport": "import { sendfn } from 'sendfn';"
  }
  ```
- Expected output:
  ```json
  {
    "valid": false,
    "error": {
      "code": "SENDFN_MANIFEST_MISMATCH",
      "message": "TypeScript package name and shipped import instructions do not match"
    }
  }
  ```
- Negative variant(s): N/A

## TV-PKG-002-P

- Description: Python base import succeeds without optional FastAPI extras.
- Input:
  ```json
  {
    "command": "python3 -c \"import sendfn; print('ok')\"",
    "installedExtras": []
  }
  ```
- Expected output:
  ```json
  { "exitCode": 0, "stdoutPattern": "ok" }
  ```
- Negative variant(s): N/A

## TV-PKG-002-N

- Description: Importing an optional integration without its extra returns an explicit optional-dependency error.
- Input:
  ```json
  {
    "command": "python3 -c \"from sendfn.http.fastapi import create_sendfn_router\"",
    "installedExtras": []
  }
  ```
- Expected output:
  ```json
  {
    "exitCode": 1,
    "error": {
      "code": "SENDFN_OPTIONAL_DEPENDENCY_MISSING",
      "message": "FastAPI integration requires the `fastapi` extra"
    }
  }
  ```
- Negative variant(s): N/A

## TV-API-001-P

- Description: Both SDKs expose the same supported public lifecycle surface, including `close()`.
- Input:
  ```json
  {
    "typescriptMethods": ["email", "bulkEmail", "sms", "push", "bulkPush", "registerDevice", "getDevices", "deactivateDevice", "refreshDeviceToken", "cleanupInactiveDevices", "registerTemplate", "getTemplate", "listTemplates", "getEmailEvents", "getPushEvents", "getSmsEvents", "queryEvents", "checkSuppressionList", "addToSuppressionList", "bulkAddToSuppressionList", "exportSuppressionList", "removeFromSuppressionList", "getWebhookHandlers", "close"],
    "pythonMethods": ["send_email", "send_bulk_email", "send_sms", "send_push", "send_bulk_push", "register_device", "get_devices", "deactivate_device", "refresh_device_token", "cleanup_inactive_devices", "register_template", "get_template", "list_templates", "get_email_events", "get_push_events", "get_sms_events", "query_events", "check_suppression_list", "add_to_suppression_list", "bulk_add_to_suppression_list", "export_suppression_list", "remove_from_suppression_list", "get_webhook_handlers", "close"]
  }
  ```
- Expected output:
  ```json
  { "equivalent": true }
  ```
- Negative variant(s): N/A

## TV-API-001-N

- Description: Public parity check fails when one SDK omits `close()`.
- Input:
  ```json
  {
    "typescriptMethods": ["email", "close"],
    "pythonMethods": ["send_email"]
  }
  ```
- Expected output:
  ```json
  {
    "equivalent": false,
    "error": {
      "code": "SENDFN_PUBLIC_API_DRIFT",
      "message": "Python SDK is missing required lifecycle method `close`"
    }
  }
  ```
- Negative variant(s): N/A

## TV-API-002-P

- Description: Admin API success response uses the canonical success envelope.
- Input:
  ```json
  {
    "request": {
      "method": "POST",
      "path": "/email",
      "headers": { "authorization": "Bearer secret" },
      "body": {
        "userId": "user-123",
        "to": "user@example.com",
        "subject": "Hello",
        "html": "<p>Hello</p>"
      }
    }
  }
  ```
- Expected output:
  ```json
  {
    "status": 201,
    "body": {
      "ok": true,
      "data": { "status": "sent" },
      "error": null,
      "meta": { "requestId": "req_*", "version": "v0" }
    }
  }
  ```
- Negative variant(s): N/A

## TV-API-002-N

- Description: Admin API invalid payload returns canonical validation error envelope.
- Input:
  ```json
  {
    "request": {
      "method": "POST",
      "path": "/email",
      "headers": { "authorization": "Bearer secret" },
      "body": {
        "userId": "user-123",
        "to": [],
        "subject": "",
        "html": ""
      }
    }
  }
  ```
- Expected output:
  ```json
  {
    "status": 400,
    "body": {
      "ok": false,
      "data": null,
      "error": {
        "code": "SENDFN_VALIDATION_ERROR",
        "message": "Request body failed validation",
        "retryable": false
      }
    }
  }
  ```
- Negative variant(s): N/A

## TV-EMAIL-001-P

- Description: Template engine renders variables, `#if`, and `#each` deterministically with escaping.
- Input:
  ```json
  {
    "template": "<ul>{{#each items}}<li>{{name}}</li>{{/each}}</ul>{{#if cta}}<a href=\"{{cta}}\">Go</a>{{/if}}",
    "data": {
      "items": [{ "name": "<Alice>" }, { "name": "Bob" }],
      "cta": "https://example.com"
    }
  }
  ```
- Expected output:
  ```json
  {
    "rendered": "<ul><li>&lt;Alice&gt;</li><li>Bob</li></ul><a href=\"https://example.com\">Go</a>"
  }
  ```
- Negative variant(s): N/A

## TV-EMAIL-001-N

- Description: Template engine rejects unsupported or malformed block syntax instead of silently producing incorrect output.
- Input:
  ```json
  {
    "template": "{{#if missing}}A{{/each}}",
    "data": {}
  }
  ```
- Expected output:
  ```json
  {
    "error": {
      "code": "SENDFN_TEMPLATE_RENDER_ERROR",
      "message": "Malformed template block syntax"
    }
  }
  ```
- Negative variant(s): N/A

## TV-EMAIL-002-P

- Description: Email send short-circuits on suppression before calling the provider.
- Input:
  ```json
  {
    "suppressionList": ["user@example.com"],
    "send": {
      "userId": "user-123",
      "to": "user@example.com",
      "subject": "Hello",
      "html": "<p>Hello</p>"
    }
  }
  ```
- Expected output:
  ```json
  {
    "providerCalls": 0,
    "error": {
      "code": "SENDFN_SUPPRESSED",
      "message": "Recipient is suppressed"
    }
  }
  ```
- Negative variant(s): N/A

## TV-EMAIL-002-N

- Description: Missing template and empty raw content fail validation.
- Input:
  ```json
  {
    "send": {
      "userId": "user-123",
      "to": "user@example.com",
      "templateId": "missing-template"
    }
  }
  ```
- Expected output:
  ```json
  {
    "error": {
      "code": "SENDFN_TEMPLATE_NOT_FOUND",
      "message": "Template `missing-template` was not found"
    }
  }
  ```
- Negative variant(s): N/A

## TV-EMAIL-003-P

- Description: Retryable SES failure retries up to the configured bound and then succeeds.
- Input:
  ```json
  {
    "retryAttempts": 3,
    "providerResponses": [
      { "success": false, "error": { "code": "Throttling", "retryable": true } },
      { "success": false, "error": { "code": "Throttling", "retryable": true } },
      { "success": true, "providerMessageId": "ses-123" }
    ]
  }
  ```
- Expected output:
  ```json
  {
    "attemptCount": 3,
    "finalStatus": "sent",
    "providerMessageId": "ses-123"
  }
  ```
- Negative variant(s): N/A

## TV-EMAIL-003-N

- Description: Oversized recipient or attachment set fails before any provider network call.
- Input:
  ```json
  {
    "send": {
      "toCount": 51,
      "attachmentsTotalBytes": 11534336
    }
  }
  ```
- Expected output:
  ```json
  {
    "providerCalls": 0,
    "error": {
      "code": "SENDFN_PROVIDER_LIMIT",
      "message": "Email request exceeds provider limits"
    }
  }
  ```
- Negative variant(s): N/A

## TV-DB-001-P

- Description: Query layer retrieves a transaction by provider message ID and filters events by window/provider/user.
- Input:
  ```json
  {
    "transactions": [{ "id": "tx-1", "providerMessageId": "ses-123", "userId": "user-123" }],
    "eventsQuery": {
      "providerMessageId": "ses-123",
      "provider": "aws-ses",
      "userId": "user-123",
      "startAt": "2026-04-01T00:00:00Z",
      "endAt": "2026-04-03T00:00:00Z"
    }
  }
  ```
- Expected output:
  ```json
  {
    "emailTransaction": { "id": "tx-1" },
    "events": [{ "referenceId": "tx-1" }]
  }
  ```
- Negative variant(s): N/A

## TV-DB-001-N

- Description: Query layer rejects an invalid time window.
- Input:
  ```json
  {
    "eventsQuery": {
      "startAt": "2026-04-03T00:00:00Z",
      "endAt": "2026-04-01T00:00:00Z"
    }
  }
  ```
- Expected output:
  ```json
  {
    "error": {
      "code": "SENDFN_VALIDATION_ERROR",
      "message": "`startAt` must be earlier than `endAt`"
    }
  }
  ```
- Negative variant(s): N/A

## TV-WEBHOOK-001-P

- Description: Valid SNS envelope is accepted and verified before event processing.
- Input:
  ```json
  {
    "snsEnvelope": {
      "Type": "Notification",
      "MessageId": "sns-1",
      "Timestamp": "2026-04-02T00:00:00Z",
      "SignatureVersion": "1",
      "Signature": "valid",
      "SigningCertURL": "https://sns.us-east-1.amazonaws.com/cert.pem",
      "Message": "{\"notificationType\":\"Delivery\",\"mail\":{\"messageId\":\"ses-123\",\"timestamp\":\"2026-04-02T00:00:00Z\",\"destination\":[\"user@example.com\"]},\"delivery\":{\"timestamp\":\"2026-04-02T00:00:05Z\",\"recipients\":[\"user@example.com\"],\"processingTimeMillis\":100,\"smtpResponse\":\"250 ok\"}}"
    }
  }
  ```
- Expected output:
  ```json
  {
    "status": 200,
    "body": {
      "ok": true,
      "data": { "accepted": true, "verified": true }
    }
  }
  ```
- Negative variant(s): N/A

## TV-WEBHOOK-001-N

- Description: Invalid SNS signature is rejected before any DB mutation.
- Input:
  ```json
  {
    "snsEnvelope": {
      "Type": "Notification",
      "MessageId": "sns-1",
      "Timestamp": "2026-04-02T00:00:00Z",
      "SignatureVersion": "1",
      "Signature": "invalid",
      "SigningCertURL": "https://sns.us-east-1.amazonaws.com/cert.pem",
      "Message": "{}"
    }
  }
  ```
- Expected output:
  ```json
  {
    "status": 400,
    "mutations": 0,
    "body": {
      "ok": false,
      "error": {
        "code": "SENDFN_WEBHOOK_SIGNATURE_INVALID",
        "message": "SNS signature verification failed"
      }
    }
  }
  ```
- Negative variant(s): N/A

## TV-WEBHOOK-002-P

- Description: Verified bounce event correlates to a known transaction, updates status, records a correlated event, and adds suppression.
- Input:
  ```json
  {
    "emailTransactions": [{ "id": "tx-1", "providerMessageId": "ses-123", "status": "sent", "to": "user@example.com" }],
    "snsEnvelope": {
      "Type": "Notification",
      "Signature": "valid",
      "SigningCertURL": "https://sns.us-east-1.amazonaws.com/cert.pem",
      "Message": "{\"notificationType\":\"Bounce\",\"mail\":{\"messageId\":\"ses-123\",\"timestamp\":\"2026-04-02T00:00:00Z\",\"destination\":[\"user@example.com\"]},\"bounce\":{\"bounceType\":\"Permanent\",\"bounceSubType\":\"General\",\"bouncedRecipients\":[{\"emailAddress\":\"user@example.com\",\"diagnosticCode\":\"550\"}]}}"
    }
  }
  ```
- Expected output:
  ```json
  {
    "transaction": { "id": "tx-1", "status": "bounced" },
    "event": { "referenceId": "tx-1", "eventType": "bounced" },
    "suppressionEntry": { "email": "user@example.com", "reason": "bounce" }
  }
  ```
- Negative variant(s): N/A

## TV-WEBHOOK-002-N

- Description: Verified unmatched complaint event does not fabricate `"unknown"` and is recorded as an orphan deterministically.
- Input:
  ```json
  {
    "emailTransactions": [],
    "snsEnvelope": {
      "Type": "Notification",
      "Signature": "valid",
      "SigningCertURL": "https://sns.us-east-1.amazonaws.com/cert.pem",
      "Message": "{\"notificationType\":\"Complaint\",\"mail\":{\"messageId\":\"ses-missing\",\"timestamp\":\"2026-04-02T00:00:00Z\",\"destination\":[\"user@example.com\"]},\"complaint\":{\"complainedRecipients\":[{\"emailAddress\":\"user@example.com\"}]}}"
    }
  }
  ```
- Expected output:
  ```json
  {
    "transactionMutations": 0,
    "event": {
      "referenceId": "provider:aws-ses:ses-missing",
      "metadata": { "orphaned": true }
    },
    "suppressionEntry": { "email": "user@example.com", "reason": "complaint" }
  }
  ```
- Negative variant(s): N/A

## TV-SUP-001-P

- Description: Suppression normalization, manual add, export, remove, and re-send flow work deterministically.
- Input:
  ```json
  {
    "bulkAdd": [
      { "email": " User@Example.com ", "reason": "manual", "source": "admin" }
    ],
    "remove": "user@example.com"
  }
  ```
- Expected output:
  ```json
  {
    "normalizedStoredEmail": "user@example.com",
    "exportOrder": ["user@example.com"],
    "removed": true
  }
  ```
- Negative variant(s): N/A

## TV-SUP-001-N

- Description: Duplicate suppression bulk-add uses normalization and does not create multiple rows.
- Input:
  ```json
  {
    "bulkAdd": [
      { "email": "USER@example.com", "reason": "manual", "source": "admin" },
      { "email": "user@example.com", "reason": "unsubscribe", "source": "user" }
    ]
  }
  ```
- Expected output:
  ```json
  {
    "rowCount": 1,
    "error": {
      "code": "SENDFN_VALIDATION_ERROR",
      "message": "Duplicate normalized suppression email in bulk add request"
    }
  }
  ```
- Negative variant(s): N/A

## TV-PUSH-001-P

- Description: FCM tokens are chunked at 500 and invalid tokens are deactivated before completion.
- Input:
  ```json
  {
    "deviceTokens": 501,
    "platform": "android",
    "invalidTokens": ["tok-500"]
  }
  ```
- Expected output:
  ```json
  {
    "providerCalls": 2,
    "chunkSizes": [500, 1],
    "deactivatedTokens": ["tok-500"]
  }
  ```
- Negative variant(s): N/A

## TV-PUSH-001-N

- Description: APNS send path fails the limit gate when it attempts more than 10 concurrent sends.
- Input:
  ```json
  {
    "platform": "ios",
    "deviceTokens": 25,
    "observedMaxConcurrency": 11
  }
  ```
- Expected output:
  ```json
  {
    "error": {
      "code": "SENDFN_INTERNAL_ERROR",
      "message": "APNS concurrency cap exceeded"
    }
  }
  ```
- Negative variant(s): N/A

## TV-DEVICE-001-P

- Description: Device refresh preserves metadata and replaces the active token.
- Input:
  ```json
  {
    "existing": {
      "userId": "user-123",
      "token": "old-token",
      "platform": "android",
      "appVersion": "1.0.0",
      "deviceInfo": { "model": "Pixel" }
    },
    "refresh": {
      "oldToken": "old-token",
      "newToken": "new-token",
      "userId": "user-123",
      "platform": "android"
    }
  }
  ```
- Expected output:
  ```json
  {
    "activeToken": "new-token",
    "preservedDeviceInfo": { "model": "Pixel" }
  }
  ```
- Negative variant(s): N/A

## TV-DEVICE-001-N

- Description: Device refresh fails when the old token does not belong to the supplied user/platform.
- Input:
  ```json
  {
    "refresh": {
      "oldToken": "missing-token",
      "newToken": "new-token",
      "userId": "user-123",
      "platform": "android"
    }
  }
  ```
- Expected output:
  ```json
  {
    "error": {
      "code": "SENDFN_VALIDATION_ERROR",
      "message": "Old device token was not found for the supplied user and platform"
    }
  }
  ```
- Negative variant(s): N/A

## TV-PERF-001-P

- Description: Bulk operations use bounded concurrency instead of a sequential loop.
- Input:
  ```json
  {
    "bulkEmailCount": 20,
    "bulkPushCount": 20,
    "configuredConcurrency": 5
  }
  ```
- Expected output:
  ```json
  {
    "observedMaxConcurrency": 5,
    "observedMinConcurrency": 2,
    "sequential": false
  }
  ```
- Negative variant(s): N/A

## TV-PERF-001-N

- Description: Benchmark gate fails when bulk send remains purely sequential.
- Input:
  ```json
  {
    "observedMaxConcurrency": 1,
    "implementation": "for (...) await sendOne(...)"
  }
  ```
- Expected output:
  ```json
  {
    "pass": false,
    "error": {
      "code": "SENDFN_BULK_SEQUENTIAL_PATH",
      "message": "Bulk send path is purely sequential"
    }
  }
  ```
- Negative variant(s): N/A

## TV-OBS-001-P

- Description: Structured log event includes request and provider correlation while redacting secrets.
- Input:
  ```json
  {
    "logInput": {
      "requestId": "req_123",
      "provider": "aws-ses",
      "accessKeyId": "AKIA...",
      "deviceToken": "abcdef",
      "status": "sent"
    }
  }
  ```
- Expected output:
  ```json
  {
    "logOutput": {
      "requestId": "req_123",
      "provider": "aws-ses",
      "status": "sent",
      "accessKeyId": "[REDACTED]",
      "deviceToken": "[REDACTED]"
    }
  }
  ```
- Negative variant(s): N/A

## TV-OBS-001-N

- Description: Observability gate fails when raw email HTML or provider secrets are logged.
- Input:
  ```json
  {
    "logOutput": {
      "html": "<p>Hello</p>",
      "secretAccessKey": "secret"
    }
  }
  ```
- Expected output:
  ```json
  {
    "pass": false,
    "error": {
      "code": "SENDFN_SECRET_LEAK",
      "message": "Structured log contains redaction violations"
    }
  }
  ```
- Negative variant(s): N/A

## TV-TEST-001-P

- Description: Clean-checkout TypeScript and Python release-gate commands pass from repo root after documented installs.
- Input:
  ```json
  {
    "commands": [
      "npm install",
      "npm run build --workspace sendfn/typescript",
      "npm run lint --workspace sendfn/typescript",
      "npm test --workspace sendfn/typescript -- --run",
      "python3 -m pip install -e ./python-core",
      "python3 -m pip install -e './sendfn/python[dev,email,push,fastapi]'",
      "python3 -m pytest sendfn/python/tests"
    ]
  }
  ```
- Expected output:
  ```json
  { "allPassed": true }
  ```
- Negative variant(s): N/A

## TV-TEST-001-N

- Description: Release gate fails when local dev-tool binaries are missing from the declared install path.
- Input:
  ```json
  {
    "command": "npm run build --workspace sendfn/typescript",
    "stderr": "sh: tsup: command not found"
  }
  ```
- Expected output:
  ```json
  {
    "allPassed": false,
    "error": {
      "code": "SENDFN_RELEASE_GATE_FAILED",
      "message": "TypeScript build tooling is not available from the documented install path"
    }
  }
  ```
- Negative variant(s): N/A

## TV-TEST-002-P

- Description: Memory adapter/test double rejects duplicate IDs and supports provider-message-id lookup for webhook tests.
- Input:
  ```json
  {
    "create": [{ "id": "tx-1" }],
    "createDuplicate": [{ "id": "tx-1" }],
    "lookupProviderMessageId": "ses-123"
  }
  ```
- Expected output:
  ```json
  {
    "duplicateCreateError": {
      "code": "SENDFN_UNIQUE_CONSTRAINT"
    },
    "providerLookupSupported": true
  }
  ```
- Negative variant(s): N/A

## TV-TEST-002-N

- Description: Weak test double silently overwrites duplicate IDs and causes the fidelity gate to fail.
- Input:
  ```json
  {
    "duplicateBehavior": "overwrite"
  }
  ```
- Expected output:
  ```json
  {
    "pass": false,
    "error": {
      "code": "SENDFN_TEST_DOUBLE_FIDELITY",
      "message": "Test double silently overwrites duplicate primary keys"
    }
  }
  ```
- Negative variant(s): N/A

## TV-DOC-001-P

- Description: Documentation and examples match shipped behavior and package names.
- Input:
  ```json
  {
    "typescriptReadme": {
      "packageName": "sendfn",
      "features": ["email", "sms", "push"]
    },
    "pythonReadme": {
      "features": ["email", "push", "sms"],
      "optionalExtras": ["email", "push", "fastapi"]
    }
  }
  ```
- Expected output:
  ```json
  { "valid": true, "mismatches": [] }
  ```
- Negative variant(s): N/A

## TV-DOC-001-N

- Description: Documentation gate fails when README says a feature is “coming soon” even though code and public imports ship it, or when install/import names drift.
- Input:
  ```json
  {
    "pythonReadmeFeatureLabel": "Push Notifications - coming soon",
    "pythonPublicImports": ["sendfn.push.FcmProvider", "sendfn.push.ApnsProvider"]
  }
  ```
- Expected output:
  ```json
  {
    "valid": false,
    "error": {
      "code": "SENDFN_DOC_DRIFT",
      "message": "Documentation does not match shipped public behavior"
    }
  }
  ```
- Negative variant(s): N/A

## TV-SHARED-001-P

- Description: Shared Superfunctions DB/HTTP abstractions remain the integration boundary.
- Input:
  ```json
  {
    "typescriptImports": ["@superfunctions/db", "@superfunctions/http"],
    "pythonImports": ["superfunctions.db", "superfunctions.http"]
  }
  ```
- Expected output:
  ```json
  { "valid": true }
  ```
- Negative variant(s): N/A

## TV-SHARED-001-N

- Description: Shared-abstraction gate fails when new local generic DB/HTTP adapters are introduced under sendfn.
- Input:
  ```json
  {
    "newLocalModules": [
      "sendfn/typescript/src/local-http-router.ts",
      "sendfn/python/sendfn/local_db_adapter.py"
    ]
  }
  ```
- Expected output:
  ```json
  {
    "valid": false,
    "error": {
      "code": "SENDFN_SHARED_ABSTRACTION_REGRESSION",
      "message": "sendfn introduced local generic DB/HTTP adapter logic instead of using shared Superfunctions packages"
    }
  }
  ```
- Negative variant(s): N/A
