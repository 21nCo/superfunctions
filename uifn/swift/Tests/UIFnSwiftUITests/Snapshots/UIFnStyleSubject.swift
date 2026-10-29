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
        case .textFieldEmpty: UIFnTextFieldAppearance(field: Text(" "), state: UIFnControlState()).frame(width: 200)
        case .textFieldFilled: UIFnTextFieldAppearance(field: Text("Ada"), state: UIFnControlState()).frame(width: 200)
        case .groupBox:
            GroupBox("Account") { Text("Signed in") }
                .groupBoxStyle(.uifn)
                .frame(width: 220)
        }
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
