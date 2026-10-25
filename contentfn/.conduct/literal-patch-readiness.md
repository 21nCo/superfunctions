# Literal patch paths

The patch API accepts explicit string-segment arrays in addition to existing dotted strings. Arrays preserve literal field names, including dots, while strings retain their existing grammar. Empty and prototype-mutating segments remain invalid; system-field denial uses the first decoded segment. Public invocation detaches the operation/path arrays before asynchronous authorization and storage.

Event and webhook `changedPaths` remain strings. Representable segment arrays keep legacy dotted paths; literal segments use JSON-array string encoding. Older producers reject the new input form, so deploy this producer prerequisite before clients that emit literal paths. There is no ContentFn Python implementation in this checkout.

## Reproduction and validation

The exact prior core source at `3f5aa26fa` rejected `['literal.key']` with `PATCH_INVALID` / `Path must be a string` (`/tmp/content-literal-baseline.log`). The CMS editor independently reproduced two failed save-generation cases before its correction.

Four focused cases pass, including actual HTTP requests, all operation families, reserved/prototype denial, revision conflicts, and native SQLite reopen. The SQLite case holds authorization, mutates the caller's path array, and verifies that the original validated field and event metadata are persisted. Log: `/tmp/content-literal-focused-node22-threads.log`.

Initial Node 20 native execution failed before SQLite assertions because the installed binding was built for Node 22. That environment failure is retained in `/tmp/content-literal-focused-final.log`; the explicit Node 22 thread-pool run passes. No test assertion or timeout was relaxed.

Full tests passed on Node 22.22.1: core 21, server 216 (2 intentional skips), client 5. Commands ran each package's Vitest suite with `--pool=threads`; log `/tmp/content-literal-full.log`. That command's subsequent build invocation failed because no local Turbo executable was installed. The first dependency-expanded retry also selected unrelated Probe development typechecks with missing sparse-checkout declarations. Both failures remain recorded; no changed Content checks were removed.

The corrected command `turbo run typecheck build --filter=@contentfn/core --filter=@contentfn/server --filter=@contentfn/client --filter=@contentfn/cli` passed all 19 tasks, including normal dependency builds, using installed Turbo 2.8.16. Log: `/tmp/content-literal-scoped-build.log`.

`PATH=/opt/homebrew/opt/node@20/bin:$PATH CONTENTFN_NPM_CLI=/Users/serro/.npm/_npx/04c1df8cf750d1fc/node_modules/npm/bin/npm-cli.js python3 contentfn/.conduct/literal-paths-packed.py` passed on Node 20.20.0 with normal npm 11 installation. The 12 built tarballs exercised actual HTTP/client/CLI calls, ESM/CJS, strict installed declarations, literal and nested paths, empty objects, unset, reserved/prototype denial, and revision fencing. Production audit: zero vulnerabilities. The exact owned consumer was removed and absence checked. Log: `/tmp/content-literal-packed.log`.

This consumer does not cover the unrelated admin/MCP dependency graph or deployed providers. CMS native Safari remains a separate acceptance gap; this prerequisite does not claim whole-product readiness.
