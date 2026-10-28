import SwiftUI
import Testing
@testable import UIFnSwiftUI

#if os(iOS) || os(tvOS) || os(visionOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

private let tolerance = 1.0 / 255.0

private func isClose(_ lhs: UIFnRGB, _ rhs: UIFnRGB) -> Bool {
    abs(lhs.red - rhs.red) <= tolerance
        && abs(lhs.green - rhs.green) <= tolerance
        && abs(lhs.blue - rhs.blue) <= tolerance
}

private enum Appearance: CaseIterable {
    case light, dark, highContrastLight, highContrastDark

    var isDark: Bool { self == .dark || self == .highContrastDark }
    var isHighContrast: Bool { self == .highContrastLight || self == .highContrastDark }
}

#if os(macOS)
// AppKit only produces the increased-contrast appearances from the system
// setting, so NSAppearance(named:) cannot create them. Light and dark resolve
// the dynamic NSColor; increased contrast resolves through the appearance name
// that bestMatch(from:) reports when the setting is on.
private func resolve(_ token: UIFnColorToken, in appearance: Appearance) throws -> UIFnRGB {
    switch appearance {
    case .highContrastLight:
        return token.value(matching: .accessibilityHighContrastAqua).displayP3
    case .highContrastDark:
        return token.value(matching: .accessibilityHighContrastDarkAqua).displayP3
    case .light, .dark:
        let drawingAppearance = try #require(NSAppearance(named: appearance == .dark ? .darkAqua : .aqua))
        var resolved: NSColor?
        drawingAppearance.performAsCurrentDrawingAppearance {
            resolved = token.nsColor.usingColorSpace(.displayP3)
        }
        let color = try #require(resolved)
        return UIFnRGB(Double(color.redComponent), Double(color.greenComponent), Double(color.blueComponent))
    }
}
#elseif os(iOS) || os(tvOS) || os(visionOS)
private func traits(_ appearance: Appearance, gamut: UIDisplayGamut = .P3) -> UITraitCollection {
    UITraitCollection(traitsFrom: [
        UITraitCollection(userInterfaceStyle: appearance.isDark ? .dark : .light),
        UITraitCollection(accessibilityContrast: appearance.isHighContrast ? .high : .normal),
        UITraitCollection(displayGamut: gamut),
    ])
}

private func components(_ color: UIColor, in colorSpace: CGColorSpace) throws -> UIFnRGB {
    let converted = try #require(color.cgColor.converted(to: colorSpace, intent: .relativeColorimetric, options: nil))
    let parts = try #require(converted.components)
    return UIFnRGB(Double(parts[0]), Double(parts[1]), Double(parts[2]))
}

private func resolve(_ token: UIFnColorToken, in appearance: Appearance) throws -> UIFnRGB {
    try components(
        token.uiColor.resolvedColor(with: traits(appearance)),
        in: try #require(CGColorSpace(name: CGColorSpace.displayP3))
    )
}
#endif

struct UIFnThemeColorTests {
    @Test
    func defaultThemeDefinesEveryColorForEachAppearance() {
        let names = UIFnTheme.uifn.colors.all.map(\.name)
        #expect(names.count == 28)
        #expect(names.first == "surface.canvas")
        #expect(names.contains("border.default"))
        #expect(UIFnTheme.uifn.colors.custom == nil)
    }

    @Test
    func defaultThemeColorsResolveDifferentlyInLightAndDark() throws {
        for (name, token) in UIFnTheme.uifn.colors.all {
            let light = try resolve(token, in: .light)
            let dark = try resolve(token, in: .dark)
            #expect(isClose(light, token.light.displayP3), "\(name) light")
            #expect(isClose(dark, token.dark.displayP3), "\(name) dark")
            #expect(!isClose(light, dark), "\(name) resolves the same in light and dark")
        }
    }

    @Test
    func defaultThemeColorsResolveTheirIncreasedContrastValues() throws {
        var differsFromStandard = 0
        for (name, token) in UIFnTheme.uifn.colors.all {
            let highContrastLight = try resolve(token, in: .highContrastLight)
            let highContrastDark = try resolve(token, in: .highContrastDark)
            #expect(isClose(highContrastLight, token.highContrastLight.displayP3), "\(name) high contrast light")
            #expect(isClose(highContrastDark, token.highContrastDark.displayP3), "\(name) high contrast dark")
            if !isClose(highContrastLight, token.light.displayP3) { differsFromStandard += 1 }
        }
        #expect(differsFromStandard > 20)
    }

