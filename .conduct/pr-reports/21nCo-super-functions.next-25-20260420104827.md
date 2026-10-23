# PR Analysis Report: 21nCo/super-functions.next #25 - Comprehensive Review Issues

**Generated:** 2026-04-20 10:48:27 IST
**PR Title:** Probefn init
**PR URL:** https://github.com/21nCo/super-functions.next/pull/25
**Branch:** `SFN-13` -> `next`
**Files Changed:** 198 files (+26244 lines, -0 lines)

## Overview
This PR introduces the initial `probefn` workspace, including CLI commands, browser-runner packages, analyzers, MCP server support, docs, and test vectors.

Automated review coverage was partial:
- **cubic** reported 11 actionable findings, but explicitly reviewed only a prioritized subset of files because the free-tier review is limited to 40 files.
- **Codex Review** reported 3 actionable inline findings.
- **Socket Security** reported 1 dependency security alert in issue comments.
- **CodeRabbit** skipped detailed review because the PR exceeded its free-plan file-count limit.
- **Sourcery** did not review because the repository does not have access to Sourcery.

This report captures **13 unique actionable issues**. Two issues were independently reported by both cubic and Codex:
- repository-root path traversal in `probefn/packages/mcp-server/src/server.ts`
- ignored `envAllowlist` in `probefn/packages/dev-server/src/dev-server-manager.ts`

---

## 🔴 **Critical Issues (5 Total)**

### **probefn/packages/mcp-server/src/server.ts - Repository escape / arbitrary file read**
**📁 File:** `probefn/packages/mcp-server/src/server.ts`

#### **Issue 1:** Reject normalized path escapes when loading flow files *(Codex Review, cubic)*
- **Severity:** High
- **Description:** Both Codex Review and cubic identified that `loadFlow` only rejects absolute paths or strings that literally begin with `..`. Inputs such as `flows/../../.env` can still resolve outside the repository root and be read by the flow loader.
- **Location:** Line 1303-1304
- **Fix:** Normalize the candidate path, resolve it against `repoRoot`, and reject any resolved path that is outside the repository root before reading the file.

### **probefn/packages/dev-server/src/dev-server-manager.ts - Orphaned detached processes**
**📁 File:** `probefn/packages/dev-server/src/dev-server-manager.ts`

#### **Issue 2:** Terminate detached dev servers by process group *(Codex Review)*
- **Severity:** High
- **Description:** Spawned servers run with `detached: true` and `shell: true`, but shutdown targets only the child PID. This can terminate the shell wrapper while leaving the actual dev server process alive, causing port leaks and cross-test interference.
- **Location:** Line 163
- **Fix:** Stop the entire detached process group instead of only the immediate child process, and verify the spawned server fully exits before marking the session complete.

### **probefn/packages/analyzers/src/design/clipping.ts - Incorrect vertical clipping detection**
**📁 File:** `probefn/packages/analyzers/src/design/clipping.ts`

#### **Issue 3:** Vertical clipping is evaluated with horizontal-only metrics *(cubic)*
- **Severity:** High
- **Description:** cubic found that `overflowY: hidden` cases are evaluated using `textOverflow`, `scrollWidth`, and `clientWidth`, which are horizontal metrics. This can miss or misclassify vertical clipping.
- **Location:** Line 13
- **Fix:** Split horizontal and vertical clipping logic so `overflowY` checks use vertical overflow signals such as height-based metrics instead of width-based ones.

### **probefn/apps/cli/src/index.ts - Entrypoint detection can fail**
**📁 File:** `probefn/apps/cli/src/index.ts`

#### **Issue 4:** Normalize `process.argv[1]` before comparing with `import.meta.url` *(cubic)*
- **Severity:** High
- **Description:** cubic found that raw string equality between `process.argv[1]` and `fileURLToPath(import.meta.url)` can fail for relative invocations, preventing CLI startup when launched through certain paths.
- **Location:** Line 150
- **Fix:** Normalize and resolve `process.argv[1]` before comparing it to the module path.

### **datafn/examples/todo-app/client/package.json - Dependency security alert**
**📁 File:** `datafn/examples/todo-app/client/package.json`

