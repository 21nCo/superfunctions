# Full Audit: Revised Functional Sufficiency of authfn for 21n + Nucleus

## Metadata
- exact timestamp: 2026-03-22T14:57:30Z
- agent_name: unknown-agent
- model name/version: gpt-5-codex
- launcher: Codex Desktop
- workspace/project absolute path: /Users/serro/Documents/dev/n/superfunctions
- OS + shell: Darwin ArBook.local 25.3.0 arm64; shell=zsh
- repo metadata:
  - superfunctions: branch=`next` commit=`b69090aaa83f0515924aa9b11df3b1fcd4de3a1a` dirty=`yes`
  - 21n: branch=`dev` commit=`5e9203b2d4d1b46c2a595820a0d109f94938fb47` dirty=`yes`
  - nucleus: branch=`next` commit=`7de5a9a6176b61b11a4dff4ec5c1e99ca46c7776` dirty=`yes`
- intent/notes paths audited:
  - current conversation request: "If we want to replace better-auth in /Users/serro/Documents/dev/n/21n (backend) and /Users/serro/Documents/dev/n/nucleus (frontend) with authfn - what are the gaps?" (no filesystem path)
  - scope clarification: ignore client API shape, response shape, existing schema, and migration effort; judge only whether authfn can provide the same core functionality currently used today
- spec bundle paths audited:
  - formal migration spec bundles provided by user: none
  - informative authfn capability bundle:
    - root: /Users/serro/Documents/dev/n/superfunctions/authfn
    - included files:
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/types.ts
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/http/router.ts
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/sessions.ts
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/passwords.ts
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/core/regions.ts
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/email-password.ts
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/email-otp.ts
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/social-oauth.ts
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/multi-region.ts
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/two-factor.ts
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/plugins/api-keys.ts
      - /Users/serro/Documents/dev/n/superfunctions/authfn/core/src/__tests__/multi-region.test.ts
      - /Users/serro/Documents/dev/n/superfunctions/packages/http-hono/README.md
- codebase scope audited:
  - /Users/serro/Documents/dev/n/21n/services/account
  - /Users/serro/Documents/dev/n/21n/services/mobile-oauth
  - /Users/serro/Documents/dev/n/nucleus/client/components/account
  - /Users/serro/Documents/dev/n/nucleus/client/routes/[...route]
  - /Users/serro/Documents/dev/n/nucleus/client/stores/account.store.ts
  - /Users/serro/Documents/dev/n/nucleus/client/persistence/persistence.ts
  - excluded folders: `node_modules`, `dist`, and unrelated packages outside the auth surface
- commands executed during audit:
  - `rg -n ... /Users/serro/Documents/dev/n/21n /Users/serro/Documents/dev/n/nucleus /Users/serro/Documents/dev/n/superfunctions/authfn`
  - `sed -n '<range>p' <file>`
  - `git -C <repo> rev-parse --abbrev-ref HEAD`
  - `git -C <repo> rev-parse HEAD`
  - `git -C <repo> status --short`
  - `date -u +"%Y-%m-%dT%H:%M:%SZ"`
  - `uname -a`

## Audit scope
This revised audit intentionally excludes migration mechanics and contract-compatibility work. I did not score:

- existing Better Auth schema compatibility
- client SDK shape compatibility
- response envelope differences
- route-name differences
- cookie-name differences
- frontend rewrite effort

I only checked whether authfn can provide the same core behaviors currently relied on in 21n + Nucleus. No implementation code was changed. No runtime tests were executed. Findings are based on static inspection of current usage and authfn source/tests.

## Inputs audited (intent + spec bundles)
### Intent inputs
No formal replacement spec was provided. The authoritative intent was reconstructed from:

- the user question plus the later scope clarification
- current Better Auth usage in `/Users/serro/Documents/dev/n/21n/services/account/src/lib/auth.ts`
- current region lookup flow in `/Users/serro/Documents/dev/n/21n/services/account/src/routes/lookup.ts`
- current mobile OAuth bridge in `/Users/serro/Documents/dev/n/21n/services/mobile-oauth`
- current Nucleus auth flows in `/Users/serro/Documents/dev/n/nucleus/client/components/account`

### Spec bundles
- Formal spec bundles provided: none
- Result: formal intent-to-spec coverage is `SPEC MISSING`
- Informative authfn source/tests were used only to determine present capability

