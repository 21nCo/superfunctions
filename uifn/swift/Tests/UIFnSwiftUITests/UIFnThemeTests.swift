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

private func components(_ color: NSColor, in appearance: NSAppearance.Name, _ colorSpace: NSColorSpace) throws -> UIFnRGB {
    let drawingAppearance = try #require(NSAppearance(named: appearance))
    var converted: NSColor?
    drawingAppearance.performAsCurrentDrawingAppearance { converted = color.usingColorSpace(colorSpace) }
    let rgb = try #require(converted)
    return UIFnRGB(Double(rgb.redComponent), Double(rgb.greenComponent), Double(rgb.blueComponent))
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
        #expect(try #require(custom.solid).light != custom.solid?.dark)
    }

    @Test
    func partialCustomToneKeepsOnlyTheColorsTheThemeDefines() throws {
        // The sample theme defines custom.solid and custom.contrast but not custom.subtle.
        let custom = try #require(UIFnTheme.sample.colors.custom)
        #expect(custom.subtle == nil)
        let contrast = try #require(custom.contrast)
        #expect(custom.solid != nil)
        #expect(UIFnTheme.sample.colors.all.filter { $0.name.hasPrefix("custom.") }.map(\.name) == ["custom.solid", "custom.contrast"])
        #expect(!isClose(try resolve(contrast, in: .light), try resolve(contrast, in: .dark)))
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
    #elseif os(macOS)
    // Light: oklch(70% 0.3 145), outside both gamuts. Dark: oklch(64% 0.27 29), outside sRGB.
    private static let outOfGamut = UIFnColorToken(
        light: UIFnColorValue(displayP3: UIFnRGB(26 / 255, 197 / 255, 0), sRGB: UIFnRGB(0, 195 / 255, 0)),
        dark: UIFnColorValue(displayP3: UIFnRGB(242 / 255, 46 / 255, 32 / 255), sRGB: UIFnRGB(1, 0, 0)),
        highContrastLight: UIFnColorValue(displayP3: UIFnRGB(0, 0, 0), sRGB: UIFnRGB(0, 0, 0)),
        highContrastDark: UIFnColorValue(displayP3: UIFnRGB(1, 1, 1), sRGB: UIFnRGB(1, 1, 1))
    )

    @Test
    func eachDestinationGetsTheValueForItsOwnGamut() throws {
        let token = Self.outOfGamut
        // Both destinations resolve side by side; nothing reads the key window's screen.
        let onSRGB = token.nsColor(displayGamut: .sRGB)
        let onP3 = token.nsColor(displayGamut: .p3)
        for (appearance, value) in [(NSAppearance.Name.aqua, token.light), (.darkAqua, token.dark)] {
            #expect(isClose(try components(onSRGB, in: appearance, .sRGB), value.sRGB), "\(appearance.rawValue)")
            #expect(isClose(try components(onP3, in: appearance, .displayP3), value.displayP3), "\(appearance.rawValue)")
            #expect(isClose(try components(token.nsColor, in: appearance, .displayP3), value.displayP3), "\(appearance.rawValue)")
            #expect(isClose(try components(token.nsColor(for: nil), in: appearance, .displayP3), value.displayP3), "\(appearance.rawValue)")
        }
        // ColorSync's conversion of the out-of-gamut P3 value is not the theme's sRGB mapping.
        #expect(!isClose(try components(onP3, in: .aqua, .sRGB), token.light.sRGB))
        for screen in NSScreen.screens {
            #expect(UIFnColorToken.displayGamut(of: screen) == (screen.canRepresent(.p3) ? .p3 : .sRGB))
        }
    }

    // Resolving an AppKit-backed SwiftUI color synchronizes with the main thread.
    @Test @MainActor
    func swiftUIColorsResolveForTheirDestinationGamut() throws {
        guard #available(macOS 14, *) else { return }
        let token = Self.outOfGamut
        for (scheme, value) in [(ColorScheme.light, token.light), (.dark, token.dark)] {
            var environment = EnvironmentValues()
            environment.colorScheme = scheme
            func rgb(_ color: Color) -> UIFnRGB {
                let resolved = color.resolve(in: environment)
                return UIFnRGB(Double(resolved.red), Double(resolved.green), Double(resolved.blue))
            }
            let p3 = rgb(Color(.displayP3, red: value.displayP3.red, green: value.displayP3.green, blue: value.displayP3.blue))
            #expect(isClose(rgb(token.color(displayGamut: .sRGB)), value.sRGB), "\(scheme)")
            #expect(isClose(rgb(token.color(displayGamut: .p3)), p3), "\(scheme)")
            #expect(isClose(rgb(token.color), p3), "\(scheme)")
        }
        #expect(EnvironmentValues().uifnDisplayGamut == .p3)
    }

    @Test @MainActor
    func displayGamutFollowsTheWindowsScreen() {
        var screenGamut = NSDisplayGamut.p3
        var reported: [NSDisplayGamut] = []
        let view = UIFnDisplayGamutView(gamutOfWindow: { _ in screenGamut }) { reported.append($0) }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 40, height: 40), styleMask: [.titled], backing: .buffered, defer: true)
        let otherWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 40, height: 40), styleMask: [.titled], backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        otherWindow.isReleasedWhenClosed = false
        window.contentView?.addSubview(view)
        #expect(reported == [.p3])

        screenGamut = .sRGB
        NotificationCenter.default.post(name: NSWindow.didChangeScreenNotification, object: otherWindow)
        #expect(reported == [.p3])
        NotificationCenter.default.post(name: NSWindow.didChangeScreenNotification, object: window)
        #expect(reported == [.p3, .sRGB])
        screenGamut = .p3
        NotificationCenter.default.post(name: NSWindow.didChangeScreenProfileNotification, object: window)
        #expect(reported == [.p3, .sRGB, .p3])

        view.removeFromSuperview()
        screenGamut = .sRGB
        NotificationCenter.default.post(name: NSWindow.didChangeBackingPropertiesNotification, object: window)
        #expect(reported == [.p3, .sRGB, .p3])
        otherWindow.contentView?.addSubview(view)
        #expect(reported == [.p3, .sRGB, .p3, .sRGB])
    }
    #endif
}

