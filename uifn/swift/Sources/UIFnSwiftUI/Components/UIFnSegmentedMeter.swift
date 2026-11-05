import SwiftUI

/// A meter drawn as a row of segments that light from the leading edge, with
/// the environment's ``SwiftUI/EnvironmentValues/uifnTheme``: lit segments in
/// the tone's solid color over its subtle tone, the label above them and the
/// current value label, when there is one, at the label's trailing end.
///
/// The value lights its share of the segments, rounded to the nearest one,
/// except that a value strictly inside the range, however close to an end,
/// always lights one and leaves one unlit, so it reads as neither empty nor
/// full. Values outside the range draw as the nearer end, and a value that is
/// not a number, or a range with no width or an infinite bound, as empty. Any
/// range with finite bounds and some width works, even one wider than the
/// largest `Double`, such as
/// `-Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude`.
///
/// Accessibility sees a progress indicator with the label, whose value is the
/// meter's value as a whole percentage of its range, such as “40%”. Like the
/// lit segments, a value strictly inside the range reads from 1% to 99%,
/// never 0% or 100%.
///
/// A meter has from 2 to 100 segments: a count below 2 draws two segments, so
/// a value inside the range can light some and leave some unlit, and a count
/// above 100 draws 100.
public struct UIFnSegmentedMeter<Label: View, CurrentValueLabel: View>: View {
    private let fraction: Double
    private let segments: Int
    private let tone: UIFnTone
    private let label: Label
    private let currentValueLabel: CurrentValueLabel?

    /// A meter of `segments` segments, from 2 to 100, showing `value` within `bounds`.
    public init<Value: BinaryFloatingPoint>(
        value: Value,
        in bounds: ClosedRange<Value> = 0...1,
        segments: Int = 5,
        tone: UIFnTone = .accent,
        @ViewBuilder label: () -> Label,
        @ViewBuilder currentValueLabel: () -> CurrentValueLabel
    ) {
        self.init(
            fraction: UIFnMeterValue.fraction(value, in: bounds),
            segments: segments,
            tone: tone,
            label: label(),
            currentValueLabel: currentValueLabel()
        )
    }

    fileprivate init(fraction: Double, segments: Int, tone: UIFnTone, label: Label, currentValueLabel: CurrentValueLabel?) {
        self.fraction = fraction
        self.segments = UIFnMeterValue.segmentCount(segments)
        self.tone = tone
        self.label = label
        self.currentValueLabel = currentValueLabel
    }

    public var body: some View {
        UIFnSegmentedMeterAppearance(
            fraction: fraction,
            segments: segments,
            tone: tone,
            label: label,
            currentValueLabel: currentValueLabel
        )
        .accessibilityRepresentation {
            UIFnSegmentedMeterAccessibility(fraction: fraction, label: label)
        }
    }
}

/// What accessibility sees in place of a segmented meter: a progress
/// indicator with the meter's label, whose value is its percentage.
struct UIFnSegmentedMeterAccessibility<Label: View>: View {
    let fraction: Double
    let label: Label

    var body: some View {
        let indicator = ProgressView(value: fraction) { label }
            .accessibilityValue(UIFnMeterValue.percentText(fraction))
        // UIKit does not always take the indicator's label from its label
        // view, so where SwiftUI can, the label is set on it as well.
        if #available(iOS 18, macOS 15, *) {
            indicator.accessibilityLabel { _ in label }
        } else {
            indicator
        }
    }
}

public extension UIFnSegmentedMeter where CurrentValueLabel == EmptyView {
    /// A meter of `segments` segments, from 2 to 100, showing `value` within `bounds`.
    init<Value: BinaryFloatingPoint>(
        value: Value,
        in bounds: ClosedRange<Value> = 0...1,
        segments: Int = 5,
        tone: UIFnTone = .accent,
        @ViewBuilder label: () -> Label
    ) {
        self.init(
            fraction: UIFnMeterValue.fraction(value, in: bounds),
            segments: segments,
            tone: tone,
            label: label(),
            currentValueLabel: nil
        )
    }
}

public extension UIFnSegmentedMeter where Label == Text, CurrentValueLabel == EmptyView {
    /// A meter labeled with a title already localized, shown as it is.
    ///
    /// Like the other UIFn components, the meter does not look the title up
    /// in a strings table; to label it with a localized key, pass the label
    /// as a view, such as `Text("storage.title")`.
    init<Title: StringProtocol, Value: BinaryFloatingPoint>(
        _ title: Title,
        value: Value,
        in bounds: ClosedRange<Value> = 0...1,
        segments: Int = 5,
        tone: UIFnTone = .accent
    ) {
        self.init(value: value, in: bounds, segments: segments, tone: tone) { Text(verbatim: String(title)) }
    }
}

/// How a segmented meter turns its value into lit segments and a percentage.
enum UIFnMeterValue {
    /// The fewest segments a meter draws: with fewer, a value inside the
    /// range would have to show as empty or full.
    static let minimumSegments = 2

    /// The most segments a meter draws.
    static let maximumSegments = 100

    /// The segments a meter asked for `segments` draws: from
    /// ``minimumSegments`` to ``maximumSegments``.
    static func segmentCount(_ segments: Int) -> Int {
        min(max(segments, minimumSegments), maximumSegments)
    }