## High-level findings
1. Under the revised scope, authfn is mostly sufficient for the browser-centric auth functionality currently used in 21n + Nucleus.
2. authfn already covers the biggest functional building blocks: Hono integration, password auth, email OTP auth, OTP-backed password reset, Google/Apple/GitHub social auth, runtime/host-aware provider config, secure cookie sessions, session list/revoke/sign-out, region lookup, and wrong-region rejection during sign-in/session issuance.
3. authfn does have a first-class multi-region plugin. It materially helps with the current cross-region behavior because it supports host-to-region runtime resolution, external directory lookup, public region lookup, post-create region registration, and wrong-region enforcement before session issuance.
4. The remaining real gaps are narrow but important:
   - no built-in pre-signup cross-region guard in the multi-region plugin itself
   - no bearer-backed user session auth for the current `embedToken` flow
   - no first-class native/mobile social-auth handoff equivalent to the current deep-link token bridge
   - no built-in compromised-password screening equivalent to `haveIBeenPwned()`
5. I did find 2FA and API-key primitives in authfn. I did not find active 21n/Nucleus product flows that make those a current parity blocker.

## Intent Inventory
1. Serve auth from a Hono backend mounted under `/api/auth/*`.
2. Support email/password sign-up and sign-in.
3. Support email OTP sign-in, including sending and verifying OTPs.
4. Support OTP-backed password reset.
5. Support Google, Apple, and GitHub sign-in.
6. Support host-aware OAuth credentials, including Apple client-secret resolution.
7. Support secure shared-cookie sessions across managed subdomains.
8. Support public region lookup by identifier before auth.
9. Reject sign-in or session issuance on the wrong region authority.
10. Prevent duplicate cross-region sign-up before local account creation when an identifier already belongs to another region.
11. Support embedded auth via a bearer-backed user session token (`embedToken`).
12. Support mobile/embed social OAuth that can hand control back to the app with a usable auth artifact.
13. Support session check, sign-out, and multi-session-safe session management.
14. Reject compromised passwords with an HIBP-style check.
15. Preserve 2FA and API-key capability if those backend plugins remain desired.

## Intent -> Spec coverage matrix (complete; no sampling)
Note: no formal spec bundle was provided, so every row has `SPEC MISSING` for formal coverage.

| Intent | Current evidence | authfn evidence | Formal spec coverage | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| I1 | `21n/services/account/src/index.ts` | `packages/http-hono/README.md`, `authfn/core/src/http/router.ts` | SPEC MISSING | PASS | Hono router mounting exists. |
| I2 | `CloudSyncLogin.svelte`, `auth.ts` | `authfn/core/src/plugins/email-password.ts` | SPEC MISSING | PASS | Password sign-up/sign-in exists. |
| I3 | `CloudSyncLogin.svelte` | `authfn/core/src/plugins/email-otp.ts` | SPEC MISSING | PASS | OTP send + sign-in verify flow exists. |
| I4 | `ForgotPassword.svelte` | `authfn/core/src/plugins/email-password.ts`, `authfn/core/src/plugins/email-otp.ts` | SPEC MISSING | PASS | Reset-start and reset-complete flows exist. |
| I5 | `OAuthOptions.svelte`, `auth.ts` | `authfn/core/src/plugins/social-oauth.ts` | SPEC MISSING | PASS | Browser social auth exists for Google/Apple/GitHub. |
| I6 | `21n/services/account/src/lib/auth.ts` | `authfn/core/src/types.ts`, `authfn/core/src/plugins/social-oauth.ts` | SPEC MISSING | PASS | Runtime provider config and Apple `clientSecretResolver` are supported. |
| I7 | `21n/services/account/src/lib/auth.ts` | `authfn/core/src/core/cookies.ts` | SPEC MISSING | PASS | Secure, domain-scoped cookie sessions are configurable. |
| I8 | `21n/services/account/src/routes/lookup.ts`, `CloudSyncLogin.svelte` | `authfn/core/src/plugins/multi-region.ts`, `authfn/core/src/core/regions.ts` | SPEC MISSING | PASS | Public identifier lookup and redirect guidance exist. |
| I9 | `21n/services/account/src/lib/auth.ts` | `authfn/core/src/plugins/multi-region.ts`, `authfn/core/src/__tests__/multi-region.test.ts` | SPEC MISSING | PASS | Wrong-region sign-in/session issuance is enforced. |
| I10 | `databaseHooks.user.create.before` in `auth.ts` | `authfn/core/src/plugins/multi-region.ts`, `authfn/core/src/types.ts` | SPEC MISSING | PARTIAL | authfn helps, but the built-in plugin does not itself abort wrong-region sign-up before local user creation. |
| I11 | `nucleus/client/components/account/auth.ts` | `authfn/core/src/core/sessions.ts` | SPEC MISSING | FAIL | `Authorization: Bearer ...` authenticates API keys, not user sessions. |
| I12 | `21n/services/mobile-oauth`, `OAuthOptions.svelte` | `authfn/core/src/plugins/social-oauth.ts` | SPEC MISSING | PARTIAL | Browser social OAuth exists; native/mobile handoff artifact is not first-class. |
| I13 | `nucleus/client/components/account/auth.ts`, debug views | `authfn/core/src/http/router.ts`, `authfn/core/src/core/sessions.ts` | SPEC MISSING | PASS | Session check, list, revoke, and sign-out exist. |
| I14 | `haveIBeenPwned()` in `auth.ts` | `authfn/core/src/core/passwords.ts` | SPEC MISSING | FAIL | authfn enforces minimum length but has no built-in compromised-password check. |
| I15 | Better Auth plugins enabled in backend | `authfn/core/src/plugins/two-factor.ts`, `authfn/core/src/plugins/api-keys.ts` | SPEC MISSING | PASS | Capability exists; no active product blocker found in inspected code. |

## Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)
### Formal migration spec bundle
- No authoritative migration spec bundle was provided.
- Result: no formal requirement counting is possible.

### Derived functional capability bundle
- PASS: 11
- PARTIAL: 2
- FAIL: 2
- UNVERIFIED: 0

Interpretation:
- If the target is standard browser auth plus region-aware routing, authfn is broadly sufficient.
- If the target also includes the exact current embed/mobile auth behaviors and compromised-password screening, authfn still has real product-level gaps.

## Requirement-by-requirement results (tables + per-requirement notes)
| ID | Derived requirement | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| AF-01 | Hono-compatible auth router exists | PASS | `packages/http-hono/README.md`, `authfn/core/src/http/router.ts` | Backend fit is good. |
| AF-02 | Password sign-up/sign-in exists | PASS | `authfn/core/src/plugins/email-password.ts` | Present. |
| AF-03 | Email OTP sign-in exists | PASS | `authfn/core/src/plugins/email-otp.ts` | Present. |
| AF-04 | OTP-backed password reset exists | PASS | `authfn/core/src/plugins/email-password.ts`, `authfn/core/src/plugins/email-otp.ts` | Present. |
| AF-05 | Google/Apple/GitHub social auth exists | PASS | `authfn/core/src/plugins/social-oauth.ts` | Present for browser flows. |
| AF-06 | Host-aware provider config and Apple secret resolution exist | PASS | `authfn/core/src/types.ts`, `authfn/core/src/plugins/social-oauth.ts` | Present. |
| AF-07 | Shared secure cookie-session config exists | PASS | `authfn/core/src/core/cookies.ts` | Present. |
| AF-08 | Public multi-region lookup exists | PASS | `authfn/core/src/plugins/multi-region.ts`, `authfn/core/src/core/regions.ts` | Present. |
| AF-09 | Wrong-region sign-in/session issuance is blocked | PASS | `authfn/core/src/plugins/multi-region.ts`, `authfn/core/src/__tests__/multi-region.test.ts` | Present. |
| AF-10 | Pre-signup cross-region duplicate prevention is built into authfn multi-region | PARTIAL | `authfn/core/src/plugins/multi-region.ts`, `authfn/core/src/types.ts`, `authfn/core/src/core/passwords.ts` | Plugin registers and looks up region data, but the pre-create abort still needs a custom `beforeUserCreate` check or plugin enhancement. |
| AF-11 | Bearer-backed user session auth exists for embed use | FAIL | `nucleus/client/components/account/auth.ts`, `authfn/core/src/core/sessions.ts` | Bearer auth is wired to API keys, not sessions. |
| AF-12 | Native/mobile social-auth handoff is first-class | PARTIAL | `21n/services/mobile-oauth`, `authfn/core/src/plugins/social-oauth.ts` | authfn supports redirect/json callback modes, but not a built-in deep-link session-token handoff. |
| AF-13 | Session check/sign-out/multi-session-safe operations exist | PASS | `authfn/core/src/http/router.ts`, `authfn/core/src/core/sessions.ts` | Present. |
| AF-14 | Compromised-password screening equivalent to HIBP exists | FAIL | `21n/services/account/src/lib/auth.ts`, `authfn/core/src/core/passwords.ts`, `authfn/core/src/plugin-types.ts` | No built-in HIBP-style check, and the password plugin exposes no password-validation hook for it today. |
| AF-15 | 2FA and API-key primitives exist | PASS | `authfn/core/src/plugins/two-factor.ts`, `authfn/core/src/plugins/api-keys.ts` | Present. |

