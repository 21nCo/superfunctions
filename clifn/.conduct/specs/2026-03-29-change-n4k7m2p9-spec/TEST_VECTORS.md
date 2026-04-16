# TV-PKG-001

- Vector ID: `TV-PKG-001`
- Description: `clifn` remains a single package with additive public exports.
- Input:

```json
{
  "packagePath": "clifn/core",
  "packageName": "clifn",
  "newSubpaths": ["output", "runner", "config-loader", "env", "diagnostics", "exec", "scaffold"]
}
```

- Expected output:

```json
{
  "packageName": "clifn",
  "singlePackage": true,
  "subpathsAdded": true
}
```

- Negative variant(s):
  - Input: a second published package `@superfunctions/clifn-core` is introduced for the same spec scope.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_RUNNER_FAILED", "message": "clifn spec requires a single-package implementation in clifn/core." }
}
```

# TV-COMP-001

- Vector ID: `TV-COMP-001`
- Description: Existing subpaths remain available after new modules are added.
- Input:

```json
{
  "imports": [
    "clifn/credentials",
    "clifn/config",
    "clifn/client",
    "clifn/ui",
    "clifn/stdio",
    "clifn/prompt"
  ]
}
```

- Expected output:

```json
{
  "allResolved": true
}
```

- Negative variant(s):
  - Input: `clifn/ui` is removed in favor of only `clifn/output`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_INVALID_CONFIG", "message": "Legacy subpath removed: clifn/ui" }
}
```

# TV-OUT-001

- Vector ID: `TV-OUT-001`
- Description: Output service supports deterministic text and JSON modes.
- Input:

```json
{
  "mode": "json",
  "value": { "ok": true, "message": "done" }
}
```

- Expected output:

```json
{
  "stdout": "{\"ok\":true,\"message\":\"done\"}\n"
}
```

- Negative variant(s):
  - Input: text mode table output derives column order from object key iteration rather than declared columns.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_RUNNER_FAILED", "message": "Output table column order was not deterministic." }
}
```

# TV-RUN-001

- Vector ID: `TV-RUN-001`
- Description: `runAction()` provides a parser-agnostic execution context and returns success.
- Input:

```json
{
  "actionOptions": { "name": "world" },
  "runnerOptions": { "cwd": "repo root", "mode": "text" }
}
```

- Expected output:

```json
{
  "exitCode": 0,
  "contextKeys": ["cwd", "env", "output", "diagnostics", "exec", "scaffold", "nonInteractive"]
}
```

- Negative variant(s):
  - Input: runner requires a `commander.Command` instance in order to execute an action.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_RUNNER_FAILED", "message": "Runner must remain parser-agnostic." }
}
```

# TV-RUN-002

- Vector ID: `TV-RUN-002`
- Description: Uncaught errors normalize into deterministic exit behavior.
- Input:

```json
{
  "action": "throws Error('boom')"
}
```

- Expected output:

```json
{
  "exitCode": 1,
  "stderrContains": "boom"
}
```

- Negative variant(s):
  - Input: JSON mode action emits human-readable banner lines around the JSON payload.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_RUNNER_FAILED", "message": "Machine-readable mode emitted extra human-readable output." }
}
```

# TV-CFG-001

- Vector ID: `TV-CFG-001`
- Description: Config loader discovers TS config and validates it.
- Input:

```json
{
  "candidates": ["tool.config.ts", "tool.config.js"],
  "validate": "value => value"
}
```

- Expected output:

```json
{
  "path": "tool.config.ts",
  "loaded": true
}
```

- Negative variant(s):
  - Input: explicit config path `https://example.com/tool.config.ts`
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_CONFIG_NOT_FOUND", "message": "Remote config URLs are not supported." }
}
```

# TV-ENV-001

- Vector ID: `TV-ENV-001`
- Description: Env readers enforce required presence and numeric bounds.
- Input:

```json
{
  "env": {
    "PORT": "3000",
    "VERBOSE": "true",
    "TOKEN": "abc123"
  }
}
```

- Expected output:

```json
{
  "port": 3000,
  "verbose": true,
  "token": "abc123"
}
```

- Negative variant(s):
  - Input: `PORT = "hello"`
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_ENV_INVALID", "message": "PORT must be an integer" }
}
```

# TV-DIAG-001

- Vector ID: `TV-DIAG-001`
- Description: Diagnostics are sorted, redacted, and serializable.
- Input:

```json
[
  { "code": "B", "severity": "warning", "message": "b", "details": { "token": "secret" } },
  { "code": "A", "severity": "error", "message": "a", "details": { "path": "x" } }
]
```

- Expected output:

