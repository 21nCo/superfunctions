import SwiftUI

// SwiftUI has no public way to write a picker style, so the UIFn pickers are
// views that draw the theme around a system `Picker`: the menu picker puts one
// in a ``UIFnMenuStyle`` menu, and the segmented picker shows accessibility a
// segmented one in its place.

/// How a ``UIFnSegmentedPicker`` looks.
public enum UIFnSegmentedPickerVariant: String, CaseIterable, Sendable {
    /// Segments in a sunken track, the selected one raised.
    case segmented
    /// Tabs over a rule, the selected one underlined with the accent color.
    case tabs
}

/// A segmented picker, or tab switcher, drawn with the environment's
/// ``SwiftUI/EnvironmentValues/uifnTheme``: one segment for each option, the
/// selected one raised (``UIFnSegmentedPickerVariant/segmented``) or
/// underlined (``UIFnSegmentedPickerVariant/tabs``).
///
/// ```swift
/// UIFnSegmentedPicker("View", selection: $view, options: [.list, .grid], variant: .tabs) { view in
///     Text(view.title)
/// }
/// ```
///
/// A click or tap on a segment selects its option. On macOS the picker takes
/// keyboard focus as one control, with the focus ring around the selected
/// segment: the left and right arrows select the option beside the selected
/// one, in the reading direction of the layout, and stop at the first and
/// last; with no option selected they select the first or last.
/// Accessibility sees a system segmented `Picker` with the same options and
/// selection in its place, so the label is read but not drawn.
///
/// The segments share the width offered equally, like an iOS segmented
/// control; under `fixedSize()` each is as wide as the widest. Options that
/// repeat an earlier option are left out, and a selection that is not among
/// the options selects no segment.
public struct UIFnSegmentedPicker<Label: View, SelectionValue: Hashable, Segment: View>: View {
    private let selection: Binding<SelectionValue>
    private let options: [SelectionValue]
    private let variant: UIFnSegmentedPickerVariant
    private let label: Label
    private let segment: (SelectionValue) -> Segment
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.layoutDirection) private var layoutDirection
    /// The picker's own focus, so a `focused(_:)` binding the app applies
    /// around the picker keeps working.
    @FocusState private var isFocused: Bool
    @UIFnStyleEnvironment private var context

    public init<Options: Sequence>(
        selection: Binding<SelectionValue>,
        options: Options,
        variant: UIFnSegmentedPickerVariant = .segmented,
        @ViewBuilder label: () -> Label,
        @ViewBuilder segment: @escaping (SelectionValue) -> Segment
    ) where Options.Element == SelectionValue {
        self.selection = selection
        self.options = uifnUniqueOptions(options)
        self.variant = variant
        self.label = label()
        self.segment = segment
    }

    public var body: some View {
        let selected = options.firstIndex(of: selection.wrappedValue)
        UIFnSegmentedTrack(variant: variant) {
            ForEach(0..<options.count, id: \.self) { index in
                segmentButton(index, selected: selected)
            }
        }
        // The selected segment draws the ring; with none, the whole picker does.
        .uifnFocusRing(
            isFocused && isEnabled && selected == nil,
            cornerRadius: variant == .segmented ? context.radius.md : context.radius.sm,
            context: context
        )
        #if os(macOS)
        .modifier(UIFnSegmentedKeyboard(isEnabled: isEnabled, isFocused: $isFocused, move: move))
        #endif
        .accessibilityRepresentation {
            Picker(selection: selection) {
                uifnTaggedOptions(options, content: segment)
            } label: {
                label
            }
            .pickerStyle(.segmented)
        }
    }

    private func segmentButton(_ index: Int, selected: Int?) -> some View {
        Button {
            select(index)
        } label: {
            segment(options[index])
        }
        .buttonStyle(UIFnSegmentButtonStyle(
            variant: variant,
            isSelected: index == selected,
            isFocused: isFocused && index == selected
        ))
        #if os(macOS)
        // The picker takes focus as one control, not one per segment.
        .focusable(false)
        #endif
    }

    private func select(_ index: Int) {
        guard options.indices.contains(index), options[index] != selection.wrappedValue else { return }
        selection.wrappedValue = options[index]
    }

    #if os(macOS)
    /// Selects the option beside the selected one, in the arrow's direction
    /// on screen.
    private func move(_ direction: MoveCommandDirection) {
        let isRightToLeft = layoutDirection == .rightToLeft
        let forward: Bool
        switch direction {
        case .left: forward = isRightToLeft
        case .right: forward = !isRightToLeft
        default: return
        }
        let current = options.firstIndex(of: selection.wrappedValue)
        guard let next = UIFnSegmentedSelection.index(after: current, forward: forward, count: options.count) else { return }
        select(next)
    }
    #endif
}

