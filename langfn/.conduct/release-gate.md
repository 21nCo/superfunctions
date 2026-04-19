# LangFn Release Gate

Current release line: `0.1.0`.

Run the LangFn release gate from the repository root:

```bash
npm run gate:langfn-release
```

## What it runs

1. `npm --prefix langfn/typescript run build`
2. `npm --prefix langfn/typescript test`
3. `python3 -m pytest langfn/python/tests -q`
4. TypeScript package import smoke checks against the built `dist/` outputs
5. Python package import smoke checks against `langfn/python`
6. TypeScript HTTP, MCP, observability, and release-gate smoke suites
7. Python HTTP, MCP, observability, and release-gate smoke suites
8. `node scripts/check-duplication.mjs`

## Pass criteria

- every command exits with code `0`
- package imports resolve from the published surfaces
- HTTP, MCP, and observability smoke checks pass in both languages
- the LangFn duplication gate stays under the `5%` threshold
- docs and release artifacts remain portable and contain no machine-specific absolute paths
