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
- SwiftUI has no public way to write a picker style, so the pickers are views. `UIFnMenuPicker` is a `.uifn` menu around a system `Picker` of the options; its label shows the selected option, or the picker's label in the muted color when nothing is selected. `UIFnSegmentedPicker` draws one segment per option, raised in a sunken track (`.segmented`) or underlined over a rule (`.tabs`, for a tab switcher), and accessibility sees a system segmented `Picker` in its place. Its segments share the width offered equally; under `fixedSize()` each is as wide as the widest. On macOS it takes focus as one control, with the accent ring around the selected segment (on macOS 13, which cannot hide the system focus ring, the system ring around the picker instead), and the left and right arrows select the neighboring option in the layout's reading direction, stopping at the ends. Both pickers leave out options that repeat an earlier one.
- Progress views and gauges fill with the accent color over its subtle tone, as a bar (`.uifnLinear`) or a ring (`.uifnCircular`); values outside the range draw as the nearer end. Indeterminate progress runs a segment along the bar or spins an arc; under Reduce Motion it fades in place instead. Accessibility sees a system progress view or gauge with the same value and labels.

## Components

```swift
VStack {
    UIFnSegmentedMeter("Signal", value: Double(bars), in: 0...4, segments: 4, tone: .success)
    UIFnBanner("Sync paused", message: "Reconnect to keep your changes.", tone: .warning, dismiss: UIFnBannerDismiss("Dismiss") { paused = false }) {
        Button("Reconnect") { reconnect() }
    }
    UIFnEmptyState("No files", message: "Files you add appear here.") {
        Image(systemName: "tray")
    } actions: {
        Button("Add a file") { add() }.buttonStyle(.uifnPrimary)
    }
    UIFnSkeleton("Loading messages") {
        UIFnSkeletonBlock(.capsule).frame(width: 160, height: 12)
    }
}
.uifnToast($toast, dismissLabel: "Dismiss") // toast = UIFnToast("Copied", message: "The link is on the clipboard.")
```

- The components take their text as strings already localized and show them as they are, without looking them up in a strings table: `UIFnSegmentedMeter("Signal", …)` reads “Signal” even when a strings table has the key. To label a meter with a localized key, pass the label as a view, such as `UIFnSegmentedMeter(value: level) { Text("signal.title") }`. Tones (`.accent`, `.success`, `.warning`, `.danger`) are drawn only as color, so put what matters about a tone, such as an error, in the text.
- `UIFnSegmentedMeter` has from 2 to 100 segments: a count below 2 draws two, so a value inside the range can light some and leave some unlit, and a count above 100 draws 100. It lights its share of the segments from the leading edge, rounded to the nearest segment; a value strictly inside the range, however close to an end, always lights one and leaves one unlit. The share is worked out in at least `Double` precision, so a `Float` value lights the same segments as the same `Double` value. Values outside the range draw as the nearer end, and a value that is not a number, or a range with no width or an infinite bound, as empty. Any range with finite bounds and some width works, even one wider than the largest `Double`, such as `-Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude`. Accessibility sees a progress indicator with the label, whose value is the meter's value as a whole percentage of its range, such as “60%”; like the lit segments, a value strictly inside the range reads from 1% to 99%, never 0% or 100%. The percentage is read even when a current value label shows something else.
- `UIFnBanner` draws a title and an optional message on the tone's subtle color, with optional actions (in the secondary button style) and a dismiss button. Accessibility reads the title as the label and the message as the value of one text, then the actions, then the dismiss button with the label `UIFnBannerDismiss` gives it.
- `uifnToast(_:dismissLabel:edge:)` shows a banner over a view at its top or bottom edge for the toast's duration (5 seconds unless set, and any positive duration up to 365 days in full; nil, a duration that is not positive and finite, or one longer than 365 days keeps it until it is dismissed), then sets the binding to nil. A new toast replaces the one showing and gets its own full duration. Each toast is announced once when it appears, title then message, so VoiceOver reads it wherever focus is; on macOS warnings and dangers interrupt other speech. The banner slides in from the edge and fades, with the theme's entrance easing coming in and its exit easing going; under Reduce Motion it only fades, for the theme's reduced-motion duration (none for the default theme).
- `UIFnEmptyState` centers an optional icon, a title, an optional message and optional actions. The title is a heading for accessibility and the icon is hidden from it. A single trailing closure is the icon, as the first of two trailing closures is: `UIFnEmptyState("No files") { Image(systemName: "tray") }` shows an icon. For actions without an icon, label them: `UIFnEmptyState("No files", actions: { Button("Add a file") { add() } })`.
- `UIFnSkeleton` draws the `UIFnSkeletonBlock` shapes of its placeholder in the subtle border color, with a highlight sweeping across them from the leading edge; under Reduce Motion the blocks stay still, without the highlight. Accessibility sees one busy indicator with the skeleton's label in place of the blocks.

## Snapshot tests

`UIFnSwiftUITests` renders each style variant and component with `ImageRenderer` in light and dark at three Dynamic Type sizes and compares the result with the PNGs in `Tests/UIFnSwiftUITests/__Snapshots__`. Text renders in the box-glyph `UIFn Test Sans` test font, whose outlines and metrics do not change between OS releases. A snapshot passes when at most 0.5% of its pixels differ by more than 8/255 in a channel.

- References are recorded on macOS. On iOS the tests check that the styles change with the color scheme and grow with Dynamic Type instead. UIKit draws iOS menus, which `ImageRenderer` cannot, so on iOS the menu subjects draw the label the menu style gives a menu.
- `ImageRenderer` cannot draw platform text fields, so the text field snapshots draw the style around a `Text`. Indeterminate progress and the skeleton's highlight draw the moment they render, so their snapshots draw them at a fixed point in their cycle.
- Hosted-window tests on macOS check the segmented picker's arrow keys, clicks and focus ring with real key and mouse events.
- Accessibility tests read the elements SwiftUI builds for each component in a window, with their roles (traits on iOS), labels and values. SwiftUI builds them only for assistive technologies, so each read turns on the app's enhanced user interface on macOS, as VoiceOver does, or accessibility automation on iOS, as UI tests do, and turns it off again. These tests do not stand in for checking the components with VoiceOver.
- Record or update references with `UIFN_RECORD_SNAPSHOTS=1 swift test --filter UIFnControlStyleSnapshotTests`, then review the PNGs. A missing reference is recorded and fails the test.
- On a mismatch the rendered image is written under its snapshot name (for example `macOS/button-primary-light.png`) to `$UIFN_SNAPSHOT_ARTIFACTS`, or `uifn-snapshots` in the temporary directory. The Swift workflow uploads them as the `uifn-snapshot-failures` artifact.
