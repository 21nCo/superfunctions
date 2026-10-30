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
    Menu("Options") { Button("Rename") {} }.menuStyle(.uifn)
    UIFnMenuPicker("Sort", selection: $sort, options: Sort.allCases) { Text($0.title) }
    UIFnSegmentedPicker("Range", selection: $period, options: Period.allCases) { Text($0.title) }
    UIFnSegmentedPicker("Pane", selection: $pane, options: Pane.allCases, variant: .tabs) { Text($0.title) }
    ProgressView(value: 0.4) { Text("Upload") }.progressViewStyle(.uifnLinear)
    ProgressView().progressViewStyle(.uifnCircular)
    Gauge(value: used, in: 0...capacity) { Text("Storage") }.gaugeStyle(.uifnLinear)
    Gauge(value: level) { Text("Battery") } currentValueLabel: { Text("\(Int(level * 100))") }.gaugeStyle(.uifnCircular)
}
.uifnTheme(.brand) // optional; the styles use UIFnTheme.uifn otherwise
```

- The styles read the theme from the `uifnTheme` environment value and resolve colors for light, dark and increased contrast. On macOS they draw the theme's sRGB values where `uifnDisplayGamut` is `.sRGB`, for example under `uifnDisplayGamutFromWindow()`.
- Text uses the theme's type sizes and the `uifnFontFamily` environment value. On iOS, text and control metrics scale with Dynamic Type; macOS has no Dynamic Type, so there they keep the theme's points.
- Pressed controls take a faint tint of the primary text color (buttons also shrink slightly), disabled controls fade, and focused controls draw a two-point accent ring outside the control.
- The styles change only how controls look. Buttons keep their action and role (`.uifnDestructive` is a look; pass `role: .destructive` for the semantics). Toggle styles flip the binding through a button and present a toggle to accessibility that is off, on or mixed like the styled toggle; the switch takes presses on its track and the checkbox on its whole row. Like the system styles, both draw no label under `labelsHidden()` (and, from iOS 18 and macOS 15, `labelsVisibility(.hidden)`) and keep it for accessibility. Text fields keep the system's editing and focus; a click or tap in their padding focuses them, as on a system field's border.
- The menu style draws only the menu's label, with a chevron that `menuIndicator(.hidden)` leaves out; the items, how the menu opens and its keyboard behavior stay the system's.
- SwiftUI has no public way to write a picker style, so the pickers are views. `UIFnMenuPicker` is a `.uifn` menu around a system `Picker` of the options; its label shows the selected option, or the picker's label in the muted color when nothing is selected. `UIFnSegmentedPicker` draws one segment per option, raised in a sunken track (`.segmented`) or underlined over a rule (`.tabs`, for a tab switcher), and accessibility sees a system segmented `Picker` in its place. Its segments share the width offered equally; under `fixedSize()` each is as wide as the widest. On macOS it takes focus as one control and the left and right arrows select the neighboring option in the layout's reading direction, stopping at the ends. Both pickers leave out options that repeat an earlier one.
- Progress views and gauges fill with the accent color over its subtle tone, as a bar (`.uifnLinear`) or a ring (`.uifnCircular`); values outside the range draw as the nearer end. Indeterminate progress runs a segment along the bar or spins an arc; under Reduce Motion it fades in place instead. Accessibility sees a system progress view or gauge with the same value and labels.

## Snapshot tests

`UIFnSwiftUITests` renders each style variant with `ImageRenderer` in light and dark at three Dynamic Type sizes and compares the result with the PNGs in `Tests/UIFnSwiftUITests/__Snapshots__`. Text renders in the box-glyph `UIFn Test Sans` test font, whose outlines and metrics do not change between OS releases. A snapshot passes when at most 0.5% of its pixels differ by more than 8/255 in a channel.

- References are recorded on macOS. On iOS the tests check that the styles change with the color scheme and grow with Dynamic Type instead. UIKit draws iOS menus, which `ImageRenderer` cannot, so on iOS the menu subjects draw the label the menu style gives a menu.
- `ImageRenderer` cannot draw platform text fields, so the text field snapshots draw the style around a `Text`. Indeterminate progress draws the moment it renders, so its snapshots draw the style at a fixed point in its cycle.
- Hosted-window tests on macOS check the segmented picker's arrow keys, clicks and focus ring with real key and mouse events.
- Record or update references with `UIFN_RECORD_SNAPSHOTS=1 swift test --filter UIFnControlStyleSnapshotTests`, then review the PNGs. A missing reference is recorded and fails the test.
- On a mismatch the rendered image is written under its snapshot name (for example `macOS/button-primary-light.png`) to `$UIFN_SNAPSHOT_ARTIFACTS`, or `uifn-snapshots` in the temporary directory. The Swift workflow uploads them as the `uifn-snapshot-failures` artifact.
