import SwiftUI

/// A switch toggle style drawn with the environment's ``SwiftUI/EnvironmentValues/uifnTheme``:
/// the label, then a track that fills with the accent color when on.
///
/// The toggle stays a toggle to accessibility; the style changes only how it
/// looks. Like the system switch, a press flips the binding and a drag across
/// the track sets it from the half of the track the drag ends over; a drag up
/// or down sets nothing.
///
/// Like the system styles, it draws no label under `labelsHidden()`, and
/// accessibility still reads the label. `labelsVisibility(_:)` works from
/// iOS 18 and macOS 15, where SwiftUI has it.
public struct UIFnSwitchToggleStyle: ToggleStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        UIFnToggleStyleBody(configuration: configuration, kind: .switch)
    }
}

/// A checkbox toggle style drawn with the environment's ``SwiftUI/EnvironmentValues/uifnTheme``:
/// a box that fills with the accent color and shows a check when on, or a dash
/// when mixed, then the label.
///
/// The toggle stays a toggle to accessibility; the style changes only how it
/// looks and flips the binding when pressed like the system styles do.
///
/// Like the system styles, it draws no label under `labelsHidden()`, and
/// accessibility still reads the label. `labelsVisibility(_:)` works from
/// iOS 18 and macOS 15, where SwiftUI has it.
public struct UIFnCheckboxToggleStyle: ToggleStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        UIFnToggleStyleBody(configuration: configuration, kind: .checkbox)
    }
}

public extension ToggleStyle where Self == UIFnSwitchToggleStyle {
    /// The UIFn switch toggle style.
    static var uifnSwitch: UIFnSwitchToggleStyle { UIFnSwitchToggleStyle() }
}

public extension ToggleStyle where Self == UIFnCheckboxToggleStyle {
    /// The UIFn checkbox toggle style.
    static var uifnCheckbox: UIFnCheckboxToggleStyle { UIFnCheckboxToggleStyle() }
}

/// Which control a UIFn toggle draws.
enum UIFnToggleKind {
    case `switch`, checkbox
}

/// Whether a toggle is off, on or mixed.
enum UIFnToggleValue: Equatable {
    case off, on, mixed

    init(isOn: Bool, isMixed: Bool) {
        self = isMixed ? .mixed : isOn ? .on : .off
    }
}

private struct UIFnToggleStyleBody: View {
    let configuration: ToggleStyleConfiguration
    let kind: UIFnToggleKind

    var body: some View {
        let value = UIFnToggleValue(isOn: configuration.isOn, isMixed: configuration.isMixed)
        // A button gives the toggle the system's press tracking, keyboard
        // activation and focus; accessibility sees a toggle instead.
        Button {
            configuration.isOn.toggle()
        } label: {
            configuration.label
        }
        .buttonStyle(UIFnToggleButtonStyle(kind: kind, value: value, onDragEnd: kind == .switch ? setFromDrag : nil))
        .accessibilityRepresentation {
            representation
        }
    }

    /// Sets a switch from the side of its track a drag ended over, unless the
    /// drag ended on the side the thumb started.
    private func setFromDrag(endedOnTrailingSide isTrailing: Bool) {
        let value = UIFnToggleValue(isOn: configuration.isOn, isMixed: configuration.isMixed)
        if isTrailing != (value != .off) {
            configuration.isOn = isTrailing
        }
    }

    @ViewBuilder
    private var representation: some View {
        let toggle = UIFnAccessibilityToggle(
            value: UIFnToggleValue(isOn: configuration.isOn, isMixed: configuration.isMixed),
            isOn: configuration.$isOn
        ) {
            configuration.label
        }
        #if os(macOS)
        switch kind {
        case .switch: toggle.toggleStyle(.switch)
        case .checkbox: toggle.toggleStyle(.checkbox)
        }
        #else
        toggle.toggleStyle(.switch)
        #endif
    }
}

