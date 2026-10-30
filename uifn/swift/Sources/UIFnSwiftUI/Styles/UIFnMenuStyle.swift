import SwiftUI

/// A menu style drawn with the environment's ``SwiftUI/EnvironmentValues/uifnTheme``:
/// the label and a chevron on the raised surface inside a bordered rounded
/// rectangle.
///
/// Pressed menus tint, disabled menus fade, and focused menus draw an accent
/// ring. `menuIndicator(.hidden)` leaves out the chevron. The style changes
/// only how the menu's label looks: the menu's items, how it opens, and its
/// keyboard and accessibility behavior stay the system's.
public struct UIFnMenuStyle: MenuStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        // The system button menu style draws its label with the environment's
        // button style, so the menu keeps the system's presentation.
        Menu(configuration)
            .menuStyle(.button)
            .buttonStyle(UIFnMenuButtonStyle())
    }
}

public extension MenuStyle where Self == UIFnMenuStyle {
    /// The UIFn menu style.
    static var uifn: UIFnMenuStyle { UIFnMenuStyle() }
}

/// Draws the label of a menu that has the UIFn menu style.
private struct UIFnMenuButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        UIFnMenuButtonBody(label: configuration.label, isPressed: configuration.isPressed)
    }
}

/// Reads the enabled, focused and indicator state the menu style draws.
private struct UIFnMenuButtonBody<Label: View>: View {
    let label: Label
    let isPressed: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var isFocused
    @Environment(\.menuIndicatorVisibility) private var indicatorVisibility

    var body: some View {
        UIFnMenuAppearance(
            label: label,
            state: UIFnControlState(isPressed: isPressed, isEnabled: isEnabled, isFocused: isFocused),
            showsIndicator: indicatorVisibility != .hidden
        )
    }
}

/// How the label of a UIFn menu looks in one state.
struct UIFnMenuAppearance<Label: View>: View {
    let label: Label
    let state: UIFnControlState
    var showsIndicator = true
    @UIFnStyleEnvironment private var context

    var body: some View {
        let colors = context.colors
        let radius = context.radius.md
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        HStack(spacing: context.scaled(context.spacing.space2)) {
            label
                .uifnFont(context.typography.size.md, weight: context.typography.weight.regular)
                .foregroundColor(context.color(colors.text.primary))
            if showsIndicator {
                UIFnChevron()
                    .stroke(
                        context.color(colors.text.secondary),
                        style: StrokeStyle(lineWidth: context.scaled(1.5), lineCap: .round, lineJoin: .round)
                    )
                    .frame(width: context.scaled(8), height: context.scaled(4))
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, context.scaled(context.spacing.space3))
        .padding(.vertical, context.scaled(context.spacing.space2))
        .background(shape.fill(context.color(colors.surface.raised)))
        .overlay(shape.strokeBorder(context.color(colors.border.default), lineWidth: 1))
        .overlay {
            if state.isPressed && state.isEnabled {
                shape.fill(context.pressedTint)
            }
        }
        .contentShape(shape)
        .opacity(state.isEnabled ? 1 : UIFnStyleContext.disabledOpacity)
        .uifnFocusRing(state.isFocused && state.isEnabled, cornerRadius: radius, context: context)
        .animation(context.stateAnimation, value: state)
    }
}

/// A downward chevron filling its frame, drawn rather than taken from a
/// symbol font so it looks the same on every OS release.
struct UIFnChevron: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        return path
    }
}
