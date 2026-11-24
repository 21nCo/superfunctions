# @superfunctions/reviewfn-harness-cli

Generic agent-CLI harness adapter for ReviewFn panel slots. It runs any agent CLI that can read a prompt and write one JSON object, as declared by a profile in the trusted panel policy. Adding a CLI takes configuration only, with no adapter code.

```ts
import { CliHarnessAdapter } from "@superfunctions/reviewfn-harness-cli";

const harness = new CliHarnessAdapter(); // capabilities.id "cli", adapter contract version "1"
```

The `reviewfn panel` command loads this package for every slot whose `harness.adapter` is `cli`.

## Configuration

A slot names its executable and a profile. The profile itself lives in the panel policy's `profiles`:

```json
{
  "version": 1,
  "slots": [
    { "id": "gemini", "stage": 1, "lens": "general",
      "harness": { "adapter": "cli", "version": "0.9.0", "executable": "gemini", "profile": "gemini" },
      "inference": { "provider": "google", "model": "gemini-2.5-pro", "auth": "api-key", "credentialEnv": "GEMINI_API_KEY" },
      "budget": { "timeoutMs": 900000, "maxOutputBytes": 4000000 } }
  ],
  "profiles": {
    "gemini": {
      "argv": ["--model", "{model}"],
      "promptVia": "stdin",
      "outputVia": "stdout-last-json",
      "envAllowlist": ["PATH", "HOME"],
      "modelReport": "none",
      "capabilities": { "structuredOutput": false, "sandbox": "tree-verified-only" }
    }
  },
  "quorum": { "stage1": 1, "stage2": 0 },
  "requirementsSlot": null,
  "incremental": "full"
}
```

| Field | Meaning |
| --- | --- |
| `argv` | Arguments after the executable. An element that is exactly one of `{promptFile}`, `{schemaFile}`, `{outputFile}`, `{workspace}` or `{model}` is replaced by its value as one argument. Nothing else is substituted, and an element that contains a placeholder inside other text is rejected. No shell is ever used. |
| `promptVia` | `stdin`, or `file`, which requires `{promptFile}` in `argv`. |
| `outputVia` | `file`, which requires `{outputFile}` in `argv`, or `stdout-last-json`: the last stdout line that parses as a JSON object. Progress lines before it are ignored. |
| `envAllowlist` | Environment variable names only. The CLI gets exactly these variables, when set, plus the slot's `credentialEnv`. Nothing else is inherited, not even `PATH` or `HOME` unless they are listed. |
| `modelReport` | `none`, `json-path:<dotted path>` in the output object, or `stderr-regex:<regex with exactly one capture group>`. |
| `capabilities` | `structuredOutput` (the CLI enforces the schema itself, so `argv` must include `{schemaFile}`) and `sandbox`: `enforced-read-only` or `tree-verified-only`. |
| `versionArgv` | Optional arguments that print the CLI's version, `["--version"]` by default. Placeholders are not allowed. The first dotted version token, such as `0.9.0`, `2025.08.25-896bbe1` or `1.2.3-rc.1+build.7`, must equal the slot's `harness.version`. An observed version satisfies only the invocation that reported it: the same resolved executable file (path, device, inode, size and times), version arguments and environment, so another profile's environment or a replaced executable is probed again. A version other than the pin fails the slot before the review runs, and the executable's identity is read again just before each attempt starts and after it ends: one found replaced is not started, and an answer from one replaced while its attempt was prepared or ran is refused, with no repair. |

`harness.executable` is an absolute path or a bare command name. A bare name is found on the adapter's `PATH`, in a trusted directory and never inside the repository. A relative path is refused, because it would resolve inside the repository under review. Either form is resolved through every link before the version is read or the CLI runs. It is refused when it lands in the working directory or the review checkout, under a directory that is world-writable or has a world-writable or Git-repository ancestor (the rule bare names follow), or when it is a world-writable file. The resolved path is what runs.

## Trust and limits

