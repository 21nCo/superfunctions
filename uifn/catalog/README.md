# `@uifn/catalog`

Private, versioned definition compiler for the 69-primitive uifn 1.0 catalog.

`src/catalog-source.mjs` is the canonical source. It records identity, anatomy,
inputs, events, states, controlled and form semantics, DOM service ownership,
accessibility requirements, React/Svelte/Solid targets, vectors, docs, stories,
release ownership, and exceptions. `generated/` is entirely mechanical output.

`src/swiftui-status.mjs` records, for each primitive, what a SwiftUI app uses
for it: `native` (a SwiftUI control or modifier as the system draws it),
`uifn-style` (a SwiftUI control drawn with a UIFnSwiftUI style),
`uifn-component` (a UIFnSwiftUI view or modifier) or `none`. Each entry names
the SwiftUI `controls` and UIFnSwiftUI `surfaces` involved and has a `note`. It
also lists every public UIFnSwiftUI style and component. The compiler writes it
to `generated/swiftui-status.json`, under each primitive's `swiftui` field. It is
kept out of `catalog-source.mjs` so that SwiftUI changes leave the catalog's
`sourceSha256` and `catalogSha256`, which adapter evidence and the signed
registry pin, as they are.

The generated files are requirement and target metadata only. They do not prove
that controllers, adapters, components, stories, docs, accessibility reviews, or
registry/source-install payloads have been implemented.

From the repository root:

```sh
npm run generate:uifn-catalog
npm run verify:uifn-catalog
node --test scripts/verify-uifn-catalog.test.mjs
```

The verifier compiles twice, requires byte-identical results, checks the checked-in
directory for drift, and executes positive and negative CAT-001 vectors. It
rejects a primitive with a missing or unknown SwiftUI status, a status that does
not match its controls and surfaces, and a UIFnSwiftUI style or component that
no primitive maps. It also reads `uifn/swift/Sources/UIFnSwiftUI/Styles` and
`Components` and fails when a public style (a struct conforming to a SwiftUI
style protocol or to `View`) or component (a `View` struct, or a function in a
`public extension View`) is missing from the list, or the list names one the
sources do not declare. `npm test` in this package runs the verifier and its
tests.
