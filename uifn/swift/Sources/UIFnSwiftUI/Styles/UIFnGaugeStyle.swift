import SwiftUI

/// A gauge style drawn with the environment's ``SwiftUI/EnvironmentValues/uifnTheme``:
/// a bar or an open ring that fills with the accent color over the accent's
/// subtle tone.
///
/// The linear gauge puts the label and the current value label above the bar
/// and the minimum and maximum value labels at its ends. The circular gauge
/// draws a ring open at the bottom with the current value label inside, then
/// the minimum and maximum value labels under the ring's ends and the label.
/// A value outside the gauge's range draws as the nearer end, and a value that
/// is not a number as the minimum. Accessibility sees a system gauge with the
/// same value and labels in its place.
public struct UIFnGaugeStyle: GaugeStyle {
    public enum Variant: String, CaseIterable, Sendable {
        /// A horizontal bar that fills from the leading edge.
        case linear
        /// A ring open at the bottom that fills clockwise.
        case circular
    }

    public let variant: Variant

    public init(_ variant: Variant = .linear) {
        self.variant = variant
    }

    public func makeBody(configuration: Configuration) -> some View {
        UIFnGaugeAppearance(
            variant: variant,
            value: configuration.value,
            label: configuration.label,
            currentValueLabel: configuration.currentValueLabel,
            minimumValueLabel: configuration.minimumValueLabel,
            maximumValueLabel: configuration.maximumValueLabel
        )
        .accessibilityRepresentation {
            Gauge(value: configuration.value) {
                configuration.label
            } currentValueLabel: {
                configuration.currentValueLabel
            } minimumValueLabel: {
                AnyView(configuration.minimumValueLabel)
            } maximumValueLabel: {
                AnyView(configuration.maximumValueLabel)
            }
            .gaugeStyle(.linearCapacity)
        }
    }
}

public extension GaugeStyle where Self == UIFnGaugeStyle {
    /// A UIFn gauge style variant.
    static func uifn(_ variant: UIFnGaugeStyle.Variant) -> UIFnGaugeStyle { UIFnGaugeStyle(variant) }
    /// The UIFn linear gauge style.
    static var uifnLinear: UIFnGaugeStyle { UIFnGaugeStyle(.linear) }
    /// The UIFn circular gauge style.
    static var uifnCircular: UIFnGaugeStyle { UIFnGaugeStyle(.circular) }
}

/// How a UIFn gauge looks at a value from 0 to 1 through its range.
struct UIFnGaugeAppearance<Label: View, CurrentValueLabel: View, MinimumValueLabel: View, MaximumValueLabel: View>: View {
    let variant: UIFnGaugeStyle.Variant
    let value: Double
    let label: Label
    var currentValueLabel: CurrentValueLabel?
    var minimumValueLabel: MinimumValueLabel?
    var maximumValueLabel: MaximumValueLabel?
    @UIFnStyleEnvironment private var context

    var body: some View {
        switch variant {
        case .linear: linear
        case .circular: circular
        }
    }

    private var linear: some View {
        let spacing = context.scaled(context.spacing.space2)
        return VStack(alignment: .leading, spacing: context.scaled(context.spacing.space1)) {
            HStack(alignment: .firstTextBaseline, spacing: spacing) {
                label
                    .uifnFont(context.typography.size.md, weight: context.typography.weight.regular)
                    .foregroundColor(context.color(context.colors.text.primary))
                Spacer(minLength: 0)
                if let currentValueLabel {
                    currentValueLabel
                        .uifnFont(context.typography.size.md, weight: context.typography.weight.semibold)
                        .foregroundColor(context.color(context.colors.text.primary))
                }
            }
            HStack(spacing: spacing) {
                if let minimumValueLabel {
                    boundLabel(minimumValueLabel)
                }
                UIFnProgressBar(progress: .determinate(value))
                if let maximumValueLabel {
                    boundLabel(maximumValueLabel)
                }
            }
        }
    }

    private var circular: some View {
        let colors = context.colors
        let side = context.scaled(64)
        let lineWidth = context.scaled(6)
        let stroke = StrokeStyle(lineWidth: lineWidth, lineCap: .round)
        return VStack(spacing: context.scaled(context.spacing.space1)) {
            ZStack {
                // The ring runs clockwise through three quarters of a turn,
                // from the bottom left to the bottom right.
                Circle()
                    .trim(from: 0, to: Self.ringFraction)
                    .stroke(context.color(colors.accent.subtle), style: stroke)
                    .rotationEffect(.degrees(135))
                Circle()
                    .trim(from: 0, to: Self.ringFraction * UIFnProgress.clamped(value))
                    .stroke(context.color(colors.accent.solid), style: stroke)
                    .rotationEffect(.degrees(135))
                if let currentValueLabel {
                    currentValueLabel
                        .uifnFont(context.typography.size.md, weight: context.typography.weight.semibold)
                        .foregroundColor(context.color(colors.text.primary))
                        .lineLimit(1)
                        .padding(lineWidth)
                }
            }
            .padding(lineWidth / 2)
            .frame(width: side, height: side)
            if minimumValueLabel != nil || maximumValueLabel != nil {
                HStack(spacing: context.scaled(context.spacing.space2)) {
                    if let minimumValueLabel {
                        boundLabel(minimumValueLabel)
                    }
                    Spacer(minLength: 0)
                    if let maximumValueLabel {
                        boundLabel(maximumValueLabel)
                    }
                }
                .frame(width: side)
            }
            label
                .uifnFont(context.typography.size.md, weight: context.typography.weight.regular)
                .foregroundColor(context.color(colors.text.primary))
        }
    }

    /// The fraction of a turn the circular gauge's ring covers.
    private static var ringFraction: Double { 0.75 }

    private func boundLabel(_ label: some View) -> some View {
        label
            .uifnFont(context.typography.size.xs, weight: context.typography.weight.regular)
            .foregroundColor(context.color(context.colors.text.secondary))
            .lineLimit(1)
    }
}
