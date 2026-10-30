import SwiftUI

/// A progress view style drawn with the environment's ``SwiftUI/EnvironmentValues/uifnTheme``:
/// a bar or a ring that fills with the accent color over the accent's subtle
/// tone, with the label above (linear) or below (circular) and the current
/// value label under it.
///
/// Progress outside 0 to 1 draws as the nearer end, and progress that is not
/// a number as none. Indeterminate progress runs a segment along the bar or
/// spins an arc around the ring; under Reduce Motion it stays still and fades
/// in and out instead. Accessibility sees a system progress view with the same
/// progress and labels in its place.
public struct UIFnProgressViewStyle: ProgressViewStyle {
    public enum Variant: String, CaseIterable, Sendable {
        /// A horizontal bar that fills from the leading edge.
        case linear
        /// A ring that fills clockwise from the top.
        case circular
    }

    public let variant: Variant

    public init(_ variant: Variant = .linear) {
        self.variant = variant
    }

    public func makeBody(configuration: Configuration) -> some View {
        UIFnProgressStyleBody(configuration: configuration, variant: variant)
    }
}

public extension ProgressViewStyle where Self == UIFnProgressViewStyle {
    /// A UIFn progress view style variant.
    static func uifn(_ variant: UIFnProgressViewStyle.Variant) -> UIFnProgressViewStyle { UIFnProgressViewStyle(variant) }
    /// The UIFn linear progress view style.
    static var uifnLinear: UIFnProgressViewStyle { UIFnProgressViewStyle(.linear) }
    /// The UIFn circular progress view style.
    static var uifnCircular: UIFnProgressViewStyle { UIFnProgressViewStyle(.circular) }
}

private struct UIFnProgressStyleBody: View {
    let configuration: ProgressViewStyleConfiguration
    let variant: UIFnProgressViewStyle.Variant
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if let fraction = configuration.fractionCompleted {
                appearance(progress: .determinate(fraction))
            } else {
                TimelineView(.animation) { timeline in
                    appearance(progress: .indeterminate(phase: UIFnProgress.phase(
                        at: timeline.date,
                        period: UIFnProgress.period(variant, reduceMotion: reduceMotion)
                    )))
                }
            }
        }
        .accessibilityRepresentation {
            switch variant {
            case .linear: ProgressView(configuration).progressViewStyle(.linear)
            case .circular: ProgressView(configuration).progressViewStyle(.circular)
            }
        }
    }

    private func appearance(progress: UIFnProgress) -> some View {
        UIFnProgressAppearance(
            variant: variant,
            progress: progress,
            label: configuration.label,
            currentValueLabel: configuration.currentValueLabel
        )
    }
}

/// The progress a UIFn progress view draws.
enum UIFnProgress: Equatable {
    /// Progress from 0 to 1.
    case determinate(Double)
    /// Unknown progress, drawn at `phase`, from 0 to 1, through its cycle.
    case indeterminate(phase: Double)

    /// The fraction to draw: within 0 to 1, and 0 for a value that is not a number.
    static func clamped(_ fraction: Double) -> Double {
        fraction.isNaN ? 0 : min(max(fraction, 0), 1)
    }

    /// Seconds for one cycle of an indeterminate indicator.
    static func period(_ variant: UIFnProgressViewStyle.Variant, reduceMotion: Bool) -> Double {
        if reduceMotion { return 2 }
        switch variant {
        case .linear: return 1.5
        case .circular: return 1
        }
    }

    /// How far through its cycle an indeterminate indicator is at `date`.
    static func phase(at date: Date, period: Double) -> Double {
        let elapsed = date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period)
        return (elapsed < 0 ? elapsed + period : elapsed) / period
    }

    /// The opacity of an indeterminate indicator that fades instead of
    /// moving: fully drawn at the start of the cycle, faintest halfway.
    static func fadingOpacity(phase: Double) -> Double {
        0.65 + 0.35 * cos(2 * .pi * phase)
    }
}

/// How a UIFn progress view looks with some progress.
struct UIFnProgressAppearance<Label: View, CurrentValueLabel: View>: View {
    let variant: UIFnProgressViewStyle.Variant
    let progress: UIFnProgress
    var label: Label?
    var currentValueLabel: CurrentValueLabel?
    @UIFnStyleEnvironment private var context

