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
no primitive maps. It also checks the SwiftUI status lists against
`swiftui-surface-inventory.json`, the public UIFnSwiftUI declarations under
`uifn/swift/Sources/UIFnSwiftUI/Styles` and `Components`, subdirectories
included, as the Swift compiler reports them. The check fails closed: every
declaration in the inventory has to be listed, either as a surface with its
kind and file or, in `nonSurfaces`, with a reason, and a list entry the
inventory does not have, or with the wrong kind or file, fails too.

`node scripts/uifn-swiftui-inventory.mjs --write` (macOS with Xcode) rebuilds
the inventory: it builds UIFnSwiftUI for macOS and for the iOS simulator with
`-emit-symbol-graph`, so a declaration in either platform's `#if` branch
counts, and reads the graphs with `src/swiftui-symbol-graph.mjs`. Without
`--write` it fails when the committed inventory differs; the Swift workflow's
macOS job runs that check. The compiler has already resolved comments, `#if`,
access, nesting and conformances, implied ones included. A declaration is a
public struct, class or actor at any nesting depth, listed by its qualified
name such as `UIFnTimeline.Row`; an enum that is a style or component; a
top-level function, variable or type alias; or a member of an extension of
another module's type, listed by name for `View` (`uifnToast`) and by type and
name otherwise (`EnvironmentValues.uifnTheme`). A member of an extension
constrained to `Self ==` a UIFnSwiftUI type, such as `ButtonStyle.uifnPrimary`,
belongs to that type. A conformance to a SwiftUI protocol whose name ends in
`Style` makes a style; one to `View` or `ViewModifier`, which a `Shape`, a view
representable or a protocol refining `View` implies, makes a component, as
does a `View`-extension member in `Components`. Anything else (a value type, a
`Layout`, a top-level function) is a non-surface. One declaration repeated
with the same kind and file, as overloads and `#if` alternatives are, is
listed once. A list entry's id is an ASCII Swift name and its file path uses
letters, digits and `+`; a declared name or path the lists cannot hold fails.
The tests read symbol graphs that `fixtures/swiftui-symbol-graph/regenerate.mjs`
emits from the Swift files beside it.

`npm test` in this package runs the verifier and its tests; turbo hashes these
scripts as its inputs. The Swift workflow runs on every change under
`uifn/swift`: its macOS job fails until the inventory is regenerated, and its
Linux job runs the verifier, so a new or renamed style or component fails CI
until it is listed and mapped here.