    @Test
    func consumerThemeWithoutHighContrastFallsBackToItsLightAndDarkColors() throws {
        let colors = UIFnTheme.sample.colors
        #expect(UIFnTheme.sample.name == "sample")
        let custom = try #require(colors.custom)
        var distinct = 0
        for (name, token) in colors.all {
            #expect(token.highContrastLight == token.light, "\(name)")
            #expect(token.highContrastDark == token.dark, "\(name)")
            let light = try resolve(token, in: .light)
            let dark = try resolve(token, in: .dark)
            // Some tones use the same contrast color in both themes.
            #expect(isClose(light, dark) == (token.light == token.dark), "\(name)")
            if token.light != token.dark { distinct += 1 }
            #expect(isClose(try resolve(token, in: .highContrastDark), token.dark.displayP3), "\(name)")
        }
        #expect(distinct >= colors.all.count - 3)
        #expect(custom.solid.light != custom.solid.dark)
    }

    @Test
    func outOfGamutColorsCarryDistinctDisplayP3AndSRGBValues() {
        // accent.solid in the default light theme lies outside sRGB.
        let accent = UIFnTheme.uifn.colors.accent.solid.light
        #expect(!isClose(accent.displayP3, accent.sRGB))
        for value in [accent.displayP3, accent.sRGB] {
            for channel in [value.red, value.green, value.blue] {
                #expect((0...1).contains(channel))
            }
        }
    }

    #if os(iOS) || os(tvOS) || os(visionOS)
    @Test
    func sRGBDisplaysGetTheGamutMappedSRGBValue() throws {
        let token = UIFnTheme.uifn.colors.accent.solid
        let srgb = try #require(CGColorSpace(name: CGColorSpace.sRGB))
        let onSRGB = try components(token.uiColor.resolvedColor(with: traits(.light, gamut: .SRGB)), in: srgb)
        #expect(isClose(onSRGB, token.light.sRGB))
    }
    #endif
}

struct UIFnThemeFoundationTests {
    @Test
    func typeScaleMapsToDynamicTypeTextStyles() {
        let size = UIFnTheme.uifn.typography.size
        #expect([size.xs, size.sm, size.md, size.lg, size.xl].map(\.points) == [12, 13, 14, 16, 18])
        #expect([size.xs, size.sm, size.md, size.lg, size.xl].map(\.textStyle) == [.caption, .footnote, .subheadline, .callout, .body])
        #expect(size.md.font(weight: UIFnTheme.uifn.typography.weight.semibold) == .system(.subheadline, weight: .semibold))
    }

    #if os(iOS) || os(tvOS) || os(visionOS)
    @Test
    func typeSizesScaleWithDynamicType() {
        let md = UIFnTheme.uifn.typography.size.md
        let large = md.scaledPoints(compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))
        let accessibility = md.scaledPoints(compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraLarge))
        #expect(abs(large - md.points) < 0.5)
        #expect(accessibility > large * 1.5)
    }
    #endif

    @Test
    func fontWeightsMapToTheNearestSystemWeight() {
        let weight = UIFnTheme.uifn.typography.weight
        #expect([weight.regular, weight.medium, weight.semibold, weight.bold].map(\.value) == [400, 500, 650, 700])
        #expect(weight.semibold.weight == .semibold)
        #expect(UIFnFontWeight(651).weight == .bold)
        #expect(UIFnFontWeight(950).weight == .black)
    }

    @Test
    func spacingRadiusAndMotionComeFromTheTheme() {
        let theme = UIFnTheme.uifn
        #expect([theme.spacing.space1, theme.spacing.space4, theme.spacing.space12] == [4, 16, 48])
        #expect([theme.radius.sm, theme.radius.md, theme.radius.full] == [4, 6, 9999])
        #expect(theme.typography.lineHeight.normal == 1.45)
        #expect(theme.motion.duration.fast == UIFnDuration(seconds: 0.12, reducedMotionSeconds: 0))
        #expect(theme.motion.duration.slow.seconds(reduceMotion: true) == 0)
        #expect(theme.motion.easing.standard == UIFnEasing(0.2, 0, 0, 1))
    }
}
