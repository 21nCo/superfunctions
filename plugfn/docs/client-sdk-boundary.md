# PlugFn Client SDK Boundary

## Current status

PlugFn does not currently publish a browser-first SDK.

The default contract is server-side:

- provider credentials stay on the server
- OAuth token exchange stays on the server
- webhook verification stays on the server
- privileged provider actions stay on the server

## If a thin browser helper is added later

Only the following operations are allowed in a browser-facing helper:

- `getProviderCatalog`
- `startConnection`

These operations are intentionally limited to discovery and connection initiation.

## Server-only operations

The following operations remain server-only and must not move into a browser package:

- token exchange
- token refresh
- disconnect
- direct credentialed provider actions
- workflow execution
- webhook signature verification
- provider secret resolution

Browser attempts to perform server-only operations should be treated as contract violations.
