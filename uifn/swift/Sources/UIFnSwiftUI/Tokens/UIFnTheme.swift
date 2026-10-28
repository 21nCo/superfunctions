import SwiftUI

#if os(iOS) || os(tvOS) || os(visionOS)
import UIKit
#endif

/// Design tokens for one uifn theme.
///
/// Generate a theme's tokens with the `uifn-swift-tokens` command from
/// `@uifn/tokens`; it writes an extension declaring `UIFnTheme.<name>`.
/// `UIFnTheme.uifn` is the default uifn theme.
public struct UIFnTheme: Equatable, Sendable {
    public let name: String
    public let colors: UIFnColors
    public let spacing: UIFnSpacing
    public let radius: UIFnRadius
    public let typography: UIFnTypography
    public let motion: UIFnMotion

    public init(
        name: String,
        colors: UIFnColors,
        spacing: UIFnSpacing,
        radius: UIFnRadius,
        typography: UIFnTypography,
        motion: UIFnMotion
    ) {
        self.name = name
        self.colors = colors
        self.spacing = spacing
        self.radius = radius
        self.typography = typography
        self.motion = motion
    }
}

// MARK: - Colors

public struct UIFnColors: Equatable, Sendable {
    public let surface: UIFnSurfaceColors
    public let text: UIFnTextColors
    public let border: UIFnBorderColors
    public let accent: UIFnToneColors
    public let danger: UIFnToneColors
    public let warning: UIFnToneColors
    public let success: UIFnToneColors
    /// The optional custom tone, present when the theme defines `color.custom`.
    public let custom: UIFnToneColors?

    public init(
        surface: UIFnSurfaceColors,
        text: UIFnTextColors,
        border: UIFnBorderColors,
        accent: UIFnToneColors,
        danger: UIFnToneColors,
        warning: UIFnToneColors,
        success: UIFnToneColors,
        custom: UIFnToneColors? = nil
    ) {
        self.surface = surface
        self.text = text
        self.border = border
        self.accent = accent
        self.danger = danger
        self.warning = warning
        self.success = success
        self.custom = custom
    }

    /// Every color with its public token name, such as `surface.canvas`.
    public var all: [(name: String, token: UIFnColorToken)] {
        var tones = [("accent", accent), ("danger", danger), ("warning", warning), ("success", success)]
        if let custom { tones.append(("custom", custom)) }
        return surface.all.map { ("surface.\($0.name)", $0.token) }
            + text.all.map { ("text.\($0.name)", $0.token) }
            + border.all.map { ("border.\($0.name)", $0.token) }
            + tones.flatMap { tone in tone.1.all.map { ("\(tone.0).\($0.name)", $0.token) } }
    }
}

public struct UIFnSurfaceColors: Equatable, Sendable {
    public let canvas: UIFnColorToken
    public let raised: UIFnColorToken
    public let sunken: UIFnColorToken
    public let overlay: UIFnColorToken
    public let depth0: UIFnColorToken
    public let depth1: UIFnColorToken
    public let depth2: UIFnColorToken
    public let depth3: UIFnColorToken
    public let depth4: UIFnColorToken

    public init(
        canvas: UIFnColorToken,
        raised: UIFnColorToken,
        sunken: UIFnColorToken,
        overlay: UIFnColorToken,
        depth0: UIFnColorToken,
        depth1: UIFnColorToken,
        depth2: UIFnColorToken,
        depth3: UIFnColorToken,
        depth4: UIFnColorToken
    ) {
        self.canvas = canvas
        self.raised = raised
        self.sunken = sunken
        self.overlay = overlay
        self.depth0 = depth0
        self.depth1 = depth1
        self.depth2 = depth2
        self.depth3 = depth3
        self.depth4 = depth4
    }

    var all: [(name: String, token: UIFnColorToken)] {
        [
            ("canvas", canvas), ("raised", raised), ("sunken", sunken), ("overlay", overlay),
            ("depth-0", depth0), ("depth-1", depth1), ("depth-2", depth2), ("depth-3", depth3), ("depth-4", depth4),
        ]
    }
}

public struct UIFnTextColors: Equatable, Sendable {
    public let primary: UIFnColorToken
    public let secondary: UIFnColorToken
    public let muted: UIFnColorToken
    public let disabled: UIFnColorToken

    public init(primary: UIFnColorToken, secondary: UIFnColorToken, muted: UIFnColorToken, disabled: UIFnColorToken) {
        self.primary = primary
        self.secondary = secondary
        self.muted = muted
        self.disabled = disabled
    }

