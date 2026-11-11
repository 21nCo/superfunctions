# `@uifn/catalog`

Private, versioned definition compiler for the 69-primitive uifn 1.0 catalog.

`src/catalog-source.mjs` is the canonical source. It records identity, anatomy,
inputs, events, states, controlled and form semantics, DOM service ownership,
accessibility requirements, React/Svelte/Solid targets, vectors, docs, stories,
release ownership, and exceptions. `generated/` is entirely mechanical output.

`src/swiftui-status.mjs` records, for each primitive, what a SwiftUI app uses
for it: `native` (a SwiftUI control or modifier as the system draws it),
`uifn-style` (a SwiftUI control drawn with a UIFnSwiftUI style, a type that
conforms to a SwiftUI style protocol such as `ButtonStyle`), `uifn-component` (a
UIFnSwiftUI view or view modifier, including a view that stands in for a system
control, such as `UIFnSegmentedPicker`) or `none`. Each entry names
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
no primitive maps. It also reads every Swift file under
`uifn/swift/Sources/UIFnSwiftUI/Styles` and `Components`, subdirectories
included, and fails when the list misses a public style or component, names
one the sources do not declare, or gives one the wrong kind or file. A surface's
kind follows its declaration, not its directory: a public struct conforming to a
SwiftUI style protocol (a name ending in `Style`) is a style; a public struct
conforming to `View`, `ViewModifier`, `Shape`, `InsettableShape` or a UIKit or
AppKit view or view controller representable is a component; in `Components`, a public
function in an extension of `View` is a component. A conformance counts in the
declaration or in an extension in either directory, and a nested public struct
counts by its own name. Classes, enums, protocols and `View`-extension functions
in `Styles` (such as `uifnTheme`) are not surfaces.

`npm test` in this package runs the verifier and its tests; turbo hashes the
UIFnSwiftUI sources and these scripts as its inputs. The Swift workflow's Linux
job also runs the verifier on every change under `uifn/swift`, so a new or
renamed style or component fails CI until it is listed and mapped here.