#### **Issue 5:** Socket Security flagged `npm/svelte@4.2.20` as likely obfuscated *(Socket Security)*
- **Severity:** High
- **Description:** Socket Security reported a high-severity warning that `svelte@4.2.20` appears 91.0% likely obfuscated. This is a dependency security review alert rather than an inline code comment, but it is actionable and tied to a changed dependency path in the PR.
- **Location:** Not provided in PR comment
- **Fix:** Review the package provenance and alert details, confirm whether the dependency is acceptable risk for this PR, and replace or explicitly triage it if needed.

---

## 🟡 **Medium Severity Issues (6 Total)**

### **probefn/apps/cli/src/commands/design.ts - Missing directory handling**
**📁 File:** `probefn/apps/cli/src/commands/design.ts`

#### **Issue 6:** Missing `checkpoints` directory produces raw `ENOENT` *(cubic)*
- **Severity:** Medium
- **Description:** cubic found that fresh sessions without a `checkpoints` directory will fail with a raw filesystem error instead of the intended user-facing "no checkpoints" behavior.
- **Location:** Line 51
- **Fix:** Handle missing directory cases before `readdir`, and map them to the intended empty/no-checkpoints error path.

### **probefn/packages/analyzers/src/correlation/root-cause.ts - Incomplete correlation heuristic**
**📁 File:** `probefn/packages/analyzers/src/correlation/root-cause.ts`

#### **Issue 7:** Submit-plan correlation ignores `planPageError` evidence *(cubic)*
- **Severity:** Medium
- **Description:** cubic found that the submit-plan hypothesis only considers `planConsoleEvent` plus network evidence. Equivalent page-error evidence does not trigger the same high-confidence correlation.
- **Location:** Line 67
- **Fix:** Incorporate `planPageError` into the same branch or equivalent hypothesis path so page errors and console errors receive consistent treatment.

### **probefn/packages/analyzers/package.json - Runtime dependency inflation**
**📁 File:** `probefn/packages/analyzers/package.json`

#### **Issue 8:** Test-only workspace packages are listed under `dependencies` *(cubic)*
- **Severity:** Medium
- **Description:** cubic found that packages used only for tests or local analysis were declared as production dependencies. This increases runtime dependency surface and can misstate install requirements.
- **Location:** Line 13
- **Fix:** Keep only runtime-needed packages under `dependencies` and move test-only or development-only workspace packages to `devDependencies`.

### **probefn/packages/analyzers/src/design/alignment.ts - Severity mapping mismatch**
**📁 File:** `probefn/packages/analyzers/src/design/alignment.ts`

#### **Issue 9:** 13-24px alignment drift is classified too low *(cubic)*
- **Severity:** Medium
- **Description:** cubic found that the implementation marks 13-24px left-edge drift as `low`, which conflicts with the documented severity policy for alignment issues.
- **Location:** Line 25
- **Fix:** Adjust the severity thresholds so this drift range is emitted as at least `medium`.

### **probefn/apps/cli/src/commands/report.ts - Unvalidated CLI format input**
**📁 File:** `probefn/apps/cli/src/commands/report.ts`

#### **Issue 10:** `--format` is force-cast instead of validated *(cubic)*
- **Severity:** Medium
- **Description:** cubic found that arbitrary `--format` input is cast to `'json' | 'markdown'` without validation, so invalid user input can bypass the command contract until later failure.
- **Location:** Line 24
- **Fix:** Validate `--format` against the supported values before calling the export routine and produce a clear CLI error for invalid values.

### **probefn/packages/dev-server/src/dev-server-manager.ts - Environment allowlist ignored**
**📁 File:** `probefn/packages/dev-server/src/dev-server-manager.ts`

#### **Issue 11:** `envAllowlist` is not applied when spawning the dev server *(Codex Review, cubic)*
- **Severity:** Medium
- **Description:** Both Codex Review and cubic found that the config schema accepts `devServer.envAllowlist`, but the child process always inherits `process.env` directly. This defeats the allowlist and can leak unrelated secrets into spawned servers.
- **Location:** Line 247
- **Fix:** Construct the child environment from the allowlisted keys plus any required defaults instead of passing all of `process.env`.

---

## 🟢 **Low Severity Issues (2 Total)**

### **probefn/.conduct/specs/2026-04-15-new-384qfawh-spec/phases/PHASE_04.md - Invalid test command in docs**
**📁 File:** `probefn/.conduct/specs/2026-04-15-new-384qfawh-spec/phases/PHASE_04.md`