/// The system toggle accessibility sees in place of a UIFn toggle: off, on or
/// mixed like the UIFn toggle, and setting it sets the UIFn toggle.
struct UIFnAccessibilityToggle<Label: View>: View {
    let value: UIFnToggleValue
    let isOn: Binding<Bool>
    @ViewBuilder let label: () -> Label

    var body: some View {
        if value == .mixed {
            // Sources that disagree make a system toggle mixed. Only the
            // first passes a new value on, so it is set once.
            let sources = [Binding(get: { true }, set: { isOn.wrappedValue = $0 }), .constant(false)]
            Toggle(sources: sources, isOn: \.self, label: label)
        } else {
            Toggle(isOn: isOn, label: label)
        }
    }
}

private struct UIFnToggleButtonStyle: ButtonStyle {
    let kind: UIFnToggleKind
    let value: UIFnToggleValue
    let onDragEnd: ((Bool) -> Void)?

    func makeBody(configuration: Configuration) -> some View {
        UIFnToggleButtonBody(
            label: configuration.label,
            kind: kind,
            value: value,
            isPressed: configuration.isPressed,
            onDragEnd: onDragEnd
        )
    }
}

private struct UIFnToggleButtonBody<Label: View>: View {
    let label: Label
    let kind: UIFnToggleKind
    let value: UIFnToggleValue
    let isPressed: Bool
    let onDragEnd: ((Bool) -> Void)?
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var isFocused

    var body: some View {
        UIFnToggleAppearance(
            label: label,
            kind: kind,
            value: value,
            state: UIFnControlState(isPressed: isPressed, isEnabled: isEnabled, isFocused: isFocused),
            onSwitchDragEnd: onDragEnd
        )
    }
}

/// How a UIFn toggle looks with one value in one state.
struct UIFnToggleAppearance<Label: View>: View {
    let label: Label
    let kind: UIFnToggleKind
    let value: UIFnToggleValue
    let state: UIFnControlState
    /// Called with whether a drag across the switch track ended over its
    /// trailing half. Without it the track takes no drags.
    var onSwitchDragEnd: ((Bool) -> Void)?
    @UIFnStyleEnvironment private var context
    @Environment(\.layoutDirection) private var layoutDirection
    @GestureState private var isDragging = false

    /// How far a press must move before the switch takes it as a drag rather
    /// than a click or tap.
    private static var switchDragDistance: CGFloat { 6 }

    var body: some View {
        row
            .opacity(state.isEnabled ? 1 : UIFnStyleContext.disabledOpacity)
        .animation(context.stateAnimation, value: value)
        .animation(context.stateAnimation, value: state)
    }

    @ViewBuilder
    private var row: some View {
        // The label brings the spacing next to the control, so a hidden or
        // empty label leaves none.
        let spacing = context.scaled(context.spacing.space3)
        switch kind {
        case .switch:
            // Like the system switch, only the track takes presses.
            HStack(spacing: 0) {
                labelText(spacing: spacing, after: true).allowsHitTesting(false)
                control
            }
        case .checkbox:
            // Like the system checkbox, the whole row takes presses.
            HStack(spacing: 0) {
                control
                labelText(spacing: spacing, after: false)
            }
            .contentShape(Rectangle())
        }
    }

    private func labelText(spacing: CGFloat, after: Bool) -> some View {
        UIFnHidableLabel(spacing: spacing, isSpacingAfter: after) {
            label
                .uifnFont(context.typography.size.md, weight: context.typography.weight.regular)
                .foregroundColor(context.color(context.colors.text.primary))
        }
    }

    @ViewBuilder
    private var control: some View {
        switch kind {
        case .switch: switchTrack
        case .checkbox: checkbox
        }
    }

    private var isPressed: Bool { (state.isPressed || isDragging) && state.isEnabled }

