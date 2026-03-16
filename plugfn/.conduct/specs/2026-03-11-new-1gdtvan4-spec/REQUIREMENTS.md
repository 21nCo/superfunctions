# Requirements Table Of Contents

- ARCH-001
- ARCH-002
- ARCH-003
- ARCH-004
- OAUTH-001
- OAUTH-002
- OAUTH-003
- OAUTH-004
- OAUTH-005
- OAUTH-006
- OAUTH-007
- OAUTH-008
- PLUG-001
- PLUG-002
- PLUG-003
- PLUG-004
- PLUG-005
- PLUG-006
- PLUG-007
- PLUG-008
- MAIL-001
- MAIL-002
- MAIL-003
- MAIL-004
- MAIL-005
- MAIL-006
- MAIL-007
- MAIL-008
- MAIL-009
- MAIL-010
- SEC-001
- SEC-002
- SEC-003
- SEC-004
- OPS-001
- OPS-002
- OPS-003
- OPS-004

## ARCH-001

- **ID**: ARCH-001
- **Priority**: P0
- **Statement**: The repository MUST introduce shared OAuth packages `@superfunctions/oauth-core`, `@superfunctions/oauth-http`, `@superfunctions/oauth-storage`, `@superfunctions/oauth-providers`, and `@superfunctions/oauth-testing`.
- **Rationale**: OAuth logic must be reusable and not duplicated across `plugfn` and `authfn`.
- **Acceptance criteria**:
  - Package directories and `package.json` entries exist for all five packages.
  - Each package builds and exports documented entrypoints.
  - Workspace dependency graph resolves these packages from `plugfn` and `authfn` consumers.
- **Test vectors**: TV-ARCH-PACKAGES-POS, TV-ARCH-PACKAGES-NEG
- **Notes**: Package naming is normative.

## ARCH-002

- **ID**: ARCH-002
- **Priority**: P0
- **Statement**: `plugfn` MUST consume shared OAuth packages and MUST NOT keep duplicate OAuth flow logic in `plugfn/typescript/src/auth`.
- **Rationale**: Duplicate OAuth implementations cause drift and security inconsistencies.
- **Acceptance criteria**:
  - `plugfn` imports OAuth flows from shared packages.
  - Legacy OAuth implementation files are removed or reduced to adapters/wrappers without business logic.
  - End-to-end connection flow passes with shared package path only.
- **Test vectors**: TV-ARCH-SHARED-USE-POS, TV-ARCH-SHARED-USE-NEG
- **Notes**: Thin compatibility wrappers are allowed only if they forward to shared packages.

## ARCH-003

- **ID**: ARCH-003
- **Priority**: P0
- **Statement**: `plugfn` MUST implement email adapters for Gmail, Outlook, Yahoo Mail, iCloud Mail, generic IMAP/SMTP, forwarding ingest, and managed mailbox mode.
- **Rationale**: Finatron/Fellotron scope requires broad email-provider coverage and migration paths.
- **Acceptance criteria**:
  - Provider registry lists all required adapter IDs.
  - Each adapter passes contract conformance tests.
  - Missing provider config returns deterministic validation errors.
- **Test vectors**: TV-ARCH-ADAPTERS-POS, TV-ARCH-ADAPTERS-NEG
- **Notes**: Forwarding and managed mailbox are required capabilities, not required defaults.

## ARCH-004

- **ID**: ARCH-004
- **Priority**: P0
- **Statement**: All email adapters MUST map provider-native objects into one normalized mail domain model.
- **Rationale**: Finatron parsing and Fellotron orchestration require provider-agnostic data.
- **Acceptance criteria**:
  - Normalized model schema is published and versioned.
  - Gmail and Outlook payloads map to equivalent normalized message fields.
  - Invalid adapter outputs are rejected before persistence.
- **Test vectors**: TV-ARCH-MODEL-POS, TV-ARCH-MODEL-NEG
- **Notes**: Adapter-specific metadata MAY be persisted under namespaced extension fields.

## OAUTH-001

- **ID**: OAUTH-001
- **Priority**: P0
- **Statement**: Authorization URL generation MUST use cryptographically strong state and PKCE verifier/challenge when provider supports PKCE.
- **Rationale**: Prevents CSRF and authorization code interception classes of attacks.
- **Acceptance criteria**:
  - State entropy meets cryptographic random generation requirement.
  - PKCE S256 is used for providers marked `supportsPkce=true`.
  - Generated URL contains exact provider-required parameters.
