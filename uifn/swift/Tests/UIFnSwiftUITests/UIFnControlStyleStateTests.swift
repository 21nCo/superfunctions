import SwiftUI
import Testing
@testable import UIFnSwiftUI

#if os(macOS)
import AppKit
#endif

enum UIFnStateChange {
    /// The fraction of pixels a state or appearance change must alter: four
    /// times what a snapshot tolerates, so a snapshot would catch its loss.
    static let minimumDifferingFraction = 0.02
}

/// The style variants that draw interaction states.
enum UIFnStatefulControl: String, CaseIterable, CustomTestStringConvertible {
    case buttonPrimary, buttonSecondary, buttonGhost, buttonDestructive
    case switchOff, switchOn, checkboxOff, checkboxOn, checkboxMixed
    case textField

    static let pressable = allCases.filter { $0 != .textField }

    var testDescription: String { rawValue }

    @MainActor
    func appearance(_ state: UIFnControlState) -> AnyView {
        let view: AnyView = switch self {
        case .buttonPrimary: AnyView(UIFnButtonAppearance(label: Text("Continue"), variant: .primary, state: state))
        case .buttonSecondary: AnyView(UIFnButtonAppearance(label: Text("Continue"), variant: .secondary, state: state))
        case .buttonGhost: AnyView(UIFnButtonAppearance(label: Text("Continue"), variant: .ghost, state: state))
        case .buttonDestructive: AnyView(UIFnButtonAppearance(label: Text("Delete"), variant: .destructive, state: state))
        case .switchOff: AnyView(UIFnToggleAppearance(label: Text("Alerts"), kind: .switch, value: .off, state: state))
        case .switchOn: AnyView(UIFnToggleAppearance(label: Text("Alerts"), kind: .switch, value: .on, state: state))
        case .checkboxOff: AnyView(UIFnToggleAppearance(label: Text("Remember"), kind: .checkbox, value: .off, state: state))
        case .checkboxOn: AnyView(UIFnToggleAppearance(label: Text("Remember"), kind: .checkbox, value: .on, state: state))
        case .checkboxMixed: AnyView(UIFnToggleAppearance(label: Text("Remember"), kind: .checkbox, value: .mixed, state: state))
        case .textField: AnyView(UIFnTextFieldAppearance(field: Text("Ada"), state: state).frame(width: 200))
        }
        return AnyView(view.isolated())
    }
}

extension View {
    /// The view with room for its focus ring, in the snapshot font, without a canvas.
    func isolated() -> some View {
        padding(8).uifnFontFamily(snapshotFontFamily)
    }
}

struct UIFnControlStyleStateTests {
    init() throws {
        try registerSnapshotFont()
    }

    private func fraction(
        _ control: UIFnStatefulControl,
        _ state: UIFnControlState,
        comparedWith other: UIFnControlState
    ) async throws -> Double {
        let changed = try #require(await UIFnSnapshot.render { control.appearance(state) })
        let normal = try #require(await UIFnSnapshot.render { control.appearance(other) })
        return changed.differingFraction(from: normal)
    }

    @Test(arguments: UIFnStatefulControl.pressable)
    func pressingChangesTheAppearance(_ control: UIFnStatefulControl) async throws {
        let pressed = try await fraction(control, UIFnControlState(isPressed: true), comparedWith: UIFnControlState())
        #expect(pressed > UIFnStateChange.minimumDifferingFraction)
    }

    @Test(arguments: UIFnStatefulControl.allCases)
    func disablingChangesTheAppearance(_ control: UIFnStatefulControl) async throws {
        let disabled = try await fraction(control, UIFnControlState(isEnabled: false), comparedWith: UIFnControlState())
        #expect(disabled > UIFnStateChange.minimumDifferingFraction)
    }

    @Test(arguments: UIFnStatefulControl.allCases)
    func focusChangesTheAppearance(_ control: UIFnStatefulControl) async throws {
        let focused = try await fraction(control, UIFnControlState(isFocused: true), comparedWith: UIFnControlState())
        #expect(focused > UIFnStateChange.minimumDifferingFraction)
    }

    /// A disabled control cannot be pressed or keep focus, so it never draws
    /// the pressed tint or the focus ring.
    @Test(arguments: UIFnStatefulControl.allCases)
    func disabledControlsIgnorePressAndFocus(_ control: UIFnStatefulControl) async throws {
        let disabled = UIFnControlState(isEnabled: false)
        let pressedAndFocused = UIFnControlState(isPressed: true, isEnabled: false, isFocused: true)
        #expect(try await fraction(control, pressedAndFocused, comparedWith: disabled) == 0)
    }

    // MARK: - The public styles draw the environment's state

