import SwiftUI

#if os(macOS)
import AppKit
#endif

private struct UIFnThemeKey: EnvironmentKey {
    static let defaultValue = UIFnTheme.uifn
}

public extension EnvironmentValues {
    /// The theme UIFn control styles draw with. ``UIFnTheme/uifn`` unless set.
    var uifnTheme: UIFnTheme {
        get { self[UIFnThemeKey.self] }
        set { self[UIFnThemeKey.self] = newValue }
    }
}

public extension View {
    /// Sets the theme UIFn control styles in this view draw with.
    func uifnTheme(_ theme: UIFnTheme) -> some View {
        environment(\.uifnTheme, theme)
    }
}

/// The interaction state a control style draws.
struct UIFnControlState: Equatable {
    var isPressed = false
    var isEnabled = true
    var isFocused = false
}

/// The theme and appearance a control style resolves its tokens in.
struct UIFnStyleContext {
    let theme: UIFnTheme
    let colorScheme: ColorScheme
    let colorSchemeContrast: ColorSchemeContrast
    let dynamicTypeSize: DynamicTypeSize
    let reduceMotion: Bool
    #if os(macOS)
    let displayGamut: NSDisplayGamut
    #endif

    var colors: UIFnColors { theme.colors }
    var spacing: UIFnSpacing { theme.spacing }
    var radius: UIFnRadius { theme.radius }
    var typography: UIFnTypography { theme.typography }

    /// The token's color for this appearance.
    ///
    /// UIKit resolves the dynamic color from the view's traits, which SwiftUI
    /// derives from the environment, including the display gamut. AppKit
    /// cannot see the environment, so on macOS the value is picked here from
    /// the color scheme, contrast and ``SwiftUI/EnvironmentValues/uifnDisplayGamut``.
    func color(_ token: UIFnColorToken) -> Color {
        #if os(macOS)
        let value = token.value(dark: colorScheme == .dark, highContrast: colorSchemeContrast == .increased)
        if displayGamut == .sRGB {
            return Color(.sRGB, red: value.sRGB.red, green: value.sRGB.green, blue: value.sRGB.blue)
        }
        return Color(.displayP3, red: value.displayP3.red, green: value.displayP3.green, blue: value.displayP3.blue)
        #else
        token.color
        #endif
    }

    /// How much control metrics grow with Dynamic Type: the body type size's
    /// scaled points over its points. Always 1 on macOS, which has no Dynamic
    /// Type, and 1 where a zero body size leaves no positive, finite ratio.
    var metricScale: CGFloat {
        #if os(macOS)
        1
        #else
        let size = typography.size.md
        let scale = size.scaledPoints(for: dynamicTypeSize) / size.points
        return scale.isFinite && scale > 0 ? scale : 1
        #endif
    }

    /// A control metric in points, scaled with Dynamic Type.
    func scaled(_ points: CGFloat) -> CGFloat {
        (points * metricScale).rounded()
    }

    /// The theme's fast standard animation, with its reduced-motion duration
    /// under Reduce Motion.
    var stateAnimation: Animation {
        theme.motion.easing.standard.animation(theme.motion.duration.fast, reduceMotion: reduceMotion)
    }

    /// The tint drawn over a pressed control: the primary text color, faint.
    var pressedTint: Color {
        color(colors.text.primary).opacity(0.12)
    }

    /// The opacity of a disabled control.
    static let disabledOpacity = 0.56
}

/// Reads the environment values control styles resolve tokens in.
@propertyWrapper
struct UIFnStyleEnvironment: DynamicProperty {
    @Environment(\.uifnTheme) private var theme
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    #if os(macOS)
    @Environment(\.uifnDisplayGamut) private var displayGamut
    #endif

    var wrappedValue: UIFnStyleContext {
        #if os(macOS)
        UIFnStyleContext(
            theme: theme,
            colorScheme: colorScheme,
            colorSchemeContrast: colorSchemeContrast,
            dynamicTypeSize: dynamicTypeSize,
            reduceMotion: reduceMotion,
            displayGamut: displayGamut
        )
        #else
        UIFnStyleContext(
            theme: theme,
            colorScheme: colorScheme,
            colorSchemeContrast: colorSchemeContrast,
            dynamicTypeSize: dynamicTypeSize,
            reduceMotion: reduceMotion
        )
        #endif
    }
}

/// The focus ring UIFn controls draw outside their shape: two points of the
/// accent color, two points outside the control.
struct UIFnFocusRing: ViewModifier {
    let isFocused: Bool
    let cornerRadius: CGFloat
    let context: UIFnStyleContext

    func body(content: Content) -> some View {
        content.overlay {
            if isFocused {
                RoundedRectangle(cornerRadius: cornerRadius + 4, style: .continuous)
                    .strokeBorder(context.color(context.colors.accent.solid), lineWidth: 2)
                    .padding(-4)
                    .allowsHitTesting(false)
            }
        }
    }
}

extension View {
    func uifnFocusRing(_ isFocused: Bool, cornerRadius: CGFloat, context: UIFnStyleContext) -> some View {
        modifier(UIFnFocusRing(isFocused: isFocused, cornerRadius: cornerRadius, context: context))
    }
}
