# `@mailfn/mcp`

Agent-safe MCP server for focused MailFn workflows.

```sh
MAILFN_URL=https://mail.example.com MAILFN_TOKEN=... mailfn-mcp
```

Tools cover expiring inbox creation, message wait/list/read, OTP/link extraction, and inbox deletion: `mailfn_revoke_inbox` deletes the inbox and revokes all of its inbox-scoped credentials. Revoke a single token with the CLI (`mailfn token revoke <inbox-id> <token-id>`) or `client.revokeToken()`. Tool schemas are narrow, results are redacted by default, and content or verification values require an explicit read/extract action. Give agents inbox-scoped credentials containing only the scopes needed for their task.