    /// How far `value` is through `bounds`, from 0 to 1: the nearer end for a
    /// value at or outside them, and 0 for a value that is not a number or
    /// bounds that are infinite or have no width.
    ///
    /// A value strictly inside the bounds is never read as an end, however
    /// close to one it is: its share is worked out in `Double`, which holds
    /// every narrower value exactly, or in `Value` when that is wider, such as
    /// `Float80`, and kept above 0 and below 1. Bounds too far apart for their difference to be
    /// finite, such as `-greatestFiniteMagnitude...greatestFiniteMagnitude`,
    /// are halved, with the value, before subtracting, which keeps the
    /// difference finite and the share the same.
    static func fraction<Value: BinaryFloatingPoint>(_ value: Value, in bounds: ClosedRange<Value>) -> Double {
        let lower = bounds.lowerBound
        let upper = bounds.upperBound
        guard lower.isFinite, upper.isFinite, lower < upper, !value.isNaN else { return 0 }
        if value <= lower { return 0 }
        if value >= upper { return 1 }
        let fitsInDouble = Value.significandBitCount <= Double.significandBitCount
            && Value.exponentBitCount <= Double.exponentBitCount
        let share = fitsInDouble
            ? interiorShare(Double(value), from: Double(lower), to: Double(upper))
            : Double(interiorShare(value, from: lower, to: upper))
        return min(max(share, .leastNonzeroMagnitude), Double(1).nextDown)
    }

    /// How far `value` is from `lower` to `upper`, finite bounds with
    /// `lower < upper`, halving them and the value when their difference
    /// would not be finite.
    private static func interiorShare<Number: BinaryFloatingPoint>(
        _ value: Number, from lower: Number, to upper: Number
    ) -> Number {
        let width = upper - lower
        if width.isFinite { return (value - lower) / width }
        return (value / 2 - lower / 2) / (upper / 2 - lower / 2)
    }

    /// How many of `segments` segments a fraction lights: its share rounded to
    /// the nearest segment, at least one above 0 and at most all but one below 1.
    static func litSegments(_ fraction: Double, of segments: Int) -> Int {
        let fraction = UIFnProgress.clamped(fraction)
        let segments = segmentCount(segments)
        if fraction <= 0 { return 0 }
        if fraction >= 1 { return segments }
        let nearest = Int((fraction * Double(segments)).rounded())
        return min(max(nearest, 1), segments - 1)
    }

    /// The whole percentage a fraction reads as: its share of 100, rounded,
    /// except that a fraction above 0 reads at least 1 and one below 1 at
    /// most 99, as the lit segments never show such a value empty or full.
    static func percent(_ fraction: Double) -> Int {
        let fraction = UIFnProgress.clamped(fraction)
        if fraction <= 0 { return 0 }
        if fraction >= 1 { return 100 }
        return min(max(Int((fraction * 100).rounded()), 1), 99)
    }

    /// The fraction as a whole percentage in the environment's locale, such as “40%”.
    static func percentText(_ fraction: Double) -> Text {
        Text(Double(percent(fraction)) / 100, format: .percent.precision(.fractionLength(0)))
    }
}

/// How a segmented meter looks at a fraction from 0 to 1.
struct UIFnSegmentedMeterAppearance<Label: View, CurrentValueLabel: View>: View {
    let fraction: Double
    let segments: Int
    let tone: UIFnTone
    let label: Label
    var currentValueLabel: CurrentValueLabel?
    @UIFnStyleEnvironment private var context

    var body: some View {
        let colors = context.colors.tone(tone)
        let lit = UIFnMeterValue.litSegments(fraction, of: segments)
        let gap = context.scaled(2)
        VStack(alignment: .leading, spacing: context.scaled(context.spacing.space1)) {
            HStack(alignment: .firstTextBaseline, spacing: context.scaled(context.spacing.space2)) {
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
            ZStack {
                UIFnMeterSegments(count: segments, lit: lit..<segments, gap: gap, cornerRadius: context.radius.sm)
                    .fill(context.color(colors.subtle))
                UIFnMeterSegments(count: segments, lit: 0..<lit, gap: gap, cornerRadius: context.radius.sm)
                    .fill(context.color(colors.solid))
            }
            .flipsForRightToLeftLayoutDirection(true)
            .frame(idealWidth: 160)
            .frame(height: context.scaled(8))
        }
    }
}

/// Some of `count` equal segments side by side across the width, left to
/// right, `gap` apart. Like the meter, a count below its minimum draws the
/// minimum and one above its maximum draws the maximum.
///
/// The gap shrinks when the segments would be narrower than it, so every
/// segment keeps some width.
struct UIFnMeterSegments: Shape {
    let count: Int
    let lit: Range<Int>
    let gap: CGFloat
    let cornerRadius: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard rect.width > 0 else { return path }
        let count = UIFnMeterValue.segmentCount(count)
        let gap = min(gap, rect.width / (CGFloat(count) * 2))
        let width = (rect.width - gap * CGFloat(count - 1)) / CGFloat(count)
        let radius = min(cornerRadius, width / 2, rect.height / 2)
        for index in lit.clamped(to: 0..<count) {
            let segment = CGRect(x: rect.minX + CGFloat(index) * (width + gap), y: rect.minY, width: width, height: rect.height)
            path.addRoundedRect(in: segment, cornerSize: CGSize(width: radius, height: radius), style: .continuous)
        }
        return path
    }
}
