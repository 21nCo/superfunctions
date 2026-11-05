# SwiftUI workbench

A macOS and iOS app that shows every `UIFnSwiftUI` style and component, one screen each, drawn with the default `uifn` theme. Its UI tests run Xcode's automated accessibility audit on every screen.

| Group | Screen | Shows |
| --- | --- | --- |
| Styles | Buttons | `.uifnPrimary`, `.uifnSecondary`, `.uifnGhost` and `.uifnDestructive`, enabled and disabled |
| Styles | Toggles | `.uifnSwitch` and `.uifnCheckbox` on, off, mixed, disabled and with the label hidden |
| Styles | Text fields | `.uifn` text fields with a prompt, a value and disabled |
| Styles | Group boxes and menus | `.uifn` group box and menus (with and without the indicator), `UIFnMenuPicker` with and without a selection |
| Styles | Segmented pickers | `UIFnSegmentedPicker` in the `.segmented` (also disabled) and `.tabs` variants |
| Styles | Progress and gauges | `.uifnLinear` and `.uifnCircular` progress views, determinate and indeterminate, and gauges |
| Components | Segmented meters | `UIFnSegmentedMeter` in each tone, and with a current value label |
| Components | Banners | `UIFnBanner` in each tone, and with actions and a dismiss button |
| Components | Toasts | Toasts from `uifnToast` in two tones |
| Components | Empty states | `UIFnEmptyState` with an icon, message and actions, a message only, and actions only |
| Components | Skeletons | `UIFnSkeleton` placeholders for text, an avatar row and an image |

## Run it

Open `SwiftUIWorkbench.xcodeproj` in Xcode 16 or later and run the `SwiftUIWorkbench` scheme on My Mac (macOS 14 or later) or an iPhone or iPad simulator (iOS 17 or later). The project uses the `UIFnSwiftUI` product of the repository's `Package.swift` as a local package, so changes to `uifn/swift` show up on the next build.

Launch arguments pick the first screen and the color scheme:

- `-UIFnWorkbenchScreen <screen>`, where `<screen>` is `buttons`, `toggles`, `text-fields`, `menus`, `segmented-pickers`, `progress`, `segmented-meters`, `banners`, `toasts`, `empty-states` or `skeletons`. Without it the app opens on the list of screens.
- `-UIFnWorkbenchColorScheme light` or `dark`. Without it the app follows the system.

## Accessibility audits

`SwiftUIWorkbenchUITests` launches the app on each screen, and on the list of screens, in light and then dark, and calls `performAccessibilityAudit()` with every audit type the platform has. On the toasts screen it shows a toast first. The audit judges contrast from the pixels on screen, so each test first checks that the whole screen fits in its window (an iPhone at the default text size, or the app's default 960 by 680 point window on macOS), and the screen list that its rows do; a screen that grows taller fails until it is split. An issue fails its test unless a waiver matches it. Another test checks that the screens in the app's list are exactly the audited ones, each with its own test, and that each opens from the list, so a new screen cannot go unaudited.

```bash
cd uifn/examples/swiftui-workbench
xcodebuild test -project SwiftUIWorkbench.xcodeproj -scheme SwiftUIWorkbench -destination 'platform=macOS'
xcodebuild test -project SwiftUIWorkbench.xcodeproj -scheme SwiftUIWorkbench -destination 'platform=iOS Simulator,name=<iPhone simulator>'
```

Use any iPhone simulator with iOS 17 or later; `xcrun simctl list devices available` lists them.

macOS UI tests need Automation Mode. Xcode asks for it the first time; from the command line, run `sudo automationmodetool enable-automationmode-without-authentication` once. The `workbench` job of the Swift workflow (`.github/workflows/swift.yml`) runs both commands, on the newest iPhone simulator with iOS 17 or later, and uploads each result bundle.

### Waivers

The waivers are in `UITests/WorkbenchAuditWaiver.swift`, and a test checks that this table lists the same ids and reasons. Each waived issue is attached to its test's result. The segmented picker's clipping was real when the audit first found it: at accessibility text sizes `UIFnSegmentedPicker` truncated every segment label to an ellipsis. Its segments now stop growing at `.xxxLarge` (see the UIFnSwiftUI README), and the waiver covers only the audit's prediction, which does not change.

| Waiver | Screens | Platform | Audit type | Elements | Reason |
| --- | --- | --- | --- | --- | --- |
| `disabled-contrast` | All | Both | Contrast | Disabled controls | Disabled controls fade so they read as unavailable. WCAG 2.2 success criterion 1.4.3 exempts text in inactive controls. |
| `unchecked-checkbox-contrast` | Toggles | Both | Contrast | The unchecked checkboxes “Send me news” and “Archive” | The audit compares the unchecked box's raised fill with the canvas (1.1:1); the checked rows with the same label color pass. The label is the primary text color on the canvas (17:1), and the box's strong border meets the 3:1 non-text minimum (4.0:1 light, 3.6:1 dark). |
| `segmented-picker-text-clipped` | Segmented pickers | iOS | Text clipped | The segments | The segments share the picker's width, so they stop growing at the largest text size before the accessibility sizes and shrink a label that still does not fit; at the largest accessibility size every label shows in full. The audit predicts clipping from the segment's frame and does not see that the segments stop growing. |
| `text-field-hit-region` | Text fields | iOS | Hit region | Text fields | The audit measures the system text field inside the style's padding. A tap anywhere in the padded field focuses it, so the touch target is the whole field. |
| `text-field-text-clipped` | Text fields | iOS | Text clipped | Text fields | Text fields are one line, like the system's, and grow taller with Dynamic Type. A value wider than the field scrolls while it is edited and truncates otherwise; the audit also flags values that fit at every size, such as "Design". |

### Not covered

The audit's findings depend on the OS version. CI audits on the runner's macOS and its newest iOS simulator (macOS 26 and iOS 26 on the current `macos-latest` image). An iOS 18 simulator reports issues that iOS 26 does not, chiefly toggle and segmented picker labels whose accessibility frames differ from what is drawn; those are tracked separately and not waived here, so an iOS 17 or 18 run is expected to fail until they are resolved.

The audit checks what Xcode can check automatically. It does not replace using the screens with VoiceOver, Voice Control or Full Keyboard Access, or under Increase Contrast, Reduce Motion, Reduce Transparency and larger text sizes; those checks are tracked separately and are not part of these tests.