```json
{
  "diagnostics": [
    { "code": "A", "severity": "error", "message": "a", "details": { "path": "x" } },
    { "code": "B", "severity": "warning", "message": "b", "details": { "token": "[REDACTED]" } }
  ]
}
```

- Negative variant(s):
  - Input: formatter serializes sensitive header `Authorization: Bearer secret` verbatim.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_DIAGNOSTIC_SERIALIZATION", "message": "Sensitive diagnostic detail was not redacted." }
}
```

# TV-EXEC-001

- Vector ID: `TV-EXEC-001`
- Description: Exec helper captures output and timing deterministically.
- Input:

```json
{
  "file": "node",
  "args": ["-e", "console.log('hi')"]
}
```

- Expected output:

```json
{
  "exitCode": 0,
  "stdout": "hi\n",
  "stderr": "",
  "timedOut": false
}
```

- Negative variant(s):
  - Input: command sleeps longer than configured timeout.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_EXEC_TIMEOUT", "message": "Command timed out after 10 ms." }
}
```

# TV-FS-001

- Vector ID: `TV-FS-001`
- Description: Scaffold helper applies deterministic file operations.
- Input:

```json
{
  "operations": [
    { "kind": "mkdir", "path": "src" },
    { "kind": "write-file", "path": "src/index.ts", "content": "export {}\\n", "ifExists": "error" }
  ]
}
```

- Expected output:

```json
{
  "written": ["src/index.ts"],
  "skipped": []
}
```

- Negative variant(s):
  - Input: `path = "../outside.txt"`
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_SCAFFOLD_INVALID_PATH", "message": "Scaffold path escapes the configured working directory." }
}
```

# TV-PARS-001

- Vector ID: `TV-PARS-001`
- Description: Compatibility patterns work for commander, cac, and raw parseArgs without forcing one parser.
- Input:

```json
{
  "parsers": ["commander", "cac", "parseArgs"]
}
```

- Expected output:

```json
{
  "allSupported": true
}
```

- Negative variant(s):
  - Input: `clifn` adds `commander` as a required runtime dependency for all consumers.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_INVALID_CONFIG", "message": "Parser-specific runtime dependency leaked into parser-agnostic clifn core." }
}
```

# TV-SEC-001

- Vector ID: `TV-SEC-001`
- Description: Generic helpers redact sensitive data and fail safely in unsafe contexts.
- Input:

```json
{
  "diagnostic": {
    "code": "AUTH_FAIL",
    "severity": "error",
    "message": "request failed",
    "details": {
      "Authorization": "Bearer secret",
      "token": "abc",
      "path": "src/index.ts"
    }
  },
  "nonInteractive": true,
  "promptRequired": true
}
```

- Expected output:

```json
{
  "redacted": {
    "Authorization": "[REDACTED]",
    "token": "[REDACTED]",
    "path": "src/index.ts"
  },
  "promptFailureCode": "CLIFN_PROMPT_INPUT_ERROR"
}
```

- Negative variant(s):
  - Input: config loader fetches and executes a remote URL.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_CONFIG_NOT_FOUND", "message": "Remote config URLs are not supported." }
}
```

# TV-OBS-001

- Vector ID: `TV-OBS-001`
- Description: Generic helpers are easy to observe and test.
- Input:

```json
{
  "stdoutInjected": true,
  "stderrInjected": true,
  "verbose": true
}
```

- Expected output:

```json
{
  "capturedMessages": true,
  "debugVisible": true,
  "execDurationPresent": true
}
```

- Negative variant(s):
  - Input: helper writes directly to process streams with no injection path in tests.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_RUNNER_FAILED", "message": "Helper does not support deterministic injected output for tests." }
}
```

# TV-ADOPT-001

- Vector ID: `TV-ADOPT-001`
- Description: Adoption docs separate generic `clifn` concerns from product-owned CLI logic and explicitly cover extfn.
- Input:

```json
{
  "targetClis": ["extfn", "apifn", "packages/cli", "hostfn", "recfn"]
}
```

- Expected output:

```json
{
  "docsPresent": true,
  "extfnGenericConcerns": ["runner", "output", "diagnostics", "config-loader", "env", "exec", "scaffold"],
  "extfnOwnedConcerns": ["vite", "browser-launch", "scan-rules", "package-archives"]
}
```

- Negative variant(s):
  - Input: docs instruct `extfn` to move browser launch or MV3 scan rules into `clifn`.
  - Expected error:

```json
{
  "ok": false,
  "error": { "code": "CLIFN_INVALID_CONFIG", "message": "Product-specific extfn behavior was assigned to generic clifn scope." }
}
```