public extension UIFnSegmentedPicker where Label == Text {
    /// A segmented picker whose accessibility label is a localized title.
    init<Options: Sequence>(
        _ titleKey: LocalizedStringKey,
        selection: Binding<SelectionValue>,
        options: Options,
        variant: UIFnSegmentedPickerVariant = .segmented,
        @ViewBuilder segment: @escaping (SelectionValue) -> Segment
    ) where Options.Element == SelectionValue {
        self.init(selection: selection, options: options, variant: variant, label: { Text(titleKey) }, segment: segment)
    }

    /// A segmented picker whose accessibility label is a title string.
    @_disfavoredOverload
    init<Title: StringProtocol, Options: Sequence>(
        _ title: Title,
        selection: Binding<SelectionValue>,
        options: Options,
        variant: UIFnSegmentedPickerVariant = .segmented,
        @ViewBuilder segment: @escaping (SelectionValue) -> Segment
    ) where Options.Element == SelectionValue {
        self.init(selection: selection, options: options, variant: variant, label: { Text(title) }, segment: segment)
    }
}

/// Which segment the arrow keys select.
enum UIFnSegmentedSelection {
    /// The index of the segment after (or, not `forward`, before) `current`
    /// among `count`, or nil at the end. With no current segment, the first
    /// (or last).
    static func index(after current: Int?, forward: Bool, count: Int) -> Int? {
        guard count > 0 else { return nil }
        guard let current, (0..<count).contains(current) else { return forward ? 0 : count - 1 }
        let next = forward ? current + 1 : current - 1
        return (0..<count).contains(next) ? next : nil
    }
}

#if os(macOS)
/// Makes the picker one focusable control whose arrow keys move the selection.
private struct UIFnSegmentedKeyboard: ViewModifier {
    let isEnabled: Bool
    let isFocused: FocusState<Bool>.Binding
    let move: (MoveCommandDirection) -> Void

    func body(content: Content) -> some View {
        let keyboard = content
            .focusable(isEnabled)
            .focused(isFocused)
            .onMoveCommand(perform: isEnabled ? move : nil)
        // The picker draws its own focus ring.
        if #available(macOS 14.0, *) {
            keyboard.focusEffectDisabled()
        } else {
            keyboard
        }
    }
}
#endif

/// The options in order, without any that repeat an earlier one.
func uifnUniqueOptions<Options: Sequence>(_ options: Options) -> [Options.Element] where Options.Element: Hashable {
    var seen = Set<Options.Element>()
    return options.filter { seen.insert($0).inserted }
}

/// A system picker's content: each option's view tagged with the option.
@ViewBuilder
func uifnTaggedOptions<SelectionValue: Hashable, Content: View>(
    _ options: [SelectionValue],
    content: @escaping (SelectionValue) -> Content
) -> some View {
    ForEach(options, id: \.self) { option in
        content(option).tag(option)
    }
}

/// Draws a segment of a UIFn segmented picker.
private struct UIFnSegmentButtonStyle: ButtonStyle {
    let variant: UIFnSegmentedPickerVariant
    let isSelected: Bool
    let isFocused: Bool