- **Test vectors**: TV-OAUTH-AUTHURL-POS, TV-OAUTH-AUTHURL-NEG
- **Notes**: Non-PKCE providers must still use state/nonce protections.

## OAUTH-002

- **ID**: OAUTH-002
- **Priority**: P0
- **Statement**: OAuth state MUST be stored in a durable shared store and MUST be consumable safely across multi-instance deployments.
- **Rationale**: In-memory state stores break callback handling in distributed systems.
- **Acceptance criteria**:
  - State survives process restart and cross-node callback routing.
  - State retrieval and consume are atomic.
  - Expired states are purged by scheduled cleanup.
- **Test vectors**: TV-OAUTH-STATESTORE-POS, TV-OAUTH-STATESTORE-NEG
- **Notes**: Store adapter may be Redis, SQL, or DynamoDB.

## OAUTH-003

- **ID**: OAUTH-003
- **Priority**: P0
- **Statement**: OAuth callback handling MUST reject replayed states and mismatched redirect/provider tuples.
- **Rationale**: Callback replay and mismatch are critical authn vulnerabilities.
- **Acceptance criteria**:
  - First valid callback succeeds and consumes state.
  - Second callback with same state returns `OAUTH_STATE_REPLAYED`.
  - Redirect URI or provider mismatch returns `OAUTH_CALLBACK_MISMATCH`.
- **Test vectors**: TV-OAUTH-CALLBACK-POS, TV-OAUTH-CALLBACK-NEG
- **Notes**: Replay rejection must not leak token material.

## OAUTH-004

- **ID**: OAUTH-004
- **Priority**: P0
- **Statement**: Token exchange and refresh flows MUST support provider-specific auth methods and content formats without lossy transformation.
- **Rationale**: Providers vary on `client_secret_post`, `client_secret_basic`, and response shapes.
- **Acceptance criteria**:
  - Form-encoded token requests serialize correctly.
  - JSON token responses and form-like responses parse correctly.
  - Unsupported provider auth method returns deterministic validation error.
- **Test vectors**: TV-OAUTH-TOKEN-POS, TV-OAUTH-TOKEN-NEG
- **Notes**: Shared HTTP package owns token endpoint transport behavior.

## OAUTH-005

- **ID**: OAUTH-005
- **Priority**: P0
- **Statement**: Persisted OAuth credentials MUST be encrypted at rest with versioned key references and auditable key rotation support.
- **Rationale**: Token compromise risk requires encryption and rotation discipline.
- **Acceptance criteria**:
  - Plaintext tokens are never stored.
  - Decrypt fails safely when key reference is unavailable.
  - Key rotation re-encrypts without losing token semantics.
- **Test vectors**: TV-OAUTH-VAULT-POS, TV-OAUTH-VAULT-NEG
- **Notes**: Envelope encryption is required; exact KMS backend is configurable.

## OAUTH-006

- **ID**: OAUTH-006
- **Priority**: P0
- **Statement**: Scope requests MUST be policy-validated per feature and provider before authorization URLs are issued.
- **Rationale**: Least privilege and provider compliance require strict scope gating.
- **Acceptance criteria**:
  - Feature-to-scope map is explicit and versioned.
  - Over-scoped requests are rejected with `OAUTH_SCOPE_DISALLOWED`.
  - Consent records persist granted scopes and purpose metadata.
- **Test vectors**: TV-OAUTH-SCOPES-POS, TV-OAUTH-SCOPES-NEG
- **Notes**: Restricted scopes require explicit compliance mode flags.

## OAUTH-007

- **ID**: OAUTH-007
- **Priority**: P0
- **Statement**: `authfn` social OAuth sign-in flows MUST reuse shared OAuth packages and MUST NOT implement parallel OAuth core logic.
- **Rationale**: Prevents security divergence between app integration and sign-in stacks.
- **Acceptance criteria**:
  - `authfn` social module imports from shared OAuth packages.
  - Login URL and callback handling use shared service abstractions.
  - Unit tests prove behavior parity with `plugfn` OAuth flows.
- **Test vectors**: TV-OAUTH-AUTHFN-POS, TV-OAUTH-AUTHFN-NEG
- **Notes**: Existing API-key auth path remains supported.

## OAUTH-008

- **ID**: OAUTH-008
- **Priority**: P1
- **Statement**: Disconnect and revoke operations MUST clear local credentials and attempt provider-side revocation when supported.
- **Rationale**: Reduces lingering access after user-initiated disconnect.
- **Acceptance criteria**:
  - Disconnect deletes token vault and connection records.
  - Revocation endpoint is called for providers with configured revocation URLs.
  - Provider revocation failure is recorded and surfaced without leaving local tokens active.
