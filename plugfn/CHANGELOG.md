# Changelog

## Unreleased

- Schema version 8 widens `plugfn_sync_jobs.claim_token` from 64 to 768 characters. Databases at version 7 get a migration from `superfunctions generate`; on MySQL it widens the column with one `MODIFY COLUMN` that keeps existing rows and the unique `idx_plugfn_sync_jobs_claim_token` index. A version 7 database whose column is already 768 characters only records the new version.
- Added Conduct v0.3 provider contract docs for Linear, GitHub, and ClickUp.
- Documented the new ClickUp provider guide with public actions and verified webhook triggers.
- Provider builds, type checks, and unit tests now resolve the installed `plugfn` public entry point instead of building or aliasing a sibling checkout. Provider lifecycle tests also use the public entry point and declare their schema-converter test dependency.
- Restricted CLI publication to compiled artifacts, README, and license.
- Registry reconciliation: the development cutover intentionally removes the placeholder CLI `generate-types` command, forwarding/managed-mail providers, outbound mail actions, and core managed-mailbox backup/security APIs. These are not backward-compatible packaging-only changes; see the release gates for publication constraints.
- Approved the breaking `plugfn@0.2.0` ownership cutover; managed-mailbox backup, policy, and security exports are removed rather than retained as compatibility shims.
- Moved real provider-backed raw-body webhook and OAuth/webhook end-to-end coverage into the providers package, using installed public core imports; standalone core tests no longer need sibling providers.
- Completed the previously announced 0.2.0 OAuth legacy-path removal: deleted `OAuthFlowHandler`, its compatibility delegate and shim-only tests. Production connections already use the canonical shared flow service. Core builds now clean obsolete compiled modules before packaging.

## 0.1.x

- OAuth orchestration now delegates to `@superfunctions/oauth-flow`.
- Deprecated path: `plugfn/auth/oauth-flow`.
- Replacement: `@superfunctions/oauth-flow` (+ `@superfunctions/oauth-http`, `@superfunctions/oauth-storage`).
- Removal target: `plugfn@0.2.0`.