### Per-requirement notes
- AF-10 answer to the user’s question: yes, authfn has real cross-region capability. `authFnMultiRegionPlugin()` plus its directory hooks absolutely help with the current cross-region check, but the exact pre-signup abort semantics are not built into the plugin itself.
- AF-10 practical implication: if you are willing to use authfn’s hook surface, this is close to solved. If you require the multi-region plugin alone to do it, there is still a gap.
- AF-12 should be treated as a product-flow gap, not a route-name gap. The missing piece is a portable auth artifact for native/app handoff, not just endpoint naming.
- AF-14 is a backend security gap, not just a policy-tuning difference.

## Spec conflicts / spec gaps (explicit)
### SPEC MISSING
1. No authoritative replacement spec was provided.
2. No acceptance criteria were provided for what counts as "same functionality" for embedded/native auth.
3. No explicit product decision was provided about whether the current `embedToken` behavior must remain session-based, or may be redesigned around a different artifact.

### Scope exclusions applied by user clarification
The following are explicitly out of scope for pass/fail in this revised audit:

1. Better Auth client API shape compatibility
2. response envelope compatibility
3. route-name compatibility
4. cookie-name compatibility
5. existing schema/hash migration
6. frontend rewrite effort

## Cross-cutting audits (security/determinism/limits/errors/compat)
### Security / authz / validation boundaries
- authfn secures cookie sessions with hashed tokens and CSRF checks.
- authfn supports TOTP-based 2FA, OTP replay protection, and hashed API-key secrets.
- authfn does not support bearer-backed user sessions today; bearer auth maps to API keys.
- authfn does not provide built-in HIBP-style compromised-password rejection.

### Determinism invariants
- authfn’s multi-region plugin resolves runtime by host/region deterministically.
- authfn’s multi-region tests demonstrate deterministic lookup output and deterministic wrong-region rejection behavior.
- authfn’s hook ordering is explicitly tested, which strengthens confidence that a custom pre-signup region guard would behave predictably.

### Limits / caps
- authfn enforces a minimum password length of 12.
- authfn email OTP TTL and max-attempt behavior are configurable.
- No built-in equivalent to the current compromised-password screening was found.

### Error handling + canonical envelopes
- authfn emits structured success/error envelopes and exposes region-mismatch details such as `redirectTo`, `regionId`, and `authority`.
- For the revised scope, this is sufficient for the current region-routing capability even though it differs from Better Auth’s exact error shape.

### Compatibility / versioning / migrations
- Out of scope in this revision by explicit user instruction.

## Recommendations (ranked)
1. Treat authfn as functionally sufficient for the standard browser auth surface.
   - Reference: I1-I9, I13, I15
   - Meaning: the ordinary web flows are covered.
2. Close the pre-signup cross-region gap with authfn hooks or a small plugin enhancement.
   - Reference: I10, AF-10
   - Best fit: use the multi-region directory lookup from a `beforeUserCreate` check so signup fails before local user creation when the identifier belongs elsewhere.
3. Decide whether embedded auth must keep bearer-backed user sessions.
   - Reference: I11, AF-11
   - If yes, authfn needs first-class session-bearer support or an equivalent exchange flow.
4. Define a first-class native/mobile social-auth handoff pattern.
   - Reference: I12, AF-12
   - authfn’s browser OAuth is fine; the missing piece is the app handoff artifact.
5. Add compromised-password screening to the password path.
   - Reference: I14, AF-14
   - This likely belongs inside authfn’s password plugin or a new password-validation extension point.

## Appendix: commands run + environment details
### Representative commands
- `rg -n "better-auth|signIn\\.|signUp\\.|emailOtp|forgetPassword|twoFactor|apiKey|multiSession|bearer|haveIBeenPwned|getSession" /Users/serro/Documents/dev/n/21n/services/account /Users/serro/Documents/dev/n/nucleus`
- `rg -n "clientSecretResolver|allowlistedReturnTo|beforeUserCreate|beforeSessionIssue|Bearer|authenticateRequest|haveIBeenPwned" /Users/serro/Documents/dev/n/superfunctions/authfn/core/src /Users/serro/Documents/dev/n/superfunctions/authfn/client/src`
- `sed -n '<range>p' <file>`
- `git -C <repo> rev-parse --abbrev-ref HEAD`
- `git -C <repo> rev-parse HEAD`
- `git -C <repo> status --short`

### Environment details
- Working directory: `/Users/serro/Documents/dev/n/superfunctions`
- Filesystem/network mode: local static audit only; no network access used
- Verification mode: static audit only; no tests executed

## Bottom line
Ignoring migration and compatibility work, authfn is largely sufficient for the same core browser auth functionality you use today. The real remaining gaps are:

- no built-in pre-signup cross-region guard inside the multi-region plugin
- no bearer-backed user session support for the current embed flow
- no first-class native/mobile social-auth handoff artifact
- no built-in compromised-password screening equivalent to `haveIBeenPwned()`