- **Trusted profiles only.** Profiles come from the trusted panel policy. A repository copy that adds or changes a profile fails with `REVIEWFN_PANEL_POLICY_WEAKENED`. It may drop an unused one.
- **No shell.** The executable is spawned directly through the shared process-group runner, with the review checkout as its working directory. A placeholder value, even one with spaces or `;`, is always one argument. A model that starts with `-` is refused, so it can never be read as an option.
- **Bounds.** The slot's timeout and output budget cover both attempts. That includes stdout, stderr and the output file, which is read without following links. The output file is also measured while the CLI runs, about every 100 ms, together with the stdout and stderr bytes received so far, so a CLI that keeps appending to it, or whose output file and stdout are each under the budget but together over it, is stopped once they outgrow the remaining budget. An output file measured larger while the first attempt ran than the file it left still counts against the repair. A timeout or an output overrun, on any of these channels, kills the whole process group and ends the slot `timed_out`. An output file found over the budget ends the slot `timed_out` even when the CLI then exited nonzero, before its exit code or any quota message is read. Only a caller's cancellation (`canceled`) comes first, even one that arrives after the CLI exited, while its answer is read. On a cold version cache, a version command that hangs or overruns its own bound also ends the run `timed_out`.
- **Credential redaction.** The credential, and every allowlisted value whose name marks it as a secret (such as `*_TOKEN` or `*_API_KEY`), is redacted from the transcript, events, errors and repair prompt, also where a JSON string escapes any of its characters (a short escape, or `\uXXXX` in either hex case).
- **Local reviews only.** Pull-request reviews are refused, because the adapter enforces no tool restriction of its own (`toolControls: false`).
- **Sandbox.** With `sandbox: "tree-verified-only"`, every run records the `sandbox_tree_verified_only` limitation. Only the panel's comparison of the checkout with head is verified. The adapter claims no tool restriction it cannot enforce. Host-level sandboxing of generic CLI harnesses is deferred to REV-9 and is not claimed here.

## Model reporting

- **`none`.** The run records the `model_unverified` limitation and is not voided. Its identity is only (adapter, version, executable, profile). Two such slots of one executable and profile therefore never count as distinct identities: the second completed run in a stage is `collapsed`, even when the two configure different models.
- **A reporter.** Every model the reporter names must equal the configured model. Any other model voids the slot with `model_mismatch`. The comparison uses the raw reported value. The adapter reports the verdict as `observed.modelMismatch`, and the panel records it as `identity.modelMismatch: true`. So a mismatch still voids the slot when the recorded model, after redaction or the 256-character cut, reads the same as the configured one. A `stderr-regex` reporter runs in a worker thread that starts with the CLI. It is stopped after 2 seconds or at the run's own deadline (`harnessTimeoutMs`), whichever comes first but never sooner than 50 ms after the CLI stops, or 50 ms after the run is aborted (canceled, or stopped at the panel's deadline), so a pattern that backtracks without end cannot block the panel or hold a run past its timeout. It keeps only the first capture, the first that is not the configured model and the last, so overlapping captures cannot grow its memory. Every model it matched before it stopped still counts, so an earlier mismatch still voids the slot. A reporter that cannot finish ends the run `timed_out` (or `canceled`). Models are read from everything an attempt left within its output bounds (stderr, and the output object even after a nonzero exit) before any other outcome, so a CLI that reports another model and then hangs, overruns or fails is still void. An answer that would be accepted must report its own model; if it does not, the run fails as unconfirmed. A completed run records the model its accepted attempt reported. An invalid answer gets its repair attempt whether or not it reported a model. The CLI is shown, in the prompt and in `{schemaFile}`, the slot's schema with the `json-path` field also declared, and required, on every object schema on that path that does not declare it yet, including each object `allOf` branch (an `allOf` entry that is `{}` or `true` is ignored). Where an `additionalProperties` schema owns the key, it is declared as that schema; otherwise, as on an object closed to it (`additionalProperties: false`, or `unevaluatedProperties: false`, with no entry for the key), as a string at the rest of the path. A node where a `patternProperties` pattern matches the key is shown unchanged, because its pattern schema is shared by every sibling key it matches, so there the slot's schema must declare the report field itself. So a CLI that enforces the schema, even one that emits only declared properties, can still report its model. The answer is first validated against the slot's own schema exactly as written, so a report field the schema allows (declared, matched by `patternProperties`, or open to additional properties) is never removed. Only an answer that fails is validated again without the field at the objects that close it (only the objects on the path are copied), and the errors of that copy go to the repair attempt. An accepted answer also drops the field wherever the canonical harness payload closes an object to it, so a report inside a section the payload keeps (an `uninspected` or `evidence` item, say) is never judged as part of the payload. A numeric step indexes an array schema, and since its items share their schemas (its own `items` and those of its `allOf` branches), every item declares the field and may have it removed; an array node that composes otherwise is never changed. Elsewhere a numeric step names a property. A node whose ownership of the key cannot be settled statically (`$ref`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else` or `dependentSchemas`, or `unevaluatedProperties` next to `allOf`) is never changed, and nothing at or below it is removed, so there the slot's schema must declare the report field itself. A reported model is only as trustworthy as whatever writes that field.

