# Configuration

ReviewFn uses versioned JSON files at `.reviewfn/config.json` and `.reviewfn/policy.json`. Unknown adapters fail preflight. Secret values never belong in either file; `credentialEnv` names an environment variable without recording its value.

In GitHub Actions, pass `--trusted-config-from-base`. ReviewFn reads both files using `git show BASE:path`, so a pull request cannot weaken the policy controlling its own review.

A review panel adds `.reviewfn/panel.json`, which `reviewfn init --panel` writes as a template. `reviewfn panel` reads it (or the repository-relative path given by `--panel FILE`) with `loadPanelPolicy`, which trusts the base revision's copy in GitHub Actions or with `--trusted-config-from-base` and accepts a head copy only if it tightens that copy; see [Panel review](panel.md) and [Panel orchestration](panel-report-schema.md#panel-orchestration). The GitHub Action does not run a panel.

The configuration selects the profile, harness, inference provider/model/auth, context adapters, approved argv test commands, outputs and retention. Commands are argv arrays and never pass through a shell. Profiles contain 1–80 letters, digits, underscores or hyphens so accepted configurations remain publishable. Optional context identities must be nonempty strings when present.

`composio-linear` requires:

- `account`: explicit Composio account alias, word ID, or connected-account ID;
- `expectedWorkspace`: expected Linear organization/team identity;
- `issue`: key such as `ENG-123`.

`repository-markdown` accepts exact repository-relative paths or `**/*.md` suffix patterns. Traversal and symlink escapes are refused.

`code-references` takes no options. It gives every slot one source, `code-references:map`, of type `other`: a bounded, deterministic JSON map of the code around the change at the head commit, built from the captured change hunks:

- `symbols`: names declared on added or modified head lines, for a closed set of languages and forms. TypeScript and JavaScript (`.ts .tsx .js .jsx .mjs .cjs`): `function`, `class`, `interface`, `type`, `enum`, exported `const` and `let`, and object and class method names. Python: `def`, `class`. Swift: `func`, `class`, `struct`, `enum`, `protocol`, `extension`. Go: `func` (including methods) and `type`. Rust: `fn`, `struct`, `enum`, `trait` and the `impl` target. Recognition is one line at a time; other languages contribute their paths only.
- `references`: each symbol's whole-word, fixed-string matches (`git grep -n -w -F`) over the files tracked at head. They are textual, so a same-named word in a comment is listed too. Type-aware reference resolution is deferred to REV-9 and is not claimed.
- `testFiles`: tracked files at the conventional test paths of a changed `<dir>/<name>.<ext>`: `<dir>/<name>.test.<ext>`, `<dir>/<name>.spec.<ext>`, `<dir>/__tests__/<name>.<ext>`, `test/**/<name>.test.<ext>`, `tests/**/test_<name>.py` and `Tests/**/<Name>Tests.swift`. The `test/`, `tests/` and `Tests/` directories count at the repository root and in every ancestor directory of the changed file.
- `pairedFiles`: tracked files that the panel policy's `contextPairs` rules pair with changed files (see the [panel report schema](panel-report-schema.md)). No pairs ship by default.
- `documents`: Markdown files (`.md`, `.markdown`, `.mdx`) that mention a changed symbol as a whole word or a changed path.

Every file the adapter reads symbols from, and every reference, test, paired file and document it lists, skips the panel policy's `contextExcludeGlobs`, which default to `**/node_modules/**`, `**/dist/**`, `**/*.min.js`, `**/vendor/**` and the common lockfiles. The map holds at most 60 symbols, 30 references per symbol and 400 KB (or the context `maxBytes`, if smaller); reference lines are cut to 240 characters. Each cut is recorded in the manifest's `incompleteReasons`. The source is review context only: it is never a requirement or waiver authority, the prompt does not list it among the authoritative sources, and source-authority validation ignores it even when a policy accepts the `other` type. Panel slot prompts carry it as `codeReferences`; the single-harness review prompt does not.

Fallback entries are provenance only. ReviewFn never selects one automatically; an operator must explicitly rerun a compatible configuration.

Version 0.1 accepts only `advisory` output mode. Both configuration and policy validation reject `gate`; required-check behavior needs a later, separately calibrated and authorized release.

PR inference requires a trusted Docker image and action-proxy authentication with an explicit model. Local API-key and ChatGPT modes are restricted to trusted repositories. `local-isolated` names the mandatory Docker execution adapter; other adapter names fail preflight. Test commands use container paths such as `node`, not a host-specific executable path. See the security model for fixed resource bounds. `retainTranscript` is false unless explicitly enabled. Normalized events retain only bounded telemetry counters, never message, reasoning or tool-output payloads; content-bearing JSONL belongs to the separately retained opt-in transcript.

Linear comment and document connection requests share a request budget equal to the configured context source limit. Empty pages consume that budget; exhaustion records incomplete context. The prompt lists policy-authorized source IDs explicitly, excluding comments when their authority is disabled.
