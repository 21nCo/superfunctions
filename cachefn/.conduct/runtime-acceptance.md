# Packed CacheFn runtime acceptance

Validation date: 2026-10-15. Local artifacts only; no registry publication or
production deployment occurred. Node.js 20.20.0 was used.

## Isolated dependency graph

Built and packed current local versions of all four packages:

- `@cachefn/core@0.0.2`
- `@cachefn/admin@0.1.0`
- `@superfunctions/admin@0.1.4`
- `@mcpfn/core@0.0.5`

Installed the four tarballs together with `npm install --ignore-scripts --omit=dev`
in `/tmp/sf-cachefn-packed-runtime.BhzBtb`. The consumer lockfile records `file:`
tarball origins for every package above; the admin dependency chain deduplicates
to these local versions, including the changed MCP package rather than a remote
package with the same version number.

The actual installed runtime chain is:

```text
@cachefn/admin 0.1.0
  @cachefn/core 0.0.2 (local tarball, no runtime dependencies)
  @superfunctions/admin 0.1.4 (local tarball)
    @mcpfn/core 0.0.5 (local tarball)
      @modelcontextprotocol/sdk 1.32.1
      fast-uri 3.1.8
      ajv 8.20.0 -> fast-uri 3.1.8 (deduplicated)
```

`npm audit --omit=dev --json` returned **zero vulnerabilities**: zero critical,
high, moderate, low or informational findings. Audit metadata reports 100 total
installed dependencies, 101 production entries including the consumer, and zero
development dependencies. Evidence is retained in the isolated consumer's
`runtime-audit.json`, `package-lock.json`, and local tarballs. The final conditional
core exports were repacked/reinstalled and the zero audit result repeated.

This is a clean consumer runtime audit, not the root workspace audit. Development
tooling and unrelated workspace packages are absent. The fresh install resolves
allowed dependency ranges (including AJV 8.20.0), so it is not proof that every
historical consumer lockfile is clean. Audit results represent the advisory data
available at execution, not a guarantee against undiscovered vulnerabilities.

## Runtime imports and behavior

- ESM imports of all four packages succeeded. A packed CacheFn instance stored
  and retrieved a value; a registered CacheFn admin adapter dispatched an
  authorized key-list operation through the packed shared admin dispatcher.
- CommonJS `require` of the dual-format core and MCP packages succeeded. Packed
  CacheFn CRUD and synchronous memoization smoke checks passed.
- Admin packages are ESM-only by contract; CommonJS admin loading is not claimed.

## TypeScript package contract

The original flat `exports.types` selected ESM declarations for CommonJS callers.
A packed `.cts` consumer failed TS1479 under TypeScript 5.4.5 NodeNext and
TypeScript 5.9.3 Node16 despite working CJS runtime exports.

The export map now pairs `import.types` with `index.d.ts` and `require.types` with
`index.d.cts`. The actual packed package passes `.mts` and `.cts` fixtures under
both NodeNext and Node16 resolution with TypeScript **5.4.5 and 5.9.3**. Fixtures
verify schema-specific read inference and rejection of wrong values/unknown keys.
ESM and CommonJS runtime smoke checks pass against each isolated packed consumer.

Reproduce the default-compiler acceptance from the repository:

```bash
npm run test:package --workspace @cachefn/core
```

To exercise another installed compiler after building:

```bash
node cachefn/typescript/scripts/packed-consumer.mjs /absolute/path/to/typescript/bin/tsc
```

The script packs the actual artifact, installs only that core tarball in an
isolated temporary project, checks both module modes and runtime import paths,
and removes its temporary project afterward. It does not modify repository
manifests or lockfiles. The manually retained four-package runtime-audit consumer
is separate from these automatically cleaned typing consumers.