- **Test vectors**: TV-OAUTH-REVOKE-POS, TV-OAUTH-REVOKE-NEG
- **Notes**: Local cleanup must happen even when remote revoke is unavailable.

## PLUG-001

- **ID**: PLUG-001
- **Priority**: P0
- **Statement**: `plugfn` HTTP routes MUST enforce authentication context and MUST NOT trust `userId` query/body inputs for authorization decisions.
- **Rationale**: Current pattern allows identity spoofing through request parameters.
- **Acceptance criteria**:
  - Auth middleware is mandatory for all non-webhook endpoints.
  - Caller `tenantId/userId` derives from session context.
  - Requests with mismatched body/query identities are rejected.
- **Test vectors**: TV-PLUG-ROUTE-AUTH-POS, TV-PLUG-ROUTE-AUTH-NEG
- **Notes**: Webhook routes authenticate by signature and secret, not user session.

## PLUG-002

- **ID**: PLUG-002
- **Priority**: P0
- **Statement**: Webhook handling MUST fail closed when signature verification cannot be performed or fails.
- **Rationale**: Accepting unsigned/unknown webhooks allows event forgery.
- **Acceptance criteria**:
  - Missing secret for configured signature providers returns `WEBHOOK_SECRET_NOT_FOUND`.
  - Invalid signatures return `WEBHOOK_SIGNATURE_INVALID`.
  - Valid signatures are processed exactly once per event ID where provider supports event IDs.
- **Test vectors**: TV-PLUG-WEBHOOK-VERIFY-POS, TV-PLUG-WEBHOOK-VERIFY-NEG
- **Notes**: Header normalization must include provider-specific signature headers.

## PLUG-003

- **ID**: PLUG-003
- **Priority**: P0
- **Statement**: Webhook route path/event mapping MUST be canonical and consistent between provider trigger declarations and router dispatch.
- **Rationale**: Path/event drift causes dropped or misrouted events.
- **Acceptance criteria**:
  - Trigger registry maps provider webhook paths to internal event keys deterministically.
  - End-to-end webhook for each provider reaches correct trigger handler.
  - Nonexistent event keys return deterministic 404/validation errors.
- **Test vectors**: TV-PLUG-WEBHOOK-MAP-POS, TV-PLUG-WEBHOOK-MAP-NEG
- **Notes**: Dot-delimited event names and URL segments require explicit mapping table.

## PLUG-004

- **ID**: PLUG-004
- **Priority**: P0
- **Statement**: Connection selection for action execution MUST be deterministic and MUST reject ambiguous selection when deterministic default cannot be resolved.
- **Rationale**: Wrong-account execution is a critical correctness and safety failure.
- **Acceptance criteria**:
  - Explicit `connectionId` always takes precedence.
  - Deterministic default order is documented and tested.
  - Ambiguous unresolved selection returns `CONNECTION_AMBIGUOUS`.
- **Test vectors**: TV-PLUG-CONNECTION-POS, TV-PLUG-CONNECTION-NEG
- **Notes**: Deterministic rule cannot depend on nondeterministic map iteration.

## PLUG-005

- **ID**: PLUG-005
- **Priority**: P0
- **Statement**: HTTP transport MUST preserve caller-provided content type semantics and MUST NOT blindly JSON-serialize non-JSON payloads.
- **Rationale**: Form-encoded and multipart provider APIs fail when payload type is corrupted.
- **Acceptance criteria**:
  - `application/x-www-form-urlencoded` requests are serialized correctly.
  - JSON payloads remain JSON.
  - Mismatched serialization path is caught by integration tests.
- **Test vectors**: TV-PLUG-HTTP-POS, TV-PLUG-HTTP-NEG
- **Notes**: This requirement specifically covers token and Stripe-like APIs.

## PLUG-006

- **ID**: PLUG-006
- **Priority**: P0
- **Statement**: Rate limiting and retries MUST respect provider throttle signals including `Retry-After` and per-tenant fairness constraints.
- **Rationale**: Prevents bans, quota exhaustion, and noisy-tenant starvation.
- **Acceptance criteria**:
  - 429 responses trigger retry scheduling from provider hints.
  - Per-provider and per-tenant buckets are independently enforced.
  - Retry loops terminate at configured max attempts.