    var all: [(name: String, token: UIFnColorToken)] {
        [("primary", primary), ("secondary", secondary), ("muted", muted), ("disabled", disabled)]
    }
}

public struct UIFnBorderColors: Equatable, Sendable {
    public let subtle: UIFnColorToken
    public let `default`: UIFnColorToken
    public let strong: UIFnColorToken

    public init(subtle: UIFnColorToken, default: UIFnColorToken, strong: UIFnColorToken) {
        self.subtle = subtle
        self.default = `default`
        self.strong = strong
    }

    var all: [(name: String, token: UIFnColorToken)] {
        [("subtle", subtle), ("default", self.default), ("strong", strong)]
    }
}

/// The accent, status and custom tones: a solid fill, a subtle fill and the
/// content color that contrasts with the solid fill.
public struct UIFnToneColors: Equatable, Sendable {
    public let solid: UIFnColorToken
    public let subtle: UIFnColorToken
    public let contrast: UIFnColorToken

    public init(solid: UIFnColorToken, subtle: UIFnColorToken, contrast: UIFnColorToken) {
        self.solid = solid
        self.subtle = subtle
        self.contrast = contrast
    }

    var all: [(name: String, token: UIFnColorToken)] {
        [("solid", solid), ("subtle", subtle), ("contrast", contrast)]
    }
}

// MARK: - Spacing and radius

/// Spacing in points; the theme's `space.<n>` token is `space<n>`.
public struct UIFnSpacing: Equatable, Sendable {
    public let space1: CGFloat
    public let space2: CGFloat
    public let space3: CGFloat
    public let space4: CGFloat
    public let space5: CGFloat
    public let space6: CGFloat
    public let space8: CGFloat
    public let space12: CGFloat

    public init(
        space1: CGFloat,
        space2: CGFloat,
        space3: CGFloat,
        space4: CGFloat,
        space5: CGFloat,
        space6: CGFloat,
        space8: CGFloat,
        space12: CGFloat
    ) {
        self.space1 = space1
        self.space2 = space2
        self.space3 = space3
        self.space4 = space4
        self.space5 = space5
        self.space6 = space6
        self.space8 = space8
        self.space12 = space12
    }
}

/// Corner radii in points.
public struct UIFnRadius: Equatable, Sendable {
    public let sm: CGFloat
    public let md: CGFloat
    public let lg: CGFloat
    public let xl: CGFloat
    public let full: CGFloat

    public init(sm: CGFloat, md: CGFloat, lg: CGFloat, xl: CGFloat, full: CGFloat) {
        self.sm = sm
        self.md = md
        self.lg = lg
        self.xl = xl
        self.full = full
    }
}

// MARK: - Typography

/// The Dynamic Type text style a theme type size scales with.
public enum UIFnTextStyle: String, Equatable, Sendable, CaseIterable {
    case caption2, caption, footnote, subheadline, callout, body, title3, title2, title, largeTitle

    public var font: Font.TextStyle {
        switch self {
        case .caption2: .caption2
        case .caption: .caption
        case .footnote: .footnote
        case .subheadline: .subheadline
        case .callout: .callout
        case .body: .body
        case .title3: .title3
        case .title2: .title2
        case .title: .title
        case .largeTitle: .largeTitle
        }
    }

    #if os(iOS) || os(tvOS) || os(visionOS)
    public var uiKit: UIFont.TextStyle {
        switch self {
        case .caption2: .caption2
        case .caption: .caption1
        case .footnote: .footnote
        case .subheadline: .subheadline
        case .callout: .callout
        case .body: .body
        case .title3: .title3
        case .title2: .title2
        case .title: .title1
        case .largeTitle: .largeTitle
        }
    }
    #endif
}

/// One step of the theme's type scale.
///
/// `points` is the theme size at the default content size; `textStyle` is the
/// Dynamic Type style with the nearest default size, which the size scales with.
public struct UIFnTypeSize: Equatable, Sendable {
    public let points: CGFloat
    public let textStyle: UIFnTextStyle

    public init(points: CGFloat, textStyle: UIFnTextStyle) {
        self.points = points
        self.textStyle = textStyle
    }

    /// The system font for this step's text style, which follows Dynamic Type.
    public func font(weight: UIFnFontWeight? = nil) -> Font {
        .system(textStyle.font, weight: weight?.weight)
    }

    #if os(iOS) || os(tvOS) || os(visionOS)
    /// `points` scaled for the trait collection's content size category.
    public func scaledPoints(compatibleWith traits: UITraitCollection? = nil) -> CGFloat {
        UIFontMetrics(forTextStyle: textStyle.uiKit).scaledValue(for: points, compatibleWith: traits)
    }
    #endif
}