    func makeBody(configuration: Configuration) -> some View {
        UIFnSegmentButtonBody(
            label: configuration.label,
            variant: variant,
            isSelected: isSelected,
            isPressed: configuration.isPressed,
            isFocused: isFocused
        )
    }
}

private struct UIFnSegmentButtonBody<Label: View>: View {
    let label: Label
    let variant: UIFnSegmentedPickerVariant
    let isSelected: Bool
    let isPressed: Bool
    let isFocused: Bool
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        UIFnSegmentAppearance(
            label: label,
            variant: variant,
            isSelected: isSelected,
            state: UIFnControlState(isPressed: isPressed, isEnabled: isEnabled, isFocused: isFocused)
        )
    }
}

/// The track of a UIFn segmented picker around its segments: sunken for
/// ``UIFnSegmentedPickerVariant/segmented``, a rule under the tabs for
/// ``UIFnSegmentedPickerVariant/tabs``. A disabled track fades.
struct UIFnSegmentedTrack<Content: View>: View {
    let variant: UIFnSegmentedPickerVariant
    @ViewBuilder let content: () -> Content
    @UIFnStyleEnvironment private var context
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        let colors = context.colors
        Group {
            switch variant {
            case .segmented:
                let shape = RoundedRectangle(cornerRadius: context.radius.md, style: .continuous)
                UIFnSegmentsLayout { content() }
                    .padding(Self.inset(context))
                    .background(shape.fill(context.color(colors.surface.sunken)))
                    .overlay(shape.strokeBorder(context.color(colors.border.default), lineWidth: 1).allowsHitTesting(false))
            case .tabs:
                UIFnSegmentsLayout { content() }
                    .background(alignment: .bottom) {
                        Rectangle()
                            .fill(context.color(colors.border.default))
                            .frame(height: 1)
                    }
            }
        }
        .opacity(isEnabled ? 1 : UIFnStyleContext.disabledOpacity)
    }

    /// The space between a segmented track's border and its segments.
    static func inset(_ context: UIFnStyleContext) -> CGFloat {
        context.scaled(2)
    }
}

/// How one segment of a UIFn segmented picker looks in one state. The
/// segment draws the focus ring when `state.isFocused`: the selected segment
/// of a focused picker.
struct UIFnSegmentAppearance<Label: View>: View {
    let label: Label
    let variant: UIFnSegmentedPickerVariant
    let isSelected: Bool
    let state: UIFnControlState
    @UIFnStyleEnvironment private var context

    var body: some View {
        let colors = context.colors
        let isPressed = state.isPressed && state.isEnabled
        let inset = UIFnSegmentedTrack<EmptyView>.inset(context)
        let radius = variant == .segmented ? max(0, context.radius.md - inset) : context.radius.sm
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        label
            .uifnFont(context.typography.size.md, weight: context.typography.weight.medium)
            .foregroundColor(context.color(isSelected ? colors.text.primary : colors.text.secondary))
            .lineLimit(1)
            .padding(.horizontal, context.scaled(context.spacing.space3))
            .padding(.vertical, variant == .segmented ? context.scaled(context.spacing.space2) - inset : context.scaled(context.spacing.space2))
            .frame(maxWidth: .infinity)
            .background {
                if variant == .segmented && isSelected {
                    shape
                        .fill(context.color(colors.surface.raised))
                        .shadow(color: .black.opacity(0.12), radius: 1, y: 1)
                        .overlay(shape.strokeBorder(context.color(colors.border.subtle), lineWidth: 1))
                }
            }
            .overlay(alignment: .bottom) {
                if variant == .tabs && isSelected {
                    Rectangle()
                        .fill(context.color(colors.accent.solid))
                        .frame(height: context.scaled(2))
                }
            }
            .overlay {
                if isPressed {
                    shape.fill(context.pressedTint)
                }
            }
            .contentShape(shape)
            .uifnFocusRing(state.isFocused && state.isEnabled, cornerRadius: radius, context: context)
            .animation(context.stateAnimation, value: isSelected)
            .animation(context.stateAnimation, value: state)
    }
}

