# MDFN-01 Delivery Contract

## Packages

The stable graph contains core, markdown, render, extensions, DOM, source, adapter-kit, three framework adapters, neutral/framework components, testing, registry, and facade packages. Optional packages contain collaboration, client/server, and ecosystem bridges. Every public package declares exports, types, files, license, engine range, repository directory, publish access, layer/status metadata, build/test/typecheck/prepack scripts, and exact internal dependencies.

## Compatibility and versioning

The source snapshot format and extension schema are versioned independently of npm packages. Minor releases may add node types behind extensions or additive API fields. Changes to canonical serialization, transaction meaning, snapshot format, or extension hooks require a migration and a major release. Framework peer ranges are explicit.

## Publication

Publication is dependency-safe: neutral foundation before browser, adapters, components, facade, and optional packages. Release inventory rows are mandatory. Packed artifacts must install without monorepo-only paths, undeclared dependencies, or cross-framework imports.

## Ecosystem rollout

DocsFn uses mdfn as its canonical syntax pass while retaining documentation-specific render-model projection. ContentFn adds an explicit `markdown` field kind and validates it with the mdfn parser. CmsFn Studio selects the mdfn editor for that kind. SearchFn consumes deterministic render extraction. Existing rich-text data remains supported; migration is opt-in and source-preserving.

## Governance

The approved contracts in this directory are normative. `package-graph.json` and verification scripts enforce the machine-checkable subset. Product behavior changes update the contract, fixtures, and gates in the same change.
