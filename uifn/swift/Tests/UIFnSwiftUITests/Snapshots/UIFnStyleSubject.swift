import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// The box-glyph test family. Its metrics and outlines are the same on every
/// OS release, unlike the system font's, so snapshots of its text are stable.
let snapshotFontFamily = "UIFn Test Sans"

func registerSnapshotFont() throws {
    try UIFnFontRegistry.shared.register(
        family: snapshotFontFamily,
        faces: [
            UIFnFontFace(weight: UIFnFontWeight(400), resource: "UIFnTestSans-Regular", fileExtension: "ttf", subdirectory: "Fonts"),
            UIFnFontFace(weight: UIFnFontWeight(700), resource: "UIFnTestSans-Bold", fileExtension: "ttf", subdirectory: "Fonts"),
        ],
        from: .module
    )
}

/// Each control style variant the snapshot tests render through the public styles.
enum UIFnStyleSubject: String, CaseIterable, CustomTestStringConvertible {
    case buttonPrimary = "button-primary"
    case buttonSecondary = "button-secondary"
    case buttonGhost = "button-ghost"
    case buttonDestructive = "button-destructive"
    case switchOff = "switch-off"
    case switchOn = "switch-on"
    case checkboxOff = "checkbox-off"
    case checkboxOn = "checkbox-on"
    case checkboxMixed = "checkbox-mixed"
    case textFieldEmpty = "text-field-empty"
    case textFieldFilled = "text-field-filled"
    case groupBox = "group-box"
    case segmentedPicker = "segmented-picker"
    case tabSwitcher = "tab-switcher"
    case menu = "menu"
    case menuPicker = "menu-picker"
    case menuPickerUnselected = "menu-picker-unselected"
    case progressLinear = "progress-linear"
    case progressLinearIndeterminate = "progress-linear-indeterminate"
    case progressCircular = "progress-circular"
    case progressCircularIndeterminate = "progress-circular-indeterminate"
    case gaugeLinear = "gauge-linear"
    case gaugeCircular = "gauge-circular"

    var testDescription: String { rawValue }

    @MainActor @ViewBuilder
    var view: some View {
        switch self {
        case .buttonPrimary: Button("Continue") {}.buttonStyle(.uifnPrimary)
        case .buttonSecondary: Button("Continue") {}.buttonStyle(.uifnSecondary)
        case .buttonGhost: Button("Continue") {}.buttonStyle(.uifnGhost)
        case .buttonDestructive: Button("Delete") {}.buttonStyle(.uifnDestructive)
        case .switchOff: Toggle("Alerts", isOn: .constant(false)).toggleStyle(.uifnSwitch)
        case .switchOn: Toggle("Alerts", isOn: .constant(true)).toggleStyle(.uifnSwitch)
        case .checkboxOff: Toggle("Remember", isOn: .constant(false)).toggleStyle(.uifnCheckbox)
        case .checkboxOn: Toggle("Remember", isOn: .constant(true)).toggleStyle(.uifnCheckbox)
        case .checkboxMixed:
            Toggle(sources: [Binding.constant(true), .constant(false)], isOn: \.self) { Text("Remember") }
                .toggleStyle(.uifnCheckbox)
        // ImageRenderer draws a placeholder for the platform text field, so
        // the text field snapshots draw the style around the text it shows.
        // The stand-in fills the field's width, like the platform field.
        case .textFieldEmpty:
            UIFnTextFieldAppearance(field: Text(" ").frame(maxWidth: .infinity, alignment: .leading), state: UIFnControlState())
                .frame(width: 200)
        case .textFieldFilled:
            UIFnTextFieldAppearance(field: Text("Ada").frame(maxWidth: .infinity, alignment: .leading), state: UIFnControlState())
                .frame(width: 200)
        case .groupBox:
            GroupBox("Account") { Text("Signed in") }
                .groupBoxStyle(.uifn)
                .frame(width: 220)
        case .segmentedPicker:
            UIFnSegmentedPicker("Range", selection: .constant("Week"), options: ["Day", "Week", "Month"]) { Text($0) }
                .fixedSize()
        case .tabSwitcher:
            UIFnSegmentedPicker("Range", selection: .constant("Week"), options: ["Day", "Week", "Month"], variant: .tabs) { Text($0) }
                .fixedSize()
        // UIKit draws iOS menus, which ImageRenderer cannot, so on iOS the
        // menu subjects draw the label the style gives the menu.
        case .menu:
            #if os(macOS)
            Menu("Options") { Button("Rename") { /* The snapshot only draws the menu. */ } }.menuStyle(.uifn)
            #else
            UIFnMenuAppearance(label: Text("Options"), state: UIFnControlState())
            #endif
        case .menuPicker:
            #if os(macOS)
            UIFnMenuPicker("Sort", selection: .constant("Name"), options: ["Name", "Date"]) { Text($0) }
            #else
            UIFnMenuAppearance(label: Text("Name"), state: UIFnControlState())
            #endif
        case .menuPickerUnselected:
            #if os(macOS)
            UIFnMenuPicker("Sort", selection: .constant("Size"), options: ["Name", "Date"]) { Text($0) }
            #else
            UIFnMenuAppearance(label: UIFnMutedText(text: "Sort"), state: UIFnControlState())
            #endif
        case .progressLinear:
            ProgressView(value: 0.4) { Text("Upload") } currentValueLabel: { Text("40%") }
                .progressViewStyle(.uifnLinear)
                .frame(width: 200)
        // An indeterminate progress view draws the phase it is at when it
        // renders, so these snapshots draw the style at a fixed phase.
        case .progressLinearIndeterminate:
            UIFnProgressAppearance(variant: .linear, progress: .indeterminate(phase: 0.5), label: Text("Upload"), currentValueLabel: Text?.none)
                .frame(width: 200)
        case .progressCircular:
            ProgressView(value: 0.4) { Text("Upload") } currentValueLabel: { Text("40%") }
                .progressViewStyle(.uifnCircular)
        case .progressCircularIndeterminate:
            UIFnProgressAppearance(variant: .circular, progress: .indeterminate(phase: 0.25), label: Text("Upload"), currentValueLabel: Text?.none)
        case .gaugeLinear:
            Gauge(value: 0.6) { Text("Storage") } currentValueLabel: { Text("60%") } minimumValueLabel: { Text("0") } maximumValueLabel: { Text("100") }
                .gaugeStyle(.uifnLinear)
                .frame(width: 220)
        case .gaugeCircular:
            Gauge(value: 0.6) { Text("Storage") } currentValueLabel: { Text("60") } minimumValueLabel: { Text("0") } maximumValueLabel: { Text("100") }
                .gaugeStyle(.uifnCircular)
        }
    }
}

/// Text in the theme's muted text color, as a menu picker shows its label
/// when no option is selected.
struct UIFnMutedText: View {
    let text: String
    @UIFnStyleEnvironment private var context

    var body: some View {
        Text(text).foregroundColor(context.color(context.colors.text.muted))
    }
}

/// A view on the theme's canvas, in the snapshot font, with room for focus rings.
struct UIFnSnapshotCanvas<Content: View>: View {
    let content: Content
    @Environment(\.uifnTheme) private var theme

    var body: some View {
        content
            .padding(12)
            .background(theme.colors.surface.canvas.color)
            .uifnFontFamily(snapshotFontFamily)
    }
}

extension View {
    func snapshotCanvas() -> UIFnSnapshotCanvas<Self> {
        UIFnSnapshotCanvas(content: self)
    }
}
