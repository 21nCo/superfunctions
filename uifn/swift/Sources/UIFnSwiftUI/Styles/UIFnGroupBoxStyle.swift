import SwiftUI

/// A group box style that draws a card with the environment's
/// ``SwiftUI/EnvironmentValues/uifnTheme``: the label as a bold title above
/// the content, on the raised surface inside a bordered rounded rectangle.
public struct UIFnGroupBoxStyle: GroupBoxStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        UIFnGroupBoxAppearance(label: configuration.label, content: configuration.content)
    }
}

public extension GroupBoxStyle where Self == UIFnGroupBoxStyle {
    /// The UIFn card group box style.
    static var uifn: UIFnGroupBoxStyle { UIFnGroupBoxStyle() }
}

/// How a UIFn group box looks around a label and content.
struct UIFnGroupBoxAppearance<Label: View, Content: View>: View {
    let label: Label
    let content: Content
    @UIFnStyleEnvironment private var context

    var body: some View {
        let colors = context.colors
        let shape = RoundedRectangle(cornerRadius: context.radius.lg, style: .continuous)
        VStack(alignment: .leading, spacing: context.scaled(context.spacing.space3)) {
            label
                .uifnFont(context.typography.size.xl, weight: context.typography.weight.bold)
                .foregroundColor(context.color(colors.text.primary))
                .accessibilityAddTraits(.isHeader)
            content
                .uifnFont(context.typography.size.md, weight: context.typography.weight.regular)
                .foregroundColor(context.color(colors.text.primary))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(context.scaled(context.spacing.space6))
        .background(shape.fill(context.color(colors.surface.raised)))
        .overlay(shape.strokeBorder(context.color(colors.border.default), lineWidth: 1))
    }
}
