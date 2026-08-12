# SFN-17 — Build MailFn as a reusable programmable mailbox function

Source: <https://linear.app/21n/issue/SFN-17/build-mailfn-as-a-reusable-programmable-mailbox-function>

## Objective

Implement every phase in the SFN-17 ideation and architecture documents as a reusable Superfunctions package family: provider-neutral mailbox core, Cloudflare deployment adapter, typed client, test helpers, CLI, MCP server, SendFn outbound composition, and a public facade.

## Acceptance requirements

1. Define package/API/event compatibility, tenancy, retention, threat model, failure matrix, and public-launch gates.
2. Implement stable/expiring inboxes, real inbound receipt, D1/R2/Queue durability, MIME/attachment parsing, raw evidence, filtering, wait/cancel/timeout, OTP/link extraction, scoped credentials, idempotency, and tests.
3. Implement CLI, MCP, webhooks, custom domains, test fixtures, retention, audit, reconciliation, operations, and deployment configuration.
4. Implement threads, labels, search, drafts, reply/forward, SendFn composition, and privilege-contained delegation.
5. Implement tenant quotas, abuse/support/compliance/usage/data-region controls and gate all public-production capabilities behind explicit approval.
6. Register all packages and enforce build/test/pack/install/import verification without deploying, publishing, changing DNS, or enabling public outbound.

## Comparable-product inputs

- MailSlurp: inbox API, wait/match primitives, attachments, custom domains.
- Mailtrap Inbound Email: raw/attachment evidence, thread/reply behavior, signed webhooks and retries.
- AgentMail: agent-oriented inbox, message/thread/draft/attachment workflows and webhook events.

## External side-effect boundary

Implementation and local verification are authorized. Cloudflare deployment, DNS mutation, package publication, public billing/support activation, production-security approval, and outbound public-service enablement are intentionally excluded unless separately authorized.