    private var switchTrack: some View {
        let colors = context.colors
        let width = context.scaled(44)
        let height = context.scaled(24)
        let inset = context.scaled(3)
        let thumb = height - inset * 2
        let isOn = value != .off
        return Capsule(style: .continuous)
            .fill(context.color(isOn ? colors.accent.solid : colors.border.strong))
            .overlay {
                if isPressed {
                    Capsule(style: .continuous).fill(context.pressedTint)
                }
            }
            .overlay(alignment: isOn ? .trailing : .leading) {
                Circle()
                    .fill(context.color(colors.surface.raised))
                    .frame(width: thumb, height: thumb)
                    .shadow(color: .black.opacity(0.28), radius: 1.5, y: 1)
                    .padding(inset)
            }
            .frame(width: width, height: height)
            .contentShape(Capsule(style: .continuous))
            .gesture(switchDrag(width: width), including: onSwitchDragEnd == nil ? .none : .all)
            .uifnFocusRing(state.isFocused && state.isEnabled, cornerRadius: height / 2, context: context)
    }

    /// A drag across the track, which wins over the button's press once it
    /// moves far enough. Like the system switch, a drag that ends further up
    /// or down than across sets nothing. Drag locations run left to right in
    /// either layout direction, so right to left the trailing half is the left
    /// one.
    private func switchDrag(width: CGFloat) -> some Gesture {
        let isRightToLeft = layoutDirection == .rightToLeft
        return DragGesture(minimumDistance: Self.switchDragDistance)
            .updating($isDragging) { _, isDragging, _ in isDragging = true }
            .onEnded { drag in
                guard state.isEnabled, abs(drag.translation.width) > abs(drag.translation.height) else { return }
                let isRightHalf = drag.location.x >= width / 2
                onSwitchDragEnd?(isRightHalf != isRightToLeft)
            }
    }

    private var checkbox: some View {
        let colors = context.colors
        let side = context.scaled(22)
        let radius = context.radius.md
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        let isOn = value != .off
        let accent = context.color(colors.accent.solid)
        return shape
            .fill(isOn ? accent : context.color(colors.surface.raised))
            .overlay {
                shape.strokeBorder(isOn ? accent : context.color(colors.border.strong), lineWidth: 1)
            }
            .overlay {
                if isPressed {
                    shape.fill(context.pressedTint)
                }
            }
            .overlay {
                UIFnCheckboxMark(value: value)
                    .stroke(
                        context.color(colors.accent.contrast),
                        style: StrokeStyle(lineWidth: max(2, side / 11), lineCap: .round, lineJoin: .round)
                    )
                    .padding(side * 0.25)
            }
            .frame(width: side, height: side)
            .uifnFocusRing(state.isFocused && state.isEnabled, cornerRadius: radius, context: context)
    }
}

/// A toggle's visible label and the spacing between it and the control, both
/// left out where labels are hidden or the label is empty. A label of several
/// views is drawn as one leading-aligned column. Only iOS 18, macOS 15 and
/// later tell a style that labels are hidden; earlier, the label is drawn as
/// the label of a `LabeledContent` with no content, which SwiftUI leaves out
/// under `labelsHidden()`.
private struct UIFnHidableLabel<Content: View>: View {
    let spacing: CGFloat
    let isSpacingAfter: Bool
    @ViewBuilder let content: () -> Content
    @Environment(\.uifnHidesLabelsWithLabeledContent) private var hidesWithLabeledContent

    var body: some View {
        UIFnLabelSlot(spacing: spacing, isSpacingAfter: isSpacingAfter) {
            if #available(iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, visionOS 2.0, *), !hidesWithLabeledContent {
                UIFnVisibleLabel(content: column)
            } else {
                // Some containers, such as forms, put space after the label
                // of a `LabeledContent`. An empty label shows how much, so the
                // slot can leave it out.
                LabeledContent {
                    EmptyView()
                } label: {
                    Color.clear.frame(width: 0, height: 0)
                }
                .layoutValue(key: UIFnLabeledContentSpaceKey.self, value: true)
                LabeledContent {
                    EmptyView()
                } label: {
                    column()
                }
            }
        }
    }

    /// The label as one view, since the slot would otherwise lay out each
    /// view of a label of several views on its own.
    private func column() -> some View {
        VStack(alignment: .leading) {
            content()
        }
    }
}

