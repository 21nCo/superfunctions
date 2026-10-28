import SwiftUI

#if os(iOS) || os(tvOS) || os(visionOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// Gamma-encoded red, green and blue channels in the 0...1 range.
public struct UIFnRGB: Equatable, Sendable {
    public let red: Double
    public let green: Double
    public let blue: Double

    public init(_ red: Double, _ green: Double, _ blue: Double) {
        self.red = red
        self.green = green
        self.blue = blue
    }
}

/// One theme color for one appearance, converted from OKLCH.
///
/// `displayP3` is the color in Display P3 and `sRGB` the same color in sRGB;
/// each is gamut-mapped into its own gamut when the theme color lies outside it.
public struct UIFnColorValue: Equatable, Sendable {
    public let displayP3: UIFnRGB
    public let sRGB: UIFnRGB

    public init(displayP3: UIFnRGB, sRGB: UIFnRGB) {
        self.displayP3 = displayP3
        self.sRGB = sRGB
    }
}

/// A theme color that adapts to light, dark and increased-contrast appearances.
public struct UIFnColorToken: Equatable, Sendable {
    public let light: UIFnColorValue
    public let dark: UIFnColorValue
    public let highContrastLight: UIFnColorValue
    public let highContrastDark: UIFnColorValue

    public init(
        light: UIFnColorValue,
        dark: UIFnColorValue,
        highContrastLight: UIFnColorValue,
        highContrastDark: UIFnColorValue
    ) {
        self.light = light
        self.dark = dark
        self.highContrastLight = highContrastLight
        self.highContrastDark = highContrastDark
    }

    /// The value for an appearance.
    public func value(dark: Bool, highContrast: Bool) -> UIFnColorValue {
        switch (dark, highContrast) {
        case (false, false): light
        case (true, false): self.dark
        case (false, true): highContrastLight
        case (true, true): highContrastDark
        }
    }

    /// A SwiftUI color that resolves per appearance through a dynamic platform color.
    public var color: Color {
        #if os(iOS) || os(tvOS) || os(visionOS)
        Color(uiColor: uiColor)
        #elseif os(macOS)
        Color(nsColor: nsColor)
        #else
        Color(.displayP3, red: light.displayP3.red, green: light.displayP3.green, blue: light.displayP3.blue)
        #endif
    }

    #if os(iOS) || os(tvOS) || os(visionOS)
    /// A dynamic color resolved from the trait collection's interface style,
    /// accessibility contrast and display gamut. sRGB displays get the
    /// gamut-mapped sRGB value; other displays get Display P3.
    public var uiColor: UIColor {
        let token = self
        return UIColor { traits in
            let value = token.value(
                dark: traits.userInterfaceStyle == .dark,
                highContrast: traits.accessibilityContrast == .high
            )
            if traits.displayGamut == .SRGB {
                return UIColor(red: value.sRGB.red, green: value.sRGB.green, blue: value.sRGB.blue, alpha: 1)
            }
            return UIColor(
                displayP3Red: value.displayP3.red,
                green: value.displayP3.green,
                blue: value.displayP3.blue,
                alpha: 1
            )
        }
    }
    #elseif os(macOS)
    /// A dynamic color resolved from the drawing appearance, including the
    /// increased-contrast appearances. AppKit color-matches Display P3 to the
    /// screen it draws on.
    public var nsColor: NSColor {
        let token = self
        return NSColor(name: nil) { appearance in
            let value = token.value(for: appearance)
            return NSColor(
                displayP3Red: value.displayP3.red,
                green: value.displayP3.green,
                blue: value.displayP3.blue,
                alpha: 1
            )
        }
    }

    /// The value for an AppKit appearance. AppKit reports the increased-contrast
    /// appearances through `bestMatch(from:)` when the user turns on Increase contrast.
    public func value(for appearance: NSAppearance) -> UIFnColorValue {
        value(matching: appearance.bestMatch(from: [
            .aqua,
            .darkAqua,
            .accessibilityHighContrastAqua,
            .accessibilityHighContrastDarkAqua,
        ]))
    }

    func value(matching name: NSAppearance.Name?) -> UIFnColorValue {
        value(
            dark: name == .darkAqua || name == .accessibilityHighContrastDarkAqua,
            highContrast: name == .accessibilityHighContrastAqua || name == .accessibilityHighContrastDarkAqua
        )
    }
    #endif
}
