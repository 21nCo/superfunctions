import SwiftUI

/// A meter drawn as a row of segments that light from the leading edge, with
/// the environment's ``SwiftUI/EnvironmentValues/uifnTheme``: lit segments in
/// the tone's solid color over its subtle tone, the label above them and the
/// current value label, when there is one, at the label's trailing end.
///
/// The value lights its share of the segments, rounded to the nearest one,
/// except that a value above the range's minimum always lights one and a
/// value below its maximum always leaves one unlit, so neither reads as empty
/// or full when it is not. Values outside the range draw as the nearer end,
/// and a value that is not a number, or a range with no width, as empty.
///
/// Accessibility sees a progress indicator with the label, whose value is the
/// meter's value as a percentage of its range, such as “40%”.
public struct UIFnSegmentedMeter<Label: View, CurrentValueLabel: View>: View {
    private let fraction: Double
    private let segments: Int
    private let tone: UIFnTone
    private let label: Label
    private let currentValueLabel: CurrentValueLabel?

    /// A meter of `segments` segments, at least one, showing `value` within `bounds`.
    public init<Value: BinaryFloatingPoint>(
        value: Value,
        in bounds: ClosedRange<Value> = 0...1,
        segments: Int = 5,
        tone: UIFnTone = .accent,
        @ViewBuilder label: () -> Label,
        @ViewBuilder currentValueLabel: () -> CurrentValueLabel
    ) {
        self.init(
            fraction: UIFnMeterValue.fraction(Double(value), in: Double(bounds.lowerBound)...Double(bounds.upperBound)),
            segments: segments,
            tone: tone,
            label: label(),
            currentValueLabel: currentValueLabel()
        )
    }

    fileprivate init(fraction: Double, segments: Int, tone: UIFnTone, label: Label, currentValueLabel: CurrentValueLabel?) {
        self.fraction = fraction
        self.segments = max(segments, 1)
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
            ProgressView(value: fraction) { label }
                .accessibilityValue(UIFnMeterValue.percentText(fraction))
        }
    }
}

public extension UIFnSegmentedMeter where CurrentValueLabel == EmptyView {
    /// A meter of `segments` segments, at least one, showing `value` within `bounds`.
    init<Value: BinaryFloatingPoint>(
        value: Value,
        in bounds: ClosedRange<Value> = 0...1,
        segments: Int = 5,
        tone: UIFnTone = .accent,
        @ViewBuilder label: () -> Label
    ) {
        self.init(
            fraction: UIFnMeterValue.fraction(Double(value), in: Double(bounds.lowerBound)...Double(bounds.upperBound)),
            segments: segments,
            tone: tone,
            label: label(),
            currentValueLabel: nil
        )
    }
}

public extension UIFnSegmentedMeter where Label == Text, CurrentValueLabel == EmptyView {
    /// A meter labeled with a localized title.
    init<Value: BinaryFloatingPoint>(
        _ titleKey: LocalizedStringKey,
        value: Value,
        in bounds: ClosedRange<Value> = 0...1,
        segments: Int = 5,
        tone: UIFnTone = .accent
    ) {
        self.init(value: value, in: bounds, segments: segments, tone: tone) { Text(titleKey) }
    }

    /// A meter labeled with a string, shown as it is.
    @_disfavoredOverload
    init<Title: StringProtocol, Value: BinaryFloatingPoint>(
        _ title: Title,
        value: Value,
        in bounds: ClosedRange<Value> = 0...1,
        segments: Int = 5,
        tone: UIFnTone = .accent
    ) {
        self.init(value: value, in: bounds, segments: segments, tone: tone) { Text(title) }
    }
}

/// How a segmented meter turns its value into lit segments and a percentage.
enum UIFnMeterValue {
    /// How far `value` is through `bounds`, from 0 to 1: the nearer end for a
    /// value outside them, and 0 for a value that is not a number or bounds
    /// with no finite, positive width.
    static func fraction(_ value: Double, in bounds: ClosedRange<Double>) -> Double {
        let width = bounds.upperBound - bounds.lowerBound
        guard width > 0, width.isFinite, !value.isNaN else { return 0 }
        return UIFnProgress.clamped((value - bounds.lowerBound) / width)
    }

    /// How many of `segments` segments a fraction lights: its share rounded to
    /// the nearest segment, at least one above 0 and at most all but one below 1.
    static func litSegments(_ fraction: Double, of segments: Int) -> Int {
        let fraction = UIFnProgress.clamped(fraction)
        let segments = max(segments, 1)
        if fraction <= 0 { return 0 }
        if fraction >= 1 { return segments }
        let nearest = Int((fraction * Double(segments)).rounded())
        return min(max(nearest, 1), segments - 1)
    }

    /// The fraction as a whole percentage in the environment's locale, such as “40%”.
    static func percentText(_ fraction: Double) -> Text {
        Text(fraction, format: .percent.precision(.fractionLength(0)))
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
/// right, `gap` apart.
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
        guard count > 0, rect.width > 0 else { return path }
        let gap = min(gap, rect.width / CGFloat(count * 2))
        let width = (rect.width - gap * CGFloat(count - 1)) / CGFloat(count)
        let radius = min(cornerRadius, width / 2, rect.height / 2)
        for index in lit.clamped(to: 0..<count) {
            let segment = CGRect(x: rect.minX + CGFloat(index) * (width + gap), y: rect.minY, width: width, height: rect.height)
            path.addRoundedRect(in: segment, cornerSize: CGSize(width: radius, height: radius), style: .continuous)
        }
        return path
    }
}