#if os(iOS) || os(tvOS) || os(visionOS)
/// The text style the generator assigns to `points` (swiftTextStyleForPoints).
private func nearestTextStyle(to points: CGFloat) -> UIFnTextStyle {
    let defaults: [(UIFnTextStyle, CGFloat)] = [
        (.caption2, 11), (.caption, 12), (.footnote, 13), (.subheadline, 15), (.callout, 16),
        (.body, 17), (.title3, 20), (.title2, 22), (.title, 28), (.largeTitle, 34),
    ]
    return defaults.last { candidate in defaults.allSatisfy { abs(candidate.1 - points) <= abs($0.1 - points) } }!.0
}
#endif

struct UIFnThemeFoundationTests {
    @Test
    func typeScaleMapsToDynamicTypeTextStyles() {
        let size = UIFnTheme.uifn.typography.size
        #expect([size.xs, size.sm, size.md, size.lg, size.xl].map(\.points) == [12, 13, 14, 16, 18])
        #expect([size.xs, size.sm, size.md, size.lg, size.xl].map(\.textStyle) == [.caption, .footnote, .subheadline, .callout, .body])
    }

    @Test
    func fontsUseTheThemePointsAtTheDefaultContentSize() {
        let size = UIFnTheme.uifn.typography.size
        let steps = [size.xs, size.sm, size.md, size.lg, size.xl]
        let semibold = UIFnTheme.uifn.typography.weight.semibold
        #expect(steps.map { $0.scaledPoints(for: .large) } == [12, 13, 14, 16, 18])
        #expect(size.md.font(weight: semibold) == .system(size: 14, weight: .semibold))
        #expect(size.xl.font() == .system(size: 18))
        #expect(size.md.font() != .system(.subheadline))
    }

    #if os(iOS) || os(tvOS) || os(visionOS)
    @Test
    func typeSizesScaleWithTheirTextStyle() {
        let size = UIFnTheme.uifn.typography.size
        let large = size.md.scaledPoints(compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))
        let accessibility = size.md.scaledPoints(for: .accessibility3)
        #expect(large == size.md.points)
        #expect(accessibility > large * 1.5)
        #expect(size.md.font(dynamicTypeSize: .accessibility3) == .system(size: accessibility))

        for dynamicTypeSize in DynamicTypeSize.allCases {
            let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(dynamicTypeSize))
            func styleSize(_ style: UIFont.TextStyle) -> CGFloat {
                UIFont.preferredFont(forTextStyle: style, compatibleWith: traits).pointSize
            }
            // Sizes equal to a text style's default size scale exactly like it;
            // md (14) lies between footnote (13) and subheadline (15).
            #expect(size.xs.scaledPoints(for: dynamicTypeSize) == styleSize(.caption1))
            #expect(size.lg.scaledPoints(for: dynamicTypeSize) == styleSize(.callout))
            let md = size.md.scaledPoints(for: dynamicTypeSize)
            #expect(md >= styleSize(.footnote) && md <= styleSize(.subheadline), "\(dynamicTypeSize)")
        }
    }

    @Test
    func typeScaleKeepsItsOrderAtEveryContentSize() {
        let size = UIFnTheme.uifn.typography.size
        let points = stride(from: 6.0, through: 60.0, by: 0.5).map { CGFloat($0) }
        for dynamicTypeSize in DynamicTypeSize.allCases {
            let steps = [size.xs, size.sm, size.md, size.lg, size.xl].map { $0.scaledPoints(for: dynamicTypeSize) }
            #expect(steps == steps.sorted(), "\(dynamicTypeSize): \(steps)")
            if dynamicTypeSize >= .large {
                #expect(Set(steps).count == steps.count, "\(dynamicTypeSize): \(steps)")
            }

            // Any theme: a larger size never renders smaller, whichever text
            // style its points are nearest to.
            let scaled = points.map {
                UIFnTypeSize(points: $0, textStyle: nearestTextStyle(to: $0)).scaledPoints(for: dynamicTypeSize)
            }
            #expect(scaled == scaled.sorted(), "\(dynamicTypeSize)")
        }
    }
    #else
    @Test
    func typeSizesKeepTheThemePointsWithoutDynamicType() {
        let size = UIFnTheme.uifn.typography.size
        let steps = [size.xs, size.sm, size.md, size.lg, size.xl]
        #expect(steps.map { $0.scaledPoints(for: .accessibility5) } == [12, 13, 14, 16, 18])
        #expect(size.xl.font(dynamicTypeSize: .xSmall) == .system(size: 18))
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
