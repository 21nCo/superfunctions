import SwiftUI

/// A loading placeholder drawn with the environment's ``SwiftUI/EnvironmentValues/uifnTheme``:
/// the ``UIFnSkeletonBlock`` shapes of its placeholder in the subtle border
/// color, with a highlight sweeping across them from the leading edge.
///
/// Lay the blocks out like the content that is loading. Under Reduce Motion
/// the blocks stay still, without the highlight. Accessibility sees a busy indicator labeled with
/// the label, already localized, such as “Loading messages”, in place of the
/// blocks.
public struct UIFnSkeleton<Placeholder: View>: View {
    let label: String
    let placeholder: Placeholder

    public init(_ label: String, @ViewBuilder placeholder: () -> Placeholder) {
        self.label = label
        self.placeholder = placeholder()
    }

    public var body: some View {
        UIFnSkeletonBody(placeholder: placeholder)
            .accessibilityRepresentation {
                // The label is set on the indicator too: UIKit does not
                // always take an indeterminate indicator's label from its
                // label view.
                ProgressView { Text(verbatim: label) }
                    .accessibilityLabel(Text(verbatim: label))
            }
    }
}

public extension UIFnSkeleton where Placeholder == UIFnSkeletonBlock {
    /// A placeholder of one block, which takes the frame it is given.
    init(_ label: String, shape: UIFnSkeletonBlock.Shape = .rectangle) {
        self.init(label) { UIFnSkeletonBlock(shape) }
    }
}

/// One shape of a ``UIFnSkeleton`` placeholder, which takes the frame it is given.
public struct UIFnSkeletonBlock: View {
    public enum Shape: String, CaseIterable, Sendable {
        /// A rectangle with the theme's small corner radius, for images and cards.
        case rectangle
        /// A capsule, for lines of text.
        case capsule
        /// A circle, for avatars.
        case circle
    }

    public let shape: Shape
    @UIFnStyleEnvironment private var context

    public init(_ shape: Shape = .rectangle) {
        self.shape = shape
    }

    public var body: some View {
        let fill = context.color(context.colors.border.subtle)
        switch shape {
        case .rectangle: RoundedRectangle(cornerRadius: context.radius.sm, style: .continuous).fill(fill)
        case .capsule: Capsule(style: .continuous).fill(fill)
        case .circle: Circle().fill(fill)
        }
    }
}

private struct UIFnSkeletonBody<Placeholder: View>: View {
    let placeholder: Placeholder
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            UIFnSkeletonAppearance(placeholder: placeholder, phase: nil)
        } else {
            TimelineView(.animation) { timeline in
                UIFnSkeletonAppearance(
                    placeholder: placeholder,
                    phase: UIFnProgress.phase(at: timeline.date, period: UIFnSkeletonAppearance<Placeholder>.period)
                )
            }
        }
    }
}

/// How a skeleton looks with its highlight at `phase`, from 0 to 1 through
/// its sweep, or without one when `phase` is nil.
struct UIFnSkeletonAppearance<Placeholder: View>: View {
    let placeholder: Placeholder
    let phase: Double?
    @UIFnStyleEnvironment private var context

    /// Seconds the highlight takes to sweep across.
    static var period: Double { 1.6 }
    /// The highlight's width, as a fraction of the placeholder's.
    static var highlightWidth: Double { 0.4 }

    var body: some View {
        placeholder
            .overlay {
                if let phase {
                    GeometryReader { proxy in
                        let width = proxy.size.width * Self.highlightWidth
                        // The highlight enters past the leading edge and leaves
                        // past the trailing one.
                        let start = (proxy.size.width + width) * phase - width
                        let highlight = context.color(context.colors.surface.raised)
                        // The highlight fades to its own color, not to clear
                        // black, so its edges do not darken the blocks.
                        LinearGradient(
                            colors: [highlight.opacity(0), highlight.opacity(0.7), highlight.opacity(0)],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                        .frame(width: width, height: proxy.size.height)
                        .offset(x: start)
                    }
                    .flipsForRightToLeftLayoutDirection(true)
                    .mask(placeholder)
                    .allowsHitTesting(false)
                }
            }
    }
}