/// Marks the empty `LabeledContent` that measures the space a container puts
/// after a label.
private struct UIFnLabeledContentSpaceKey: LayoutValueKey {
    static let defaultValue = false
}

/// Lays out a toggle label with spacing on the side of the control. A label
/// that takes no width, because it is hidden or empty, gets no spacing.
private struct UIFnLabelSlot: Layout {
    let spacing: CGFloat
    let isSpacingAfter: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let label = measure(proposal: proposal, subviews: subviews) else { return .zero }
        return CGSize(width: label.width + spacing, height: label.size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let label = measure(proposal: proposal, subviews: subviews)
        for subview in subviews {
            guard let label, subview == label.subview else {
                subview.place(at: bounds.origin, proposal: .zero)
                continue
            }
            let x = isSpacingAfter ? bounds.minX : bounds.minX + spacing
            subview.place(at: CGPoint(x: x, y: bounds.minY), proposal: ProposedViewSize(label.size))
        }
    }

    /// The label's spacing to views next to the slot, or the default spacing
    /// when the label takes no width.
    func spacing(subviews: Subviews, cache: inout ()) -> ViewSpacing {
        measure(proposal: .unspecified, subviews: subviews)?.subview.spacing ?? ViewSpacing()
    }

    /// The label shows no column guides a form gives `LabeledContent`.
    func explicitAlignment(
        of guide: HorizontalAlignment,
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGFloat? {
        nil
    }

    /// The label's own guides, such as its text baselines.
    func explicitAlignment(
        of guide: VerticalAlignment,
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGFloat? {
        guard let label = measure(proposal: proposal, subviews: subviews) else { return nil }
        return label.subview.dimensions(in: ProposedViewSize(label.size))[explicit: guide].map { bounds.minY + $0 }
    }

    /// The label, its size and the width it takes without the space a
    /// container puts after it, or nil when it takes none. The label takes
    /// no more than its ideal width, as text does, though `LabeledContent`
    /// fills the width it is offered on some platforms.
    private func measure(
        proposal: ProposedViewSize,
        subviews: Subviews
    ) -> (subview: LayoutSubview, size: CGSize, width: CGFloat)? {
        let space = subviews.first { $0[UIFnLabeledContentSpaceKey.self] }?.sizeThatFits(.unspecified).width ?? 0
        guard let label = subviews.first(where: { !$0[UIFnLabeledContentSpaceKey.self] }) else { return nil }
        let ideal = label.sizeThatFits(ProposedViewSize(width: nil, height: proposal.height)).width
        let width = proposal.width.map { min(ideal, max(0, $0 - spacing) + space) } ?? ideal
        let size = label.sizeThatFits(ProposedViewSize(width: width, height: proposal.height))
        let takenWidth = size.width - space
        return takenWidth > 0.5 ? (label, size, takenWidth) : nil
    }
}

private struct UIFnHidesLabelsWithLabeledContentKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Whether UIFn toggles hide their labels the way they do before iOS 18
    /// and macOS 15, so tests can check that path on later versions.
    var uifnHidesLabelsWithLabeledContent: Bool {
        get { self[UIFnHidesLabelsWithLabeledContentKey.self] }
        set { self[UIFnHidesLabelsWithLabeledContentKey.self] = newValue }
    }
}

@available(iOS 18.0, macOS 15.0, tvOS 18.0, watchOS 11.0, visionOS 2.0, *)
private struct UIFnVisibleLabel<Content: View>: View {
    let content: () -> Content
    @Environment(\.labelsVisibility) private var visibility

    var body: some View {
        if visibility != .hidden {
            content()
        }
    }
}

/// The check or dash inside a checked or mixed checkbox.
struct UIFnCheckboxMark: Shape {
    let value: UIFnToggleValue

    func path(in rect: CGRect) -> Path {
        var path = Path()
        switch value {
        case .off:
            break
        case .on:
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.38, y: rect.maxY - rect.height * 0.1))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.1))
        case .mixed:
            path.move(to: CGPoint(x: rect.minX, y: rect.midY))
            path.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
        }
        return path
    }
}