    var body: some View {
        let colors = context.colors
        VStack(alignment: variant == .linear ? .leading : .center, spacing: context.scaled(context.spacing.space1)) {
            if variant == .linear, let label {
                styledLabel(label)
            }
            switch variant {
            case .linear: UIFnProgressBar(progress: progress)
            case .circular: UIFnProgressRing(progress: progress)
            }
            if variant == .circular, let label {
                styledLabel(label)
            }
            if let currentValueLabel {
                currentValueLabel
                    .uifnFont(context.typography.size.sm, weight: context.typography.weight.regular)
                    .foregroundColor(context.color(colors.text.secondary))
            }
        }
    }

    private func styledLabel(_ label: Label) -> some View {
        label
            .uifnFont(context.typography.size.md, weight: context.typography.weight.regular)
            .foregroundColor(context.color(context.colors.text.primary))
    }
}

/// A capsule bar that fills from the leading edge, or runs a segment along
/// it for indeterminate progress. It takes the width it is offered.
struct UIFnProgressBar: View {
    let progress: UIFnProgress
    @UIFnStyleEnvironment private var context

    /// The fraction of the bar an indeterminate segment covers.
    private static let segment = 0.3

    var body: some View {
        let colors = context.colors
        let accent = context.color(colors.accent.solid)
        ZStack {
            Capsule(style: .continuous).fill(context.color(colors.accent.subtle))
            switch progress {
            case let .determinate(fraction):
                UIFnBarSegment(start: 0, end: UIFnProgress.clamped(fraction)).fill(accent)
            case let .indeterminate(phase):
                if context.reduceMotion {
                    Capsule(style: .continuous).fill(accent).opacity(UIFnProgress.fadingOpacity(phase: phase))
                } else {
                    // The segment enters past the leading edge and leaves past
                    // the trailing one.
                    let start = (1 + Self.segment) * phase - Self.segment
                    UIFnBarSegment(start: start, end: start + Self.segment).fill(accent)
                }
            }
        }
        .clipShape(Capsule(style: .continuous))
        .flipsForRightToLeftLayoutDirection(true)
        .frame(idealWidth: 160)
        .frame(height: context.scaled(6))
    }
}

/// A capsule over part of the width, from `start` to `end` as fractions of
/// it, left to right.
struct UIFnBarSegment: Shape {
    let start: Double
    let end: Double

    func path(in rect: CGRect) -> Path {
        let minX = rect.minX + rect.width * start
        let maxX = rect.minX + rect.width * end
        guard maxX > minX else { return Path() }
        return Capsule(style: .continuous).path(in: CGRect(x: minX, y: rect.minY, width: maxX - minX, height: rect.height))
    }
}

/// A ring that fills clockwise from the top, or spins an arc for
/// indeterminate progress.
struct UIFnProgressRing: View {
    let progress: UIFnProgress
    @UIFnStyleEnvironment private var context

    /// The fraction of the ring an indeterminate arc covers.
    private static let arc = 0.25

    var body: some View {
        let colors = context.colors
        let side = context.scaled(28)
        let lineWidth = context.scaled(3)
        let stroke = StrokeStyle(lineWidth: lineWidth, lineCap: .round)
        let accent = context.color(colors.accent.solid)
        ZStack {
            Circle()
                .stroke(context.color(colors.accent.subtle), lineWidth: lineWidth)
            switch progress {
            case let .determinate(fraction):
                Circle()
                    .trim(from: 0, to: UIFnProgress.clamped(fraction))
                    .stroke(accent, style: stroke)
                    .rotationEffect(.degrees(-90))
            case let .indeterminate(phase):
                Circle()
                    .trim(from: 0, to: Self.arc)
                    .stroke(accent, style: stroke)
                    .rotationEffect(.degrees(-90 + (context.reduceMotion ? 0 : 360 * phase)))
                    .opacity(context.reduceMotion ? UIFnProgress.fadingOpacity(phase: phase) : 1)
            }
        }
        .padding(lineWidth / 2)
        .frame(width: side, height: side)
    }
}