- **Test vectors**: TV-PLUG-RATELIMIT-POS, TV-PLUG-RATELIMIT-NEG
- **Notes**: Distributed bucket backend is required for multi-instance operation.

## PLUG-007

- **ID**: PLUG-007
- **Priority**: P1
- **Statement**: Workflow execution MUST persist execution status transitions durably and enforce idempotent re-entry behavior.
- **Rationale**: Crash-safe workflows need durable state and re-run protection.
- **Acceptance criteria**:
  - Execution records survive process crash.
  - Re-running same idempotency key does not duplicate side effects.
  - Failed steps emit deterministic error states and retriable markers.
- **Test vectors**: TV-PLUG-WORKFLOW-POS, TV-PLUG-WORKFLOW-NEG
- **Notes**: Step-level compensating actions are optional unless explicitly configured.

## PLUG-008

- **ID**: PLUG-008
- **Priority**: P0
- **Statement**: `plugfn` CLI `test` command MUST run actionable provider/connection validation instead of placeholder output.
- **Rationale**: Production operability requires executable diagnostics.
- **Acceptance criteria**:
  - CLI verifies provider config, auth URL generation, callback validation stubs, and optional live health checks.
  - Exit code is nonzero on any failed check.
  - Human-readable and JSON machine output modes are provided.
- **Test vectors**: TV-PLUG-CLI-POS, TV-PLUG-CLI-NEG
- **Notes**: Live checks must be opt-in to avoid unintended API calls.

## MAIL-001

- **ID**: MAIL-001
- **Priority**: P0
- **Statement**: Gmail adapter MUST support full baseline sync, incremental sync via checkpoint, and push-triggered sync orchestration with renewal support.
- **Rationale**: Gmail is required and watch subscriptions are time-bounded.
- **Acceptance criteria**:
  - Initial full sync persists baseline checkpoint.
  - Incremental sync consumes provider history/checkpoint data.
  - Watch renewal scheduler keeps subscriptions active per policy.
- **Test vectors**: TV-MAIL-GMAIL-POS, TV-MAIL-GMAIL-NEG
- **Notes**: Push events are triggers; reconciliation remains checkpoint-driven.

## MAIL-002

- **ID**: MAIL-002
- **Priority**: P0
- **Statement**: Outlook adapter MUST support Graph subscription renewal and delta-sync checkpoint progression.
- **Rationale**: Graph subscription expiration and delta tokens are required mechanics.
- **Acceptance criteria**:
  - Subscription create/renew lifecycle is automated.
  - Delta token checkpoint advances only after successful page commit.
  - Expired/invalid delta tokens trigger controlled rebaseline.
- **Test vectors**: TV-MAIL-OUTLOOK-POS, TV-MAIL-OUTLOOK-NEG
- **Notes**: Graph throttling must route through shared retry/rate-limit middleware.

## MAIL-003

- **ID**: MAIL-003
- **Priority**: P0
- **Statement**: Yahoo adapter MUST use policy-approved OAuth IMAP/SMTP pathways and MUST block configuration that violates provider access constraints.
- **Rationale**: Yahoo access is policy-gated and cannot be treated as unrestricted API access.
- **Acceptance criteria**:
  - OAuth IMAP credentials are accepted only when provider policy status allows.
  - Non-approved scope/profile combinations are blocked before connect.
  - Inbound and outbound paths pass conformance tests.
- **Test vectors**: TV-MAIL-YAHOO-POS, TV-MAIL-YAHOO-NEG
- **Notes**: Provider policy registry controls enabled surface.

## MAIL-004

- **ID**: MAIL-004
- **Priority**: P0
- **Statement**: iCloud adapter MUST support IMAP/SMTP flows with app-specific password semantics and MUST reject unsupported POP-based setup.
- **Rationale**: iCloud provider constraints differ from generic legacy mail setups.
- **Acceptance criteria**:
  - IMAP read and SMTP send succeed with configured credentials.
  - POP configuration requests fail deterministically.
  - Credential invalidation is surfaced with actionable errors.
- **Test vectors**: TV-MAIL-ICLOUD-POS, TV-MAIL-ICLOUD-NEG
- **Notes**: 2FA/account prerequisites are represented as setup validations.

## MAIL-005

- **ID**: MAIL-005
- **Priority**: P0
- **Statement**: Generic IMAP/SMTP adapter MUST support standards-compliant providers with explicit capability flags and secure defaults.
- **Rationale**: Long-tail provider support is needed without weakening defaults.
- **Acceptance criteria**:
  - STARTTLS/TLS requirements are configurable with secure default on.
  - Capability matrix controls unsupported actions.
  - Parser handles RFC-compliant MIME message variants.