    private func expectSameRendering(
        _ view: @escaping @MainActor () -> some View,
        _ expected: @escaping @MainActor () -> some View,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async throws {
        let rendered = try #require(await UIFnSnapshot.render { view().isolated() }, sourceLocation: sourceLocation)
        let reference = try #require(await UIFnSnapshot.render(expected), sourceLocation: sourceLocation)
        #expect(rendered.differingFraction(from: reference) == 0, sourceLocation: sourceLocation)
    }

    @Test(arguments: UIFnButtonStyle.Variant.allCases, [true, false])
    func buttonStyleDrawsItsVariantAndEnabledState(_ variant: UIFnButtonStyle.Variant, _ isEnabled: Bool) async throws {
        let control: UIFnStatefulControl = switch variant {
        case .primary: .buttonPrimary
        case .secondary: .buttonSecondary
        case .ghost: .buttonGhost
        case .destructive: .buttonDestructive
        }
        let label = variant == .destructive ? "Delete" : "Continue"
        try await expectSameRendering(
            { Button(label) {}.buttonStyle(.uifn(variant)).disabled(!isEnabled) },
            { control.appearance(UIFnControlState(isEnabled: isEnabled)) }
        )
    }

    @Test(arguments: [true, false])
    func toggleStylesDrawTheValueAndEnabledState(_ isEnabled: Bool) async throws {
        try await expectSameRendering(
            { Toggle("Alerts", isOn: .constant(false)).toggleStyle(.uifnSwitch).disabled(!isEnabled) },
            { UIFnStatefulControl.switchOff.appearance(UIFnControlState(isEnabled: isEnabled)) }
        )
        try await expectSameRendering(
            { Toggle("Alerts", isOn: .constant(true)).toggleStyle(.uifnSwitch).disabled(!isEnabled) },
            { UIFnStatefulControl.switchOn.appearance(UIFnControlState(isEnabled: isEnabled)) }
        )
        try await expectSameRendering(
            { Toggle("Remember", isOn: .constant(false)).toggleStyle(.uifnCheckbox).disabled(!isEnabled) },
            { UIFnStatefulControl.checkboxOff.appearance(UIFnControlState(isEnabled: isEnabled)) }
        )
        try await expectSameRendering(
            { Toggle("Remember", isOn: .constant(true)).toggleStyle(.uifnCheckbox).disabled(!isEnabled) },
            { UIFnStatefulControl.checkboxOn.appearance(UIFnControlState(isEnabled: isEnabled)) }
        )
        try await expectSameRendering(
            {
                Toggle(sources: [Binding.constant(true), .constant(false)], isOn: \.self) { Text("Remember") }
                    .toggleStyle(.uifnCheckbox)
                    .disabled(!isEnabled)
            },
            { UIFnStatefulControl.checkboxMixed.appearance(UIFnControlState(isEnabled: isEnabled)) }
        )
    }

    @Test
    func textFieldStyleDrawsTheEnabledState() async throws {
        func render(_ field: @escaping @MainActor () -> some View) async throws -> UIFnBitmap {
            try #require(await UIFnSnapshot.render { field().frame(width: 200).isolated() })
        }
        let styled = try await render { TextField("Name", text: .constant("Ada")).textFieldStyle(.uifn) }
        let disabled = try await render { TextField("Name", text: .constant("Ada")).textFieldStyle(.uifn).disabled(true) }
        // A plain field with the style's font and padding takes the same size,
        // so the comparison counts only what the style draws around it.
        let theme = UIFnTheme.uifn
        let plain = try await render {
            TextField("Name", text: .constant("Ada"))
                .textFieldStyle(.plain)
                .uifnFont(theme.typography.size.md, weight: theme.typography.weight.regular)
                .padding(.horizontal, theme.spacing.space3)
                .padding(.vertical, theme.spacing.space2)
        }
        #expect(styled.width == plain.width && styled.height == plain.height)
        #expect(styled.differingFraction(from: plain) > UIFnStateChange.minimumDifferingFraction)
        #expect(disabled.width == styled.width && disabled.height == styled.height)
        #expect(disabled.differingFraction(from: styled) > UIFnStateChange.minimumDifferingFraction)
    }

    @Test
    func groupBoxStyleDrawsACard() async throws {
        try await expectSameRendering(
            { GroupBox("Account") { Text("Signed in") }.groupBoxStyle(.uifn).frame(width: 220) },
            { UIFnGroupBoxAppearance(label: Text("Account"), content: Text("Signed in")).frame(width: 220).isolated() }
        )
    }

    // MARK: - Theme tokens

    /// The default theme with every color replaced by one magenta, so any
    /// color a style draws from the environment's theme changes.
    private static let magentaTheme: UIFnTheme = {
        let value = UIFnColorValue(displayP3: UIFnRGB(0.9, 0.1, 0.8), sRGB: UIFnRGB(1, 0, 0.85))
        let token = UIFnColorToken(light: value, dark: value, highContrastLight: value, highContrastDark: value)
        let tone = UIFnToneColors(solid: token, subtle: token, contrast: token)
        let theme = UIFnTheme.uifn
        return UIFnTheme(
            name: "magenta",
            colors: UIFnColors(
                surface: UIFnSurfaceColors(
                    canvas: token, raised: token, sunken: token, overlay: token,
                    depth0: token, depth1: token, depth2: token, depth3: token, depth4: token
                ),
                text: UIFnTextColors(primary: token, secondary: token, muted: token, disabled: token),
                border: UIFnBorderColors(subtle: token, default: token, strong: token),
                accent: tone,
                danger: tone,
                warning: tone,
                success: tone
            ),
            spacing: theme.spacing,
            radius: theme.radius,
            typography: theme.typography,
            motion: theme.motion
        )
    }()

    @Test(arguments: UIFnStyleSubject.allCases)
    func stylesDrawTheDefaultThemeUnlessTheEnvironmentSetsOne(_ subject: UIFnStyleSubject) async throws {
        #expect(EnvironmentValues().uifnTheme == .uifn)
        let byDefault = try #require(await UIFnSnapshot.render { subject.view.isolated() })
        let uifn = try #require(await UIFnSnapshot.render { subject.view.uifnTheme(.uifn).isolated() })
        let magenta = try #require(await UIFnSnapshot.render { subject.view.uifnTheme(Self.magentaTheme).isolated() })
        #expect(uifn.differingFraction(from: byDefault) == 0)
        #expect(magenta.differingFraction(from: byDefault) > UIFnStateChange.minimumDifferingFraction)
    }

    @Test
    func stylesTakeTheirMetricsFromTheTheme() async throws {
        let theme = UIFnTheme.uifn
        let roomy = UIFnTheme(
            name: "roomy",
            colors: theme.colors,
            spacing: UIFnSpacing(space1: 8, space2: 16, space3: 24, space4: 32, space5: 40, space6: 48, space8: 64, space12: 96),
            radius: theme.radius,
            typography: theme.typography,
            motion: theme.motion
        )
        for subject in [UIFnStyleSubject.buttonPrimary, .checkboxOn, .switchOn, .textFieldFilled, .groupBox] {
            let byDefault = try #require(await UIFnSnapshot.render { subject.view.isolated() })
            let spaced = try #require(await UIFnSnapshot.render { subject.view.uifnTheme(roomy).isolated() })
            #expect(spaced.height > byDefault.height || spaced.width > byDefault.width, "\(subject)")
        }
    }

    /// The default theme with a bold regular weight.
    private static let boldRegularTheme: UIFnTheme = {
        let theme = UIFnTheme.uifn
        let weight = theme.typography.weight
        return UIFnTheme(
            name: "bold-regular",
            colors: theme.colors,
            spacing: theme.spacing,
            radius: theme.radius,
            typography: UIFnTypography(
                size: theme.typography.size,
                lineHeight: theme.typography.lineHeight,
                weight: UIFnFontWeights(regular: UIFnFontWeight(700), medium: weight.medium, semibold: weight.semibold, bold: weight.bold)
            ),
            motion: theme.motion
        )
    }()

    /// Body text in the toggle label, the text field and the group box
    /// content takes the theme's regular weight. The box-glyph test faces
    /// draw every weight alike, so this renders the system font.
    @Test(arguments: [UIFnStyleSubject.switchOn, .checkboxOn, .textFieldFilled, .groupBox])
    func bodyTextTakesTheThemeRegularWeight(_ subject: UIFnStyleSubject) async throws {
        let byDefault = try #require(await UIFnSnapshot.render { subject.view.padding(8) })
        let bold = try #require(await UIFnSnapshot.render { subject.view.uifnTheme(Self.boldRegularTheme).padding(8) })
        // Only the weight differs, so a different size counts as a change too.
        #expect(bold.differingFraction(from: byDefault) > 0)
    }

    #if os(macOS)
    /// AppKit colors cannot see the environment, so the styles pick each
    /// token's value from the color scheme, contrast and display gamut.
    @Test
    func macOSStylesResolveTokensForTheAppearanceAndDisplayGamut() async throws {
        guard #available(macOS 14, *) else { return }
        let token = UIFnTheme.uifn.colors.accent.solid
        for dark in [false, true] {
            for contrast in [ColorSchemeContrast.standard, .increased] {
                for gamut in [NSDisplayGamut.sRGB, .p3] {
                    let context = UIFnStyleContext(
                        theme: .uifn,
                        colorScheme: dark ? .dark : .light,
                        colorSchemeContrast: contrast,
                        dynamicTypeSize: .large,
                        reduceMotion: false,
                        displayGamut: gamut
                    )
                    let value = token.value(dark: dark, highContrast: contrast == .increased)
                    let resolved = context.color(token).resolve(in: EnvironmentValues())
                    let expected = gamut == .sRGB
                        ? Color.Resolved(colorSpace: .sRGB, red: Float(value.sRGB.red), green: Float(value.sRGB.green), blue: Float(value.sRGB.blue))
                        : Color.Resolved(
                            colorSpace: .displayP3,
                            red: Float(value.displayP3.red),
                            green: Float(value.displayP3.green),
                            blue: Float(value.displayP3.blue)
                        )
                    let label = "dark: \(dark), contrast: \(contrast), gamut: \(gamut.rawValue)"
                    #expect(abs(resolved.linearRed - expected.linearRed) < 1e-4, "\(label)")
                    #expect(abs(resolved.linearGreen - expected.linearGreen) < 1e-4, "\(label)")
                    #expect(abs(resolved.linearBlue - expected.linearBlue) < 1e-4, "\(label)")
                }
            }
        }
    }
    #endif

    @Test
    func metricsScaleWithDynamicTypeOnlyWhereThePlatformScalesText() {
        func scale(_ size: DynamicTypeSize) -> CGFloat {
            #if os(macOS)
            UIFnStyleContext(
                theme: .uifn, colorScheme: .light, colorSchemeContrast: .standard,
                dynamicTypeSize: size, reduceMotion: false, displayGamut: .p3
            ).metricScale
            #else
            UIFnStyleContext(
                theme: .uifn, colorScheme: .light, colorSchemeContrast: .standard,
                dynamicTypeSize: size, reduceMotion: false
            ).metricScale
            #endif
        }
        #expect(scale(.large) == 1)
        #if os(macOS)
        #expect(scale(.xSmall) == 1)
        #expect(scale(.accessibility3) == 1)
        #else
        #expect(scale(.xSmall) < 1)
        #expect(scale(.accessibility3) > 1.5)
        #endif
    }

    /// The default theme with a zero body type size, which the token
    /// generator and ``UIFnTypeSize`` both accept.
    private static let zeroBodyTheme: UIFnTheme = {
        let theme = UIFnTheme.uifn
        let size = theme.typography.size
        return UIFnTheme(
            name: "zero-body",
            colors: theme.colors,
            spacing: theme.spacing,
            radius: theme.radius,
            typography: UIFnTypography(
                size: UIFnTypeScale(
                    xs: size.xs,
                    sm: size.sm,
                    md: UIFnTypeSize(points: 0, textStyle: size.md.textStyle),
                    lg: size.lg,
                    xl: size.xl
                ),
                lineHeight: theme.typography.lineHeight,
                weight: theme.typography.weight
            ),
            motion: theme.motion
        )
    }()

    @Test(arguments: [DynamicTypeSize.xSmall, .large, .accessibility3])
    func aZeroBodyTypeSizeLeavesMetricsUnscaled(_ size: DynamicTypeSize) async throws {
        #if os(macOS)
        let context = UIFnStyleContext(
            theme: Self.zeroBodyTheme, colorScheme: .light, colorSchemeContrast: .standard,
            dynamicTypeSize: size, reduceMotion: false, displayGamut: .p3
        )
        #else
        let context = UIFnStyleContext(
            theme: Self.zeroBodyTheme, colorScheme: .light, colorSchemeContrast: .standard,
            dynamicTypeSize: size, reduceMotion: false
        )
        #endif
        #expect(context.metricScale == 1)
        #expect(context.scaled(context.spacing.space3) == context.spacing.space3.rounded())

        // With no label text, a switch and a checkbox draw only their control,
        // which keeps the default theme's unscaled size.
        for kind in [UIFnToggleKind.switch, .checkbox] {
            let zero = try #require(await UIFnSnapshot.render(dynamicTypeSize: size) {
                UIFnToggleAppearance(label: EmptyView(), kind: kind, value: .on, state: UIFnControlState())
                    .uifnTheme(Self.zeroBodyTheme)
                    .isolated()
            })
            let unscaled = try #require(await UIFnSnapshot.render {
                UIFnToggleAppearance(label: EmptyView(), kind: kind, value: .on, state: UIFnControlState()).isolated()
            })
            #expect(zero.width == unscaled.width && zero.height == unscaled.height, "\(kind)")
            #expect(zero.differingFraction(from: unscaled) == 0, "\(kind)")
        }
    }
}
