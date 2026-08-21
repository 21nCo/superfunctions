# PR Review Report — 21nCo/super-functions.next #48

- Pull request: [#48 — SFN-22 Make Super Console function-agnostic and manifest-driven](https://github.com/21nCo/super-functions.next/pull/48)
- Base / head: `next` ← `SFN-22`
- Reviewed head: `cab5fa0d8079aa0b64c3249b05eb8a36a683744d`
- Generated: `20260821110727` UTC
- Raw evidence: `.conduct/pr-reports/21nCo-super-functions.next-pr-48-comments.json`
- Evidence coverage: 19 inline comments, 4 submitted reviews, and 5 conversation comments; all pages from all three GitHub surfaces were retrieved successfully.
- Status legend: `Open`, `Fixed`, `Skipped (Already Fixed)`, `Not Attempted`.

## Summary

The 19 inline comments reduce to 14 unique actionable findings after deduplicating overlapping reports from Graphite, Codex, and Cubic.

| Severity | Unique issues |
| --- | ---: |
| High | 2 |
| Medium | 11 |
| Low | 1 |
| **Total** | **14** |

## High

### 1. Preserve multiple Set-Cookie headers without comma corruption

- Status: Fixed
- File: `superconsole/src/lib/server/super-console.ts`
- Evidence: [Graphite r3829388785](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829388785), [Cubic r3829423071](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423071)
- Finding: The no-`getSetCookie()` fallback reads `headers.get("set-cookie")`, which can collapse multiple cookies into one comma-delimited value and corrupt `Expires` attributes.
- Required resolution: Copy every cookie as an independent header value in both response and mapped-error paths, including runtimes without `Headers.getSetCookie()`, and add regression coverage for multiple cookies with `Expires`.

### 2. Do not expose context-bound CiFn collections as unfiltered generic pages

- Status: Fixed
- File: `cifn/admin/src/capability.ts`
- Evidence: [Codex r3829398371](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829398371), [Cubic r3829423079](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423079)
- Finding: Jobs, logs, and artifacts require a run context, but generic resource pages invoke their list operations without the required `filter.runId` / `filter.jobKey`.
- Resolution: Added manifest-owned `standaloneList: false` metadata and made generic resource projection suppress collection URLs/cards for those resources. The filtered operations remain available to parent-context-aware API and MCP callers.

## Medium

### 3. Group generic resources by the declared operation target

- Status: Fixed
- Files: `superconsole/src/lib/server/super-console.ts`, `packages/admin/src/validator.ts`
- Evidence: [Codex r3829398377](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829398377)
- Finding: Resource grouping infers the resource from the operation ID rather than `operation.target.resource`, so valid non-conventional IDs such as `examplefn.enumerate` are not attached to their declared resource.
- Required resolution: Resolve resource membership from `operation.target.resource` and cover non-conventional operation IDs.

### 4. Project provider-selected CSRF headers instead of fixed AuthFn/console names

- Status: Fixed
- Files: `packages/admin/src/openapi.ts`, `superconsole/src/lib/server/super-console.ts`
- Evidence: [Codex r3829398386](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829398386), [Cubic r3829423094](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423094), [Cubic r3829423128](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423128)
- Finding: Mutation operations advertise fixed `X-AuthFn-CSRF` or `X-Operator-CSRF` headers even though operator-auth providers select the actual CSRF header.
- Required resolution: Accept/project provider-supplied CSRF parameter metadata, or omit the claim when no provider header is configured; add projection tests.

### 5. Do not sort only the already-paginated client page

- Status: Fixed
- File: `superconsole/src/lib/components/resource-pages.ts`
- Evidence: [Codex r3829398392](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829398392), [Cubic r3829423143](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423143)
- Finding: Applying `defaultSort` after fetching one cursor page produces globally incorrect ordering.
- Required resolution: Send supported sort metadata to the provider before pagination, or preserve provider order when the list contract has no sort input.

### 6. Honor the exact configured CSRF cookie name

- Status: Fixed
- File: `superconsole/src/lib/components/admin-api.ts`
- Evidence: [Cubic r3829423085](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423085)
- Finding: `operatorCsrfToken` filters candidates by the `.csrf` suffix even when the runtime provides an exact configured cookie name, rejecting valid custom names.
- Required resolution: Match an explicit configured name exactly; retain suffix-based discovery only as the unconfigured fallback.

### 7. Remove the fictional default operator-session cookie scheme

- Status: Fixed
- File: `packages/admin/src/openapi.ts`
- Evidence: [Cubic r3829423091](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423091)
- Finding: Shared OpenAPI defaults claim a `__Secure-superconsole.session` cookie even though the actual provider may use another cookie or authentication mechanism.
- Required resolution: Require or derive provider-supplied security schemes instead of publishing a false default.

### 8. Apply presentation sorting consistently when explicit rows are supplied

- Status: Fixed
- File: `superconsole/src/lib/components/resource-pages.ts`
- Evidence: [Cubic r3829423100](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423100)
- Finding: The component sorts derived `canonicalItems` but renders explicit `rows` unchanged, so the same presentation metadata behaves differently by input form.
- Required resolution: Use one canonical ordering policy for both inputs, consistent with provider-side pagination semantics.

### 9. Make the README manifest example valid

- Status: Fixed
- File: `packages/admin/README.md`
- Evidence: [Cubic r3829423101](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423101)
- Finding: The sample resource omits required `description` and `risk` fields.
- Required resolution: Add the required fields so the documented example passes manifest validation.

### 10. Validate presentation fields only against the schemas that consume them

- Status: Fixed
- File: `packages/admin/src/validator.ts`
- Evidence: [Cubic r3829423107](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423107)
- Finding: Every presentation field is checked against both list and detail record schemas, rejecting valid detail-only metadata when schemas differ.
- Required resolution: Validate columns/list fields against list surfaces and detail-only fields against the applicable detail surface; add divergent-schema tests.

### 11. Require defaultSort fields to be declared sortable

- Status: Fixed
- File: `packages/admin/src/validator.ts`
- Evidence: [Cubic r3829423114](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423114)
- Finding: The validator skips the membership check when `sortableFields` is absent or empty.
- Required resolution: Reject any `defaultSort.field` not explicitly present in `sortableFields`.

### 12. Guard malformed presentation operations before dereferencing target

- Status: Fixed
- File: `packages/admin/src/validator.ts`
- Evidence: [Cubic r3829423122](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423122)
- Finding: Validation dereferences `operation.target.resource` even when malformed input omitted `target`, converting a validation error into a runtime `TypeError`.
- Required resolution: Treat a missing target as a normal validation issue and continue collecting diagnostics.

### 13. Replace the regex-only function-agnostic source guard

- Status: Fixed
- File: `superconsole/scripts/verify-function-agnostic.mjs`
- Evidence: [Cubic r3829423136](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423136)
- Finding: The broad `*fn` regex flags unrelated identifiers such as `saveFn`, misses embedded names such as `AuthFnConfig`, and scans comments/strings as code.
- Required resolution: Inspect actual module specifiers/imports and concrete function package references, while keeping the fixed-catalog-symbol check precise.

## Low

### 14. Support the full declared Node 20 engine range

- Status: Fixed
- File: `superconsole/scripts/verify-function-agnostic.mjs`
- Evidence: [Cubic r3829423150](https://github.com/21nCo/super-functions.next/pull/48#discussion_r3829423150)
- Finding: `import.meta.dirname` is unavailable in early Node 20 releases allowed by the package engine.
- Required resolution: Derive the directory with `fileURLToPath(import.meta.url)` and `dirname`.

## Deduplication Map

- Issue 1 combines Graphite and Cubic cookie findings.
- Issue 2 combines Codex and Cubic CiFn context findings.
- Issue 4 combines the Codex console projection finding with Cubic findings for both shared and console OpenAPI projections.
- Issue 5 combines Codex and Cubic pagination-order findings.
- The remaining inline comments each map to one unique issue above.

## Validation

- `@superfunctions/admin`: 70 tests passed; typecheck passed.
- `superconsole`: 87 tests passed; server build passed; Svelte check passed with 0 errors and 0 warnings.
- Function-agnostic guard: passed under the installed Node 20 runtime and the default Node 22 runtime.
- `@cifn/admin`: changed manifest test passed; typecheck passed; the four operational coverage tests relevant to these changes also passed.
- Full `@cifn/admin` has one pre-existing failure in the signed-artifact URL test. The same failure was reproduced at untouched head `cab5fa0d` in an isolated worktree.
- Existing remote JavaScript and guardrails failures are unrelated repository-wide baselines: Turbo reports a Probefn dependency cycle, and duplication guardrails report LangFn clones. Vercel failures are account-plan restrictions. No remote checks were rerun because this workflow leaves fixes unstaged and unpublished.

## Evidence Limitations

- Sourcery explicitly reported that it could not access the private repository, so it supplied no actionable code findings.
- Qodo reported that review was paused.
- CodeRabbit supplied a high-level walkthrough/free summary without line-level findings.
- Pullfrog reported a failed review run.
- These bot-side limitations are retained in the raw evidence; GitHub pagination itself completed without error.