- **Test vectors**: TV-MAIL-IMAP-POS, TV-MAIL-IMAP-NEG
- **Notes**: Insecure transport fallback requires explicit override and audit event.

## MAIL-006

- **ID**: MAIL-006
- **Priority**: P1
- **Statement**: Forwarding ingestion MUST be implemented as optional inbound-only fallback and MUST not be the sole required connection mode.
- **Rationale**: Forwarding is constrained by provider/admin settings and misses some message classes.
- **Acceptance criteria**:
  - Forwarding connector can be enabled per account optionally.
  - Product setup flow does not force forwarding path.
  - Forwarding health checks detect stalls and missing categories.
- **Test vectors**: TV-MAIL-FORWARD-POS, TV-MAIL-FORWARD-NEG
- **Notes**: Spam-folder delivery gaps must be documented and surfaced.

## MAIL-007

- **ID**: MAIL-007
- **Priority**: P0
- **Statement**: Managed mailbox mode MUST enforce explicit opt-in, risk acknowledgment, and backup-channel requirements for finance-critical usage.
- **Rationale**: Primary-finance mailbox use introduces delivery/liability risk.
- **Acceptance criteria**:
  - Managed mailbox cannot be auto-enabled silently.
  - Finance-critical setup requires backup destination confirmation.
  - Critical-delivery health incidents trigger backup alerts.
- **Test vectors**: TV-MAIL-MANAGED-POS, TV-MAIL-MANAGED-NEG
- **Notes**: This requirement does not prohibit managed mailbox; it constrains safe operation.

## MAIL-008

- **ID**: MAIL-008
- **Priority**: P0
- **Statement**: Finatron parsing MUST run deterministic extraction before model-based extraction and MUST persist confidence/provenance for every structured output.
- **Rationale**: Financial workflows require explainability and lower hallucination risk.
- **Acceptance criteria**:
  - Deterministic parser executes first.
  - Model fallback executes only when deterministic confidence/rule coverage is insufficient.
  - Output records include confidence and source evidence references.
- **Test vectors**: TV-MAIL-PARSER-POS, TV-MAIL-PARSER-NEG
- **Notes**: Low-confidence outputs must not auto-trigger irreversible actions.

## MAIL-009

- **ID**: MAIL-009
- **Priority**: P0
- **Statement**: Fellotron outbound send pipeline MUST apply provider, tenant, and abuse-policy governors before send attempts.
- **Rationale**: Outbound abuse impacts platform reputation and delivery for all users.
- **Acceptance criteria**:
  - Send attempts are blocked when caps/policies are exceeded.
  - Block reason is persisted with code and retryability status.
  - Allowed sends proceed through idempotent queued execution.
- **Test vectors**: TV-MAIL-SEND-POS, TV-MAIL-SEND-NEG
- **Notes**: Governor checks occur before provider API invocation.

## MAIL-010

- **ID**: MAIL-010
- **Priority**: P0
- **Statement**: Provider restrictions and compliance rules MUST be represented in a versioned provider policy registry and enforced at runtime.
- **Rationale**: Provider requirements are dynamic and must be centrally controlled.
- **Acceptance criteria**:
  - Registry contains capability and policy metadata per provider.
  - Runtime adapter operations consult registry before execution.
  - Policy version changes are audit-logged and testable.
- **Test vectors**: TV-MAIL-POLICY-POS, TV-MAIL-POLICY-NEG
- **Notes**: Registry updates require signed or authenticated admin action.

## SEC-001

- **ID**: SEC-001
- **Priority**: P0
- **Statement**: Data lifecycle controls MUST support retention policies plus full user export and deletion across connections, tokens, messages, and derived artifacts.
- **Rationale**: Personal communications and financial data require strict lifecycle guarantees.
- **Acceptance criteria**:
  - Retention scheduler deletes expired artifacts by policy.
  - Export includes all user-scoped persisted records in portable format.
  - Deletion requests cascade through all related stores.
- **Test vectors**: TV-SEC-LIFECYCLE-POS, TV-SEC-LIFECYCLE-NEG
- **Notes**: Legal hold exceptions are handled via explicit override records.

## SEC-002