## Output validation

The output is validated against the slot's output schema. One bounded repair attempt follows, in a new process with the validation errors and the rejected answer. Every `promptVia` × `outputVia` combination allows this re-run, because each attempt gets a fresh prompt and a fresh output file or stdout. Each attempt gets its own new directory, created exclusively with an unpredictable name after the previous attempt ended, holding its own `{schemaFile}`, its prompt file (written only when the profile passes `{promptFile}`) and its `{outputFile}` path, which is absent when the attempt starts. So nothing the first attempt left (a link, a rewritten schema, a planted answer) is followed, shown to or read for the repair attempt. The repair prompt echoes the rejected answer's own text (the output file or the stdout line), never a re-serialization of it, redacted with the run's secrets as the transcript is and then cut to 16,384 bytes. A second invalid answer ends the slot `malformed`.

## Example profiles

These are **unverified examples**: no live run of these CLIs is recorded yet (REV-20). Flags change between CLI releases, so check each one against the CLI's own help before you use it. No profile ships as a default, so every profile must be declared in your trusted panel policy.

### Cursor agent CLI (unverified example)

```json
"cursor-agent": {
  "argv": ["--print", "--output-format", "text", "--model", "{model}"],
  "promptVia": "stdin", "outputVia": "stdout-last-json",
  "envAllowlist": ["PATH", "HOME", "CURSOR_API_KEY"], "modelReport": "none",
  "capabilities": { "structuredOutput": false, "sandbox": "tree-verified-only" }
}
```

### Factory Droid (unverified example)

```json
"droid": {
  "argv": ["exec", "--model", "{model}", "--file", "{promptFile}"],
  "promptVia": "file", "outputVia": "stdout-last-json",
  "envAllowlist": ["PATH", "HOME", "FACTORY_API_KEY"], "modelReport": "none",
  "capabilities": { "structuredOutput": false, "sandbox": "tree-verified-only" }
}
```

### omp (unverified example)

```json
"omp": {
  "argv": ["--print", "--model", "{model}"],
  "promptVia": "stdin", "outputVia": "stdout-last-json",
  "envAllowlist": ["PATH", "HOME"], "modelReport": "none",
  "capabilities": { "structuredOutput": false, "sandbox": "tree-verified-only" }
}
```

### Gemini CLI (unverified example)

```json
"gemini": {
  "argv": ["--model", "{model}"],
  "promptVia": "stdin", "outputVia": "stdout-last-json",
  "envAllowlist": ["PATH", "HOME", "GEMINI_API_KEY"], "modelReport": "none",
  "capabilities": { "structuredOutput": false, "sandbox": "tree-verified-only" }
}
```

### Kimi CLI (unverified example)

```json
"kimi": {
  "argv": ["--print", "--model", "{model}"],
  "promptVia": "stdin", "outputVia": "stdout-last-json",
  "envAllowlist": ["PATH", "HOME", "MOONSHOT_API_KEY"], "modelReport": "none",
  "capabilities": { "structuredOutput": false, "sandbox": "tree-verified-only" }
}
```

A CLI that prints its served model on stderr can use a reporter instead of `none`, for example `"modelReport": "stderr-regex:model: (\\S+)"`.
