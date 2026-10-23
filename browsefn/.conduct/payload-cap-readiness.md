# BrowseFn payload-cap checkpoint — 2026-10-23

Browser-rendered HTML and formatted content have independent 10 MiB UTF-8 limits. HTML is checked before selectors, metadata parsing and screenshot capture; formatted output is checked before returning to the cache layer. The browser protocol response has already been allocated by page.content(), so this is not a bound on peak browser/host memory.

TypeScript and Python HTTP routers reject screenshots whose base64 representation exceeds 10 MiB, returning DOWNLOAD_TOO_LARGE / HTTP 413. Raw bytes are checked using encoded length before allocating base64. Existing encoded strings are measured in UTF-8. Exact raw boundary 7,864,320 bytes is accepted; one byte more is rejected.

Image downloads, local watermark reads and transformed output default to 25 MiB in both SDKs. Transform inputs are checked before decoding. Explicit maxPayloadBytes still overrides the default. Transport limits remain five redirects and a 30-second network deadline. Pixel limits remain separate; intermediate decoded image allocations are not bounded by encoded output size.

## Validation

- 183 TypeScript SDK tests and 24 admin tests pass; SDK/admin typechecks and builds pass.
- 123 Python tests pass, including actual HTTP transfer boundaries and router serialization checks.
- 18 actual Docker browser cases pass using browsefn-isolation-acceptance:20261023. A tiny document expands its DOM beyond 10 MiB using JavaScript and is rejected with DOWNLOAD_TOO_LARGE; owned worker removal is checked.
- Boundary tests cover exact screenshot acceptance, overflow rejection before base64 allocation, preencoded UTF-8 overflow, formatter expansion, declared/chunked download overflow and predecode image limits.

Logs retained locally at /tmp/browse-cap-{full-tests,types,build,python,native}.log. This validates local code and provisioned worker behavior, not live paid providers or deployment.

## Still open

Global maxResponseBytes/maxDownloadBytes/maxRedirects configuration is unimplemented. Browser redirects use engine limits. Browser protocol allocations precede the rendered-document check. Screenshot capture itself precedes router serialization checks. Browser hostname rules remain fail-closed pending encrypted cross-origin connection enforcement. Host-crash reconciliation, global admission and full original production readiness remain incomplete.
