# Security, tenancy, and RBAC

## Canonical hierarchy

```text
installation
└── workspace
    └── project
        └── environment
```

`installation` is the stable root API term. `organizationId` is accepted as a deprecated compatibility alias for that root; it is not an additional hierarchy level. Function namespaces and regions are subordinate execution attributes, not alternative tenant roots.

## Authentication

AuthFn powers interactive sessions, users, identities, memberships, organizations/workspaces, roles, API keys/service credentials, OAuth, MFA, and session revocation. Console adapters accept an AuthFn-backed actor resolver rather than parsing credentials independently.

Cookie-authenticated mutations retain CSRF protection. Service credentials carry explicit scopes and are never accepted from query parameters. Impersonation, when configured, is a distinct actor chain and always audited.

## Authorization

Authorization is layered:

1. authenticated actor;
2. workspace/project/environment membership;
3. capability permission;
4. contextual policy such as environment, risk, network, MFA, or approval;
5. function-owned object-level authorization and namespace isolation.

The shell may hide unavailable actions for usability, but the dispatcher and domain service enforce all layers. Unknown resources may return not found to avoid membership disclosure.

## Permissions and roles

Permissions use stable names such as `<module>.<resource>.read` and `<module>.<resource>.<action>`. Default role templates may include:

- installation administrator;
- workspace administrator;
- project administrator;
- operator;
- developer;
- support operator;
- security auditor;
- billing administrator;
- read-only viewer.

Custom roles are permission sets evaluated by the same policy engine. Pages do not contain role-name conditionals.

## Tenant isolation

- Every request has an explicit active scope.
- Resource IDs are resolved inside that scope.
- Provider cursors and idempotency records are scope-bound. Production cursor providers additionally supply integrity protection; the basic shared scope-checking codec is not a signature.
- DataFn namespaced resources retain `__ns` isolation and domain authorization.
- SearchFn queries and index mutations include namespace and region filters.
- FileFn uses protected services so grants, owner/tenant checks, upload tokens, and storage boundaries remain active.
- AuthFn effective namespace/region is forwarded to runtime services.
- Cross-scope administration requires a separately declared capability and permission.

Tests attempt horizontal and vertical scope escape through UI loads, REST, SDK, and MCP.

## Secrets and privacy

SecFn is used for console-managed secret material where available. Secret values are write-only by default; reads return metadata or masked forms. Audit, logs, traces, errors, search indexes, and analytics must not receive raw tokens, passwords, provider credentials, private keys, message bodies, recordings, or configured sensitive fields.

High-risk exports and destructive privacy actions use narrow permissions, explicit confirmation, and audit targets. Retention and subject-deletion operations delegate to owning functions.

## Mutation safety

- safe mutations can be directly invoked with normal permission;
- sensitive mutations may require recent MFA or approval policy;
- destructive mutations require explicit confirmation and precise target identity;
- replayable mutations require durable idempotency;
- bulk actions declare maximum size and selection semantics;
- policy decisions are included in audit metadata without leaking policy internals.

## Audit integrity

Audit records are append-only at the interface boundary. Required mutations record sanitized intent before domain invocation and a terminal outcome afterward; failure to record intent prevents invocation. Production stores require durable ordering and restricted deletion. This ordering does not manufacture distributed atomicity across separately supplied stores. Audit viewers may filter but cannot silently rewrite history. Corrections are new events referencing the original.

## Threat-focused verification

- confused-deputy service credentials;
- object ID substitution;
- workspace/project/environment mismatch;
- namespace and region bypass;
- forged provider cursors and idempotency keys;
- CSRF and session fixation;
- MCP tool discovery leakage;
- secret/error/audit exfiltration;
- destructive-action replay;
- race conditions around revoke, delete, reconcile, and rollback.