public struct UIFnTypeScale: Equatable, Sendable {
    public let xs: UIFnTypeSize
    public let sm: UIFnTypeSize
    public let md: UIFnTypeSize
    public let lg: UIFnTypeSize
    public let xl: UIFnTypeSize

    public init(xs: UIFnTypeSize, sm: UIFnTypeSize, md: UIFnTypeSize, lg: UIFnTypeSize, xl: UIFnTypeSize) {
        self.xs = xs
        self.sm = sm
        self.md = md
        self.lg = lg
        self.xl = xl
    }
}

/// Line heights as multiples of the font size.
public struct UIFnLineHeights: Equatable, Sendable {
    public let tight: Double
    public let normal: Double
    public let relaxed: Double

    public init(tight: Double, normal: Double, relaxed: Double) {
        self.tight = tight
        self.normal = normal
        self.relaxed = relaxed
    }
}

/// A numeric font weight from the theme (CSS scale, 1...1000).
public struct UIFnFontWeight: Equatable, Sendable {
    public let value: Int

    public init(_ value: Int) {
        self.value = value
    }

    /// The nearest system weight; a value halfway between two weights takes the lighter one.
    public var weight: Font.Weight {
        let weights: [(Int, Font.Weight)] = [
            (100, .ultraLight), (200, .thin), (300, .light), (400, .regular), (500, .medium),
            (600, .semibold), (700, .bold), (800, .heavy), (900, .black),
        ]
        var best = weights[0]
        for candidate in weights where abs(candidate.0 - value) < abs(best.0 - value) {
            best = candidate
        }
        return best.1
    }
}

public struct UIFnFontWeights: Equatable, Sendable {
    public let regular: UIFnFontWeight
    public let medium: UIFnFontWeight
    public let semibold: UIFnFontWeight
    public let bold: UIFnFontWeight

    public init(regular: UIFnFontWeight, medium: UIFnFontWeight, semibold: UIFnFontWeight, bold: UIFnFontWeight) {
        self.regular = regular
        self.medium = medium
        self.semibold = semibold
        self.bold = bold
    }
}

public struct UIFnTypography: Equatable, Sendable {
    public let size: UIFnTypeScale
    public let lineHeight: UIFnLineHeights
    public let weight: UIFnFontWeights

    public init(size: UIFnTypeScale, lineHeight: UIFnLineHeights, weight: UIFnFontWeights) {
        self.size = size
        self.lineHeight = lineHeight
        self.weight = weight
    }
}

// MARK: - Motion

/// A duration with its reduced-motion alternative, in seconds.
public struct UIFnDuration: Equatable, Sendable {
    public let seconds: Double
    public let reducedMotionSeconds: Double

    public init(seconds: Double, reducedMotionSeconds: Double) {
        self.seconds = seconds
        self.reducedMotionSeconds = reducedMotionSeconds
    }

    public func seconds(reduceMotion: Bool) -> Double {
        reduceMotion ? reducedMotionSeconds : seconds
    }
}

/// A cubic Bézier timing curve.
public struct UIFnEasing: Equatable, Sendable {
    public let x1: Double
    public let y1: Double
    public let x2: Double
    public let y2: Double

    public init(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
        self.x1 = x1
        self.y1 = y1
        self.x2 = x2
        self.y2 = y2
    }

    /// A timing-curve animation for the duration, using its reduced-motion
    /// alternative when `reduceMotion` is true.
    public func animation(_ duration: UIFnDuration, reduceMotion: Bool = false) -> Animation {
        .timingCurve(x1, y1, x2, y2, duration: duration.seconds(reduceMotion: reduceMotion))
    }
}

public struct UIFnMotionDurations: Equatable, Sendable {
    public let fast: UIFnDuration
    public let normal: UIFnDuration
    public let slow: UIFnDuration

    public init(fast: UIFnDuration, normal: UIFnDuration, slow: UIFnDuration) {
        self.fast = fast
        self.normal = normal
        self.slow = slow
    }
}

public struct UIFnMotionEasings: Equatable, Sendable {
    public let standard: UIFnEasing
    public let entrance: UIFnEasing
    public let exit: UIFnEasing

    public init(standard: UIFnEasing, entrance: UIFnEasing, exit: UIFnEasing) {
        self.standard = standard
        self.entrance = entrance
        self.exit = exit
    }
}

public struct UIFnMotion: Equatable, Sendable {
    public let duration: UIFnMotionDurations
    public let easing: UIFnMotionEasings

    public init(duration: UIFnMotionDurations, easing: UIFnMotionEasings) {
        self.duration = duration
        self.easing = easing
    }
}
