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

On CI, `TEST_RUNNER_UIFN_WORKBENCH_REQUIRE_README=1` makes the waiver table test fail, rather than skip, if the test runner cannot read this README.

macOS UI tests need Automation Mode. Xcode asks for it the first time; from the command line, run `sudo automationmodetool enable-automationmode-without-authentication` once. The `workbench` job of the Swift workflow (`.github/workflows/swift.yml`) runs both commands, on the newest iPhone simulator with iOS 17 or later, and uploads each result bundle.

### Waivers

The waivers are in `UITests/WorkbenchAuditWaiver.swift`, and a test checks that this table lists the same ids and reasons. Each waived issue is attached to its test's result. The segmented picker's clipping was real when the audit first found it: at accessibility text sizes `UIFnSegmentedPicker` truncated every segment label to an ellipsis. Its segments now stop growing at `.xxxLarge` and, on iOS, show their label in the Large Content Viewer on a long press, as the system segmented control does (see the UIFnSwiftUI README). The waiver covers only the audit's prediction, which does not change.

The macOS audit also reports elements that SwiftUI and AppKit make around the app's views (window and column containers, the full-screen button, the CI Mac's Touch Bar), and two that SwiftUI makes for UIFn controls: a gauge with a custom style has no macOS role, and the button-style menu's button has no press action. The macOS waivers cover those, scoped to the elements, screens and color schemes the audit reported them on, and the waiver tests (`UITests/WorkbenchAuditWaiverTests.swift`) check that app elements outside them are not waived. Every contrast issue, waived or not, attaches the element's screenshot with the contrast its pixels measure, and a screenshot of the window. Its first run on CI also found issues in the workbench and in `UIFnSwiftUI`, which are fixed rather than waived. The macOS list rows are tagged rows instead of navigation links, which had no role, and the macOS sidebar draws its rows in the theme's text color on an opaque theme surface, because over the sidebar's own translucent material the audit failed the contrast of a different set of legible rows from run to run. Each text field names itself, because a macOS field gives accessibility neither its title nor its prompt. And the UIFn segmented and menu pickers no longer give accessibility a label text beside the control where nothing is drawn; the label is now the control's own.

| Waiver | Screens | Platform | Audit type | Elements | Reason |
| --- | --- | --- | --- | --- | --- |
| `disabled-contrast` | All | Both | Contrast | Disabled controls | Disabled controls fade so they read as unavailable. WCAG 2.2 success criterion 1.4.3 exempts text in inactive controls. |
| `unchecked-checkbox-contrast` | Toggles | Both | Contrast | The unchecked checkboxes “Send me news” and “Archive” | The audit compares the unchecked box's raised fill with the canvas (1.1:1); the checked rows with the same label color pass. The label is the primary text color on the canvas (17:1), and the box's strong border meets the 3:1 non-text minimum (4.0:1 light, 3.6:1 dark). |
| `segmented-picker-text-clipped` | Segmented pickers | iOS | Text clipped | The segments | The segments share the picker's width, so they stop growing at the largest text size before the accessibility sizes and shrink a label that still does not fit; at the largest accessibility size every label shows in full. The audit predicts clipping from the segment's frame and does not see that the segments stop growing. |
| `text-field-hit-region` | Text fields | iOS | Hit region | Text fields | The audit measures the system text field inside the style's padding. A tap anywhere in the padded field focuses it, so the touch target is the whole field. |
| `text-field-text-clipped` | Text fields | iOS | Text clipped | Text fields | Text fields are one line, like the system's, and grow taller with Dynamic Type. A value wider than the field scrolls while it is edited and truncates otherwise; the audit also flags values that fit at every size, such as "Design". |
| `macos-window-groups` | All | macOS | Element description, parent/child | The window's, the split view's columns', the sidebar section headers' and the full-screen button's unlabeled groups | SwiftUI and AppKit make these unlabeled groups around the app's views: the hosting views of the window, its sidebar and detail columns and the list's section headers, and the group inside the window's full-screen button. They are not elements VoiceOver stops on. Each is matched by where it sits in the window; any other unlabeled group, on a page or in the list, is still audited. |
| `macos-touch-bar` | All | macOS | Element description, action | The Touch Bar and its items | The CI Mac shows a Touch Bar, and AppKit fills it, adding items such as "emoji & symbols" while a text field has focus. They are not the app's views. Only the Touch Bar and elements inside its frame, outside the app's window, are waived. |
| `macos-elementless-parent-child` | Text fields | macOS | Parent/child | No element | With a text field focused, the audit reports a parent/child mismatch on no element, so there is no view of the app's to fix. The fields themselves are audited. |
| `swiftui-gauge-role` | Progress and gauges | macOS | Element description | The gauges “Storage” and “Battery” | SwiftUI gives a gauge with a custom style an element with no macOS role, whatever the style's body or accessibility representation, even a system gauge or progress view. The gauge reads its label, current value label and value, which UIFnSwiftUI's tests check. |
| `swiftui-menu-action` | Group boxes and menus | macOS | Action | The menus “Options” and “Share” | The menu is SwiftUI's own, in the system button menu style; the UIFn style only draws its label. The audit finds no press action on the menu button SwiftUI makes. Opening it with VoiceOver and Full Keyboard Access is checked under UIF-29. |
| `macos-contrast-misread` | Toggles, Empty states, Toasts, Text fields | macOS | Contrast | “Alerts” in light; the empty state message, the toast and the window title in dark | The colors of these texts measure well above 4.5:1: "Alerts" 17.1:1 (text.primary on the light canvas), the empty state's message 11.3:1 (text.secondary on the dark canvas), the toast 8.2:1 or more (on the dark success tone), and the window title is AppKit's. Other texts in the same colors on the same screens pass. Each is waived only when the lightest and darkest pixels of its own screenshot, taken when the audit reports it, differ by 4.5:1 or more; the screenshot and that ratio are attached to the test's result. |

### Not covered

The audit's findings depend on the OS version. CI audits on the runner's macOS and its newest iOS simulator (macOS 26 and iOS 26 on the current `macos-latest` image). An iOS 18 simulator reports issues that iOS 26 does not, chiefly toggle and segmented picker labels whose accessibility frames differ from what is drawn. They are not waived here, so an iOS 17 or 18 run is expected to fail. Passing the audits on iOS 17 and 18 is deferred to [UIF-45](https://linear.app/21n/issue/UIF-45), which tracks fixing those frames and adding an iOS 18 simulator to the CI job; these tests do not show that iOS 17 and 18 pass.

The audit checks what Xcode can check automatically. It does not replace using the screens with VoiceOver, Voice Control or Full Keyboard Access, or under Increase Contrast, Reduce Motion, Reduce Transparency and larger text sizes. Those checks are deferred to [UIF-29](https://linear.app/21n/issue/UIF-29) and are not part of these tests.
