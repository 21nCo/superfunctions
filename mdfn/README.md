# mdfn

mdfn is the Markdown-native authoring platform for Superfunctions. Markdown is
the durable boundary; structured editor state is derived, versioned, and
replaceable.

The package graph separates environment-neutral parsing, transactions, safe
rendering, and extension contracts from browser editing, framework bindings,
UIFn chrome, persistence, collaboration, and ecosystem bridges.

## Guarantees

- No-edit import/export is byte-identical.
- Supported syntax has a semantic round trip.
- Visual edits normalize only the touched top-level source regions whenever
  their source spans remain mappable.
- Unsupported and disabled constructs survive as opaque nodes with
  diagnostics.
- Raw HTML is disabled by default.
- React, Svelte, Solid, and vanilla DOM share the same semantic controller.

See `mdfn/.conduct/MDFN-01` for the normative product, content, architecture,
extension, security, verification, and delivery contracts.