#### **Issue 12:** Remove unsupported Vitest `--runInBand` flag *(cubic)*
- **Severity:** Low
- **Description:** cubic found that the verification instructions reference a Jest-style flag not supported by Vitest.
- **Location:** Line 35
- **Fix:** Replace the command with a valid Vitest invocation in the phase verification steps.

### **probefn/docs/baselines.md - Compare outcome wording is inaccurate**
**📁 File:** `probefn/docs/baselines.md`

#### **Issue 13:** Missing baselines and mismatches are conflated in docs *(cubic)*
- **Severity:** Low
- **Description:** cubic found that the documentation implies mismatch errors occur when the key does not resolve, even though missing baselines and dimension mismatches are distinct outcomes.
- **Location:** Line 38
- **Fix:** Update the wording to describe missing-baseline and mismatch outcomes separately.

---

## 📊 **Issues by Tool**
| Tool | Critical | Medium | Low | Total |
|------|----------|--------|-----|-------|
| **Codex Review** | 2 | 1 | 0 | 3 |
| **cubic** | 3 | 6 | 2 | 11 |
| **Socket Security** | 1 | 0 | 0 | 1 |
| **CodeRabbit** | 0 | 0 | 0 | 0 |
| **Sourcery** | 0 | 0 | 0 | 0 |
| **Total Reported Findings** | **6** | **7** | **2** | **15** |

Notes:
- Reported-finding counts above include duplicate reports from multiple tools.
- Unique actionable issues in this PR: **13**.
- CodeRabbit produced no actionable findings because review was skipped due to file-count limits.
- Sourcery produced no actionable findings because the repo does not have Sourcery access.

---

## 🎯 **Priority Action Items**
### **Immediate Fixes Required (Critical)**
1. Block repository-root escapes in `probefn/packages/mcp-server/src/server.ts` before any flow file is read.
2. Fix detached process shutdown in `probefn/packages/dev-server/src/dev-server-manager.ts` so spawned servers do not survive session shutdown.
3. Correct vertical clipping detection in `probefn/packages/analyzers/src/design/clipping.ts`.
4. Fix CLI entrypoint normalization in `probefn/apps/cli/src/index.ts`.
5. Review and triage the Socket Security dependency alert affecting `datafn/examples/todo-app/client/package.json`.

### **Important Improvements (Medium Priority)**
1. Apply `envAllowlist` during dev-server spawn.
2. Handle absent checkpoint directories gracefully in the design command.
3. Restore `planPageError` parity in root-cause correlation.
4. Move test-only packages from `dependencies` to `devDependencies`.
5. Align analyzer severity thresholds with the documented policy.
6. Validate `--format` values in the report CLI.

### **Code Quality (Low Priority)**
1. Replace the invalid Vitest flag in phase docs.
2. Clarify baseline-comparison outcome wording in `probefn/docs/baselines.md`.

---

## 🧪 **Testing Recommendations**
### **Critical Path Testing**
- Add regression tests for flow file loading with normalized traversal inputs such as `flows/../../.env`.
- Add lifecycle tests that verify detached spawned dev servers fully terminate and free their ports.
- Add analyzer fixtures that separately exercise horizontal and vertical clipping cases.
- Add a CLI invocation test that runs the entrypoint through a relative script path.

### **Security and Environment Testing**
- Add tests that verify only allowlisted environment variables reach spawned dev servers.
- Review the Socket alert in dependency tooling and document the triage outcome in the PR discussion or security workflow.

### **Edge Case Testing**
- Add a design-command test for sessions that have no `checkpoints` directory.
- Add report-command tests for invalid `--format` values.
- Add correlation tests covering both console-error and page-error submit-plan evidence.

---

## 📋 **Summary**
The actionable review signal in this PR is concentrated in `probefn` runtime safety, process lifecycle management, analyzer correctness, and CLI validation. The highest-risk items are the repository escape in flow loading, detached dev-server shutdown behavior, vertical clipping misclassification, and the Socket dependency security alert.

Coverage limitations matter here: cubic reviewed only a subset of files, CodeRabbit skipped detailed review entirely, and Sourcery was unavailable. This report should therefore be treated as a high-signal summary of surfaced issues, not proof that the remaining 198-file change set is free of additional problems.
