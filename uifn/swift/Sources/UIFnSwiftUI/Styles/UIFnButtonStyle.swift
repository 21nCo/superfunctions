import SwiftUI

/// A button style drawn with the environment's ``SwiftUI/EnvironmentValues/uifnTheme``.
///
/// The label uses the theme's medium type size at semibold weight. Pressed
/// buttons tint and shrink slightly, disabled buttons fade, and focused
/// buttons draw an accent ring. The style changes only how the button looks;
/// its action, role and keyboard behavior stay the system's.
public struct UIFnButtonStyle: ButtonStyle {
    public enum Variant: String, CaseIterable, Sendable {
        /// The accent fill, for the main action.
        case primary
        /// A sunken fill with a border, for other actions.
        case secondary
        /// No fill until pressed, for low-emphasis actions.
        case ghost
        /// The danger fill, for actions that delete or cannot be undone.
        case destructive
    }

    public let variant: Variant

    public init(_ variant: Variant = .primary) {
        self.variant = variant
    }

    public func makeBody(configuration: Configuration) -> some View {
        UIFnButtonStyleBody(label: configuration.label, variant: variant, isPressed: configuration.isPressed)
    }
}

public extension ButtonStyle where Self == UIFnButtonStyle {
    /// A UIFn button style variant.
    static func uifn(_ variant: UIFnButtonStyle.Variant) -> UIFnButtonStyle { UIFnButtonStyle(variant) }
    /// The UIFn primary button style.
    static var uifnPrimary: UIFnButtonStyle { UIFnButtonStyle(.primary) }
    /// The UIFn secondary button style.
    static var uifnSecondary: UIFnButtonStyle { UIFnButtonStyle(.secondary) }
    /// The UIFn ghost button style.
    static var uifnGhost: UIFnButtonStyle { UIFnButtonStyle(.ghost) }
    /// The UIFn destructive button style.
    static var uifnDestructive: UIFnButtonStyle { UIFnButtonStyle(.destructive) }
}

/// Reads the enabled and focused state the button style draws.
private struct UIFnButtonStyleBody<Label: View>: View {
    let label: Label
    let variant: UIFnButtonStyle.Variant
    let isPressed: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var isFocused

    var body: some View {
        UIFnButtonAppearance(
            label: label,
            variant: variant,
            state: UIFnControlState(isPressed: isPressed, isEnabled: isEnabled, isFocused: isFocused)
        )
    }
}

/// How a UIFn button looks in one state.
struct UIFnButtonAppearance<Label: View>: View {
    let label: Label
    let variant: UIFnButtonStyle.Variant
    let state: UIFnControlState
    @UIFnStyleEnvironment private var context

    var body: some View {
        let colors = context.colors
        let radius = context.radius.md
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        let (fill, foreground, border) = palette(colors)
        label
            .uifnFont(context.typography.size.md, weight: context.typography.weight.semibold)
            .foregroundColor(foreground)
            .multilineTextAlignment(.center)
            .padding(.horizontal, context.scaled(context.spacing.space3))
            .padding(.vertical, context.scaled(context.spacing.space2))
            .background(shape.fill(fill))
            .overlay {
                if let border {
                    shape.strokeBorder(border, lineWidth: 1)
                }
            }
            .overlay {
                if state.isPressed && state.isEnabled {
                    shape.fill(context.pressedTint)
                }
            }
            .contentShape(shape)
            .scaleEffect(state.isPressed && state.isEnabled ? 0.98 : 1)
            .opacity(state.isEnabled ? 1 : UIFnStyleContext.disabledOpacity)
            .uifnFocusRing(state.isFocused && state.isEnabled, cornerRadius: radius, context: context)
            .animation(context.stateAnimation, value: state)
    }

    private func palette(_ colors: UIFnColors) -> (fill: Color, foreground: Color, border: Color?) {
        switch variant {
        case .primary:
            (context.color(colors.accent.solid), context.color(colors.accent.contrast), nil)
        case .secondary:
            (context.color(colors.surface.sunken), context.color(colors.text.primary), context.color(colors.border.default))
        case .ghost:
            (.clear, context.color(colors.text.primary), nil)
        case .destructive:
            (context.color(colors.danger.solid), context.color(colors.danger.contrast), nil)
        }
    }
}