/// Lays out segments side by side at equal widths: the width offered, or,
/// with no width offered, the widest segment's for each.
struct UIFnSegmentsLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard !subviews.isEmpty else { return .zero }
        let width = proposal.width.flatMap { $0.isFinite ? $0 : nil }
            ?? (subviews.map { $0.sizeThatFits(.unspecified).width }.max() ?? 0) * CGFloat(subviews.count)
        let segment = ProposedViewSize(width: width / CGFloat(subviews.count), height: proposal.height)
        let height = subviews.map { $0.sizeThatFits(segment).height }.max() ?? 0
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard !subviews.isEmpty else { return }
        let width = bounds.width / CGFloat(subviews.count)
        for (index, subview) in subviews.enumerated() {
            subview.place(
                at: CGPoint(x: bounds.minX + width * CGFloat(index), y: bounds.minY),
                proposal: ProposedViewSize(width: width, height: bounds.height)
            )
        }
    }
}

/// A menu picker drawn with the environment's ``SwiftUI/EnvironmentValues/uifnTheme``:
/// a ``UIFnMenuStyle`` menu whose label shows the selected option and whose
/// items are a system `Picker` of the options, the selected one checked.
///
/// ```swift
/// UIFnMenuPicker("Sort", selection: $sort, options: Sort.allCases) { sort in
///     Text(sort.title)
/// }
/// ```
///
/// With no option selected, the label shows the picker's label in the muted
/// text color. The menu items are the system's, so an option's view should be
/// one a menu item can show, such as `Text` or `Label`. Accessibility sees a
/// system menu `Picker` with the same options and selection in its place.
/// Options that repeat an earlier option are left out.
public struct UIFnMenuPicker<Label: View, SelectionValue: Hashable, Option: View>: View {
    private let selection: Binding<SelectionValue>
    private let options: [SelectionValue]
    private let label: Label
    private let option: (SelectionValue) -> Option
    @UIFnStyleEnvironment private var context

    public init<Options: Sequence>(
        selection: Binding<SelectionValue>,
        options: Options,
        @ViewBuilder label: () -> Label,
        @ViewBuilder option: @escaping (SelectionValue) -> Option
    ) where Options.Element == SelectionValue {
        self.selection = selection
        self.options = uifnUniqueOptions(options)
        self.label = label()
        self.option = option
    }

    public var body: some View {
        Menu {
            picker.pickerStyle(.inline).labelsHidden()
        } label: {
            if options.contains(selection.wrappedValue) {
                option(selection.wrappedValue)
            } else {
                label.foregroundColor(context.color(context.colors.text.muted))
            }
        }
        .menuStyle(.uifn)
        .accessibilityRepresentation {
            picker.pickerStyle(.menu)
        }
    }

    private var picker: Picker<Label, SelectionValue, some View> {
        Picker(selection: selection) {
            uifnTaggedOptions(options, content: option)
        } label: {
            label
        }
    }
}

public extension UIFnMenuPicker where Label == Text {
    /// A menu picker labeled with a localized title.
    init<Options: Sequence>(
        _ titleKey: LocalizedStringKey,
        selection: Binding<SelectionValue>,
        options: Options,
        @ViewBuilder option: @escaping (SelectionValue) -> Option
    ) where Options.Element == SelectionValue {
        self.init(selection: selection, options: options, label: { Text(titleKey) }, option: option)
    }

    /// A menu picker labeled with a title string.
    @_disfavoredOverload
    init<Title: StringProtocol, Options: Sequence>(
        _ title: Title,
        selection: Binding<SelectionValue>,
        options: Options,
        @ViewBuilder option: @escaping (SelectionValue) -> Option
    ) where Options.Element == SelectionValue {
        self.init(selection: selection, options: options, label: { Text(title) }, option: option)
    }
}
