import SwiftUI

/// What a view shows when it has no content yet, drawn with the environment's
/// ``SwiftUI/EnvironmentValues/uifnTheme``: an optional icon, a title and an
/// optional message, centered, with optional actions under them.
///
/// Pass text already localized; the empty state shows it as it is.
/// Accessibility reads the title as a heading, then the message and the
/// actions. The icon is decoration, hidden from accessibility.
///
/// A single trailing closure is the icon, as the first of two trailing
/// closures is, so `UIFnEmptyState("No files") { Image(systemName: "tray") }`
/// shows an icon. For actions without an icon, label them:
/// `UIFnEmptyState("No files", actions: { Button("Add a file") { add() } })`.
public struct UIFnEmptyState<Icon: View, Actions: View>: View {
    let title: String
    let message: String?
    let icon: Icon
    let actions: Actions

    public init(
        _ title: String,
        message: String? = nil,
        @ViewBuilder icon: () -> Icon,
        @ViewBuilder actions: () -> Actions
    ) {
        self.title = title
        self.message = message
        self.icon = icon()
        self.actions = actions()
    }

    public var body: some View {
        UIFnEmptyStateAppearance(title: title, message: message, icon: icon, actions: actions)
    }
}

public extension UIFnEmptyState where Icon == EmptyView {
    /// An empty state with actions and no icon.
    ///
    /// Pass the actions labeled `actions:`; a single trailing closure is the
    /// icon instead.
    @_disfavoredOverload
    init(_ title: String, message: String? = nil, @ViewBuilder actions: () -> Actions) {
        self.init(title, message: message, icon: { EmptyView() }, actions: actions)
    }
}

public extension UIFnEmptyState where Actions == EmptyView {
    /// An empty state with an icon and no actions. The icon can be a single
    /// trailing closure.
    init(_ title: String, message: String? = nil, @ViewBuilder icon: () -> Icon) {
        self.init(title, message: message, icon: icon, actions: { EmptyView() })
    }
}

public extension UIFnEmptyState where Icon == EmptyView, Actions == EmptyView {
    init(_ title: String, message: String? = nil) {
        self.init(title, message: message, icon: { EmptyView() }, actions: { EmptyView() })
    }
}

/// How a UIFn empty state looks.
struct UIFnEmptyStateAppearance<Icon: View, Actions: View>: View {
    let title: String
    let message: String?
    let icon: Icon
    let actions: Actions
    @UIFnStyleEnvironment private var context

    var body: some View {
        let colors = context.colors
        VStack(spacing: context.scaled(context.spacing.space3)) {
            if Icon.self != EmptyView.self {
                icon
                    .uifnFont(context.typography.size.xl, weight: context.typography.weight.regular)
                    .imageScale(.large)
                    .foregroundColor(context.color(colors.text.muted))
                    .accessibilityHidden(true)
            }
            VStack(spacing: context.scaled(context.spacing.space1)) {
                Text(verbatim: title)
                    .uifnFont(context.typography.size.lg, weight: context.typography.weight.semibold)
                    .foregroundColor(context.color(colors.text.primary))
                    .accessibilityAddTraits(.isHeader)
                if let message {
                    Text(verbatim: message)
                        .uifnFont(context.typography.size.md, weight: context.typography.weight.regular)
                        .foregroundColor(context.color(colors.text.secondary))
                }
            }
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            if Actions.self != EmptyView.self {
                HStack(spacing: context.scaled(context.spacing.space2)) {
                    actions
                }
                .padding(.top, context.scaled(context.spacing.space1))
            }
        }
        .padding(context.scaled(context.spacing.space6))
        .frame(maxWidth: .infinity)
    }
}