- **ID**: SEC-002
- **Priority**: P0
- **Statement**: Logs, metrics, and traces MUST redact credentials and sensitive message content by default.
- **Rationale**: Telemetry leakage is a common high-severity data exposure vector.
- **Acceptance criteria**:
  - Secret fields are masked or omitted in structured logs.
  - Metrics dimensions never include raw email content or token material.
  - Redaction tests fail when known secret patterns are emitted.
- **Test vectors**: TV-SEC-REDACTION-POS, TV-SEC-REDACTION-NEG
- **Notes**: Debug overrides require explicit, time-bound, audited activation.

## SEC-003

- **ID**: SEC-003
- **Priority**: P0
- **Statement**: Tenant and user isolation MUST be enforced in storage access and API authorization checks.
- **Rationale**: Multi-tenant cross-access is unacceptable for personal communications data.
- **Acceptance criteria**:
  - Every storage query includes tenant/user scope filters or equivalent partition keys.
  - Cross-tenant request attempts return `TENANT_ACCESS_DENIED`.
  - Penetration-style tests show no unauthorized record reads.
- **Test vectors**: TV-SEC-ISOLATION-POS, TV-SEC-ISOLATION-NEG
- **Notes**: Superuser maintenance actions require explicit elevated context.

## SEC-004

- **ID**: SEC-004
- **Priority**: P1
- **Statement**: Managed mailbox E2EE and key recovery modes MUST be explicit, mutually understood, and user-visible in security metadata.
- **Rationale**: E2EE usability/security tradeoffs must not be implicit.
- **Acceptance criteria**:
  - Security mode metadata is persisted per mailbox.
  - Non-recoverable mode prevents server-side recovery.
  - Escrow mode operations are audit-logged with actor and reason.
- **Test vectors**: TV-SEC-E2EE-POS, TV-SEC-E2EE-NEG
- **Notes**: This requirement does not mandate one mode; it mandates explicitness and safeguards.

## OPS-001

- **ID**: OPS-001
- **Priority**: P0
- **Statement**: The existing `plugfn` TypeScript and Python codebases MUST be tightened to passing tests and production-grade failure behavior before release.
- **Rationale**: Current baseline has failing tests and scaffold-level gaps.
- **Acceptance criteria**:
  - Existing failing test cases are fixed and passing.
  - New regression tests cover previously failing paths.
  - Placeholder/stub behaviors in critical paths are removed.
- **Test vectors**: TV-OPS-HARDEN-POS, TV-OPS-HARDEN-NEG
- **Notes**: Temporary skips are disallowed for release criteria.

## OPS-002

- **ID**: OPS-002
- **Priority**: P0
- **Statement**: Release readiness MUST include a deterministic verification matrix across shared OAuth packages, `plugfn`, and `authfn` social OAuth integration.
- **Rationale**: Cross-package changes require integrated validation, not isolated unit checks.
- **Acceptance criteria**:
  - Build, typecheck, and test commands pass for all impacted workspaces.
  - End-to-end OAuth connect and callback scenarios pass in automated tests.
  - Failure in any required workspace blocks release.
- **Test vectors**: TV-OPS-MATRIX-POS, TV-OPS-MATRIX-NEG
- **Notes**: Matrix command list is normative in PLAN phase docs.

## OPS-003

- **ID**: OPS-003
- **Priority**: P1
- **Statement**: Operational runbooks MUST exist for OAuth incidents, provider throttling spikes, webhook verification failures, and mail delivery incidents.
- **Rationale**: Production operations require pre-defined response paths.
- **Acceptance criteria**:
  - Runbook documents exist with detection, mitigation, rollback, and communication steps.
  - On-call simulation exercises validate runbook usefulness.
  - Runbook versions are linked in release artifacts.
- **Test vectors**: TV-OPS-RUNBOOK-POS, TV-OPS-RUNBOOK-NEG
- **Notes**: Simulation can be tabletop or scripted replay.

## OPS-004

- **ID**: OPS-004
- **Priority**: P1
- **Statement**: Documentation and examples MUST be updated to reflect shared OAuth package usage, email adapter setup, and managed-mailbox risk boundaries.
- **Rationale**: Correct implementation depends on accurate integration guidance.
- **Acceptance criteria**:
  - Getting-started docs show shared OAuth setup and provider config examples.
  - `plugfn` and `authfn` docs include migration and interoperability notes.
  - Documentation validation checks catch stale references.
- **Test vectors**: TV-OPS-DOCS-POS, TV-OPS-DOCS-NEG
- **Notes**: Provider policy caveats must be visible in setup docs.
