import SwiftUI

/// A text field style drawn with the environment's ``SwiftUI/EnvironmentValues/uifnTheme``:
/// the field on the raised surface inside a bordered rounded rectangle.
///
/// The field draws an accent ring while it has focus, and a disabled field
/// sinks and takes the disabled text color. A click or tap in the padding
/// focuses the field, like one on the border of a system field; editing,
/// selection and focus stay the system text field's.
public struct UIFnTextFieldStyle: TextFieldStyle {
    public init() {}

    // TextFieldStyle's only requirement is underscored; there is no public
    // alternative for a custom text field style.
    public func _body(configuration: TextField<_Label>) -> some View {
        UIFnTextFieldStyleBody(field: configuration)
    }
}

public extension TextFieldStyle where Self == UIFnTextFieldStyle {
    /// The UIFn text field style.
    static var uifn: UIFnTextFieldStyle { UIFnTextFieldStyle() }
}

/// Tracks the field's focus for the style. The focus state belongs to this
/// view, so a `focused(_:)` binding the app applies around the styled field
/// keeps working.
private struct UIFnTextFieldStyleBody<Field: View>: View {
    let field: Field
    @FocusState private var isFocused: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        UIFnTextFieldAppearance(
            field: field.focused($isFocused),
            state: UIFnControlState(isEnabled: isEnabled, isFocused: isFocused),
            focus: { if isEnabled { isFocused = true } }
        )
    }
}

/// How a UIFn text field looks in one state, around any field content.
struct UIFnTextFieldAppearance<Field: View>: View {
    let field: Field
    let state: UIFnControlState
    /// Focuses the field after a click or tap in the padding.
    var focus: () -> Void = {}
    @UIFnStyleEnvironment private var context

    var body: some View {
        let colors = context.colors
        let radius = context.radius.md
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        field
            .textFieldStyle(.plain)
            .uifnFont(context.typography.size.md)
            .foregroundColor(context.color(state.isEnabled ? colors.text.primary : colors.text.disabled))
            .padding(.horizontal, context.scaled(context.spacing.space3))
            .padding(.vertical, context.scaled(context.spacing.space2))
            // The field takes clicks and taps on its text; the background
            // takes the rest, so they never compete.
            .background(shape.fill(context.color(state.isEnabled ? colors.surface.raised : colors.surface.sunken)).onTapGesture(perform: focus))
            .overlay {
                shape.strokeBorder(context.color(state.isEnabled ? colors.border.default : colors.border.subtle), lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .uifnFocusRing(state.isFocused && state.isEnabled, cornerRadius: radius, context: context)
            .animation(context.stateAnimation, value: state)
    }
}
