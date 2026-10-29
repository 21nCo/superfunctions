import SwiftUI

/// A switch toggle style drawn with the environment's ``SwiftUI/EnvironmentValues/uifnTheme``:
/// the label, then a track that fills with the accent color when on.
///
/// The toggle stays a toggle to accessibility; the style changes only how it
/// looks and flips the binding when pressed like the system styles do.
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
        .buttonStyle(UIFnToggleButtonStyle(kind: kind, value: value))
        .accessibilityRepresentation {
            representation
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

    func makeBody(configuration: Configuration) -> some View {
        UIFnToggleButtonBody(label: configuration.label, kind: kind, value: value, isPressed: configuration.isPressed)
    }
}

private struct UIFnToggleButtonBody<Label: View>: View {
    let label: Label
    let kind: UIFnToggleKind
    let value: UIFnToggleValue
    let isPressed: Bool
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var isFocused

    var body: some View {
        UIFnToggleAppearance(
            label: label,
            kind: kind,
            value: value,
            state: UIFnControlState(isPressed: isPressed, isEnabled: isEnabled, isFocused: isFocused)
        )
    }
}

/// How a UIFn toggle looks with one value in one state.
struct UIFnToggleAppearance<Label: View>: View {
    let label: Label
    let kind: UIFnToggleKind
    let value: UIFnToggleValue
    let state: UIFnControlState
    @UIFnStyleEnvironment private var context

    var body: some View {
        row
            .opacity(state.isEnabled ? 1 : UIFnStyleContext.disabledOpacity)
        .animation(context.stateAnimation, value: value)
        .animation(context.stateAnimation, value: state)
    }

    @ViewBuilder
    private var row: some View {
        let spacing = context.scaled(context.spacing.space3)
        switch kind {
        case .switch:
            // Like the system switch, only the track takes presses.
            HStack(spacing: spacing) {
                labelText.allowsHitTesting(false)
                control
            }
        case .checkbox:
            // Like the system checkbox, the whole row takes presses.
            HStack(spacing: spacing) {
                control
                labelText
            }
            .contentShape(Rectangle())
        }
    }

    private var labelText: some View {
        label
            .uifnFont(context.typography.size.md)
            .foregroundColor(context.color(context.colors.text.primary))
    }

    @ViewBuilder
    private var control: some View {
        switch kind {
        case .switch: switchTrack
        case .checkbox: checkbox
        }
    }

    private var isPressed: Bool { state.isPressed && state.isEnabled }

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
            .uifnFocusRing(state.isFocused && state.isEnabled, cornerRadius: height / 2, context: context)
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
