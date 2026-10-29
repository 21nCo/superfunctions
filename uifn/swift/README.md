# UIFnSwiftUI

SwiftUI styles drawn with uifn theme tokens. Generate a theme's tokens with `uifn-swift-tokens` (see `uifn/tokens/README.md`); `UIFnTheme.uifn` is the default theme.

## Control styles

```swift
VStack {
    Button("Save") {}.buttonStyle(.uifnPrimary)
    Button("Cancel") {}.buttonStyle(.uifnSecondary)
    Button("More") {}.buttonStyle(.uifnGhost)
    Button("Delete", role: .destructive) {}.buttonStyle(.uifnDestructive)
    Toggle("Alerts", isOn: $alerts).toggleStyle(.uifnSwitch)
    Toggle("Remember me", isOn: $remember).toggleStyle(.uifnCheckbox)
    TextField("Name", text: $name).textFieldStyle(.uifn)
    GroupBox("Account") { Text("Signed in") }.groupBoxStyle(.uifn)
}
.uifnTheme(.brand) // optional; the styles use UIFnTheme.uifn otherwise
```

- The styles read the theme from the `uifnTheme` environment value and resolve colors for light, dark and increased contrast. On macOS they draw the theme's sRGB values where `uifnDisplayGamut` is `.sRGB`, for example under `uifnDisplayGamutFromWindow()`.
- Text uses the theme's type sizes and the `uifnFontFamily` environment value. On iOS, text and control metrics scale with Dynamic Type; macOS has no Dynamic Type, so there they keep the theme's points.
- Pressed controls take a faint tint of the primary text color (buttons also shrink slightly), disabled controls fade, and focused controls draw a two-point accent ring outside the control.
- The styles change only how controls look. Buttons keep their action and role (`.uifnDestructive` is a look; pass `role: .destructive` for the semantics). Toggle styles flip the binding through a button and present a toggle to accessibility that is off, on or mixed like the styled toggle; the switch takes presses on its track and the checkbox on its whole row. Like the system styles, both draw no label under `labelsHidden()` or `labelsVisibility(.hidden)` and keep it for accessibility; styles can tell only on iOS 18, macOS 15 and later, so on earlier versions pass an empty label to hide it. Text fields keep the system's editing and focus; a click or tap in their padding focuses them, as on a system field's border.

## Snapshot tests

`UIFnSwiftUITests` renders each style variant with `ImageRenderer` in light and dark at three Dynamic Type sizes and compares the result with the PNGs in `Tests/UIFnSwiftUITests/__Snapshots__`. Text renders in the box-glyph `UIFn Test Sans` test font, whose outlines and metrics do not change between OS releases. A snapshot passes when at most 0.5% of its pixels differ by more than 8/255 in a channel.

- References are recorded on macOS. On iOS the tests check that the styles change with the color scheme and grow with Dynamic Type instead.
- `ImageRenderer` cannot draw platform text fields, so the text field snapshots draw the style around a `Text`.
- Record or update references with `UIFN_RECORD_SNAPSHOTS=1 swift test --filter UIFnControlStyleSnapshotTests`, then review the PNGs. A missing reference is recorded and fails the test.
- On a mismatch the rendered image is written under its snapshot name (for example `macOS/button-primary-light.png`) to `$UIFN_SNAPSHOT_ARTIFACTS`, or `uifn-snapshots` in the temporary directory. The Swift workflow uploads them as the `uifn-snapshot-failures` artifact.
