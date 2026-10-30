import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// Light and dark at the smallest, default and an accessibility Dynamic Type size.
enum UIFnSnapshotAppearance: CaseIterable, CustomTestStringConvertible {
    case lightXSmall, lightLarge, lightAccessibility3, darkXSmall, darkLarge, darkAccessibility3

    var colorScheme: ColorScheme {
        switch self {
        case .lightXSmall, .lightLarge, .lightAccessibility3: .light
        case .darkXSmall, .darkLarge, .darkAccessibility3: .dark
        }
    }

    var dynamicTypeSize: DynamicTypeSize {
        switch self {
        case .lightXSmall, .darkXSmall: .xSmall
        case .lightLarge, .darkLarge: .large
        case .lightAccessibility3, .darkAccessibility3: .accessibility3
        }
    }

    var testDescription: String { "\(colorScheme == .dark ? "dark" : "light")-\(dynamicTypeSize)" }
}

struct UIFnControlStyleSnapshotTests {
    init() throws {
        try registerSnapshotFont()
    }

    #if os(macOS)
    /// Every style variant in light and dark at three Dynamic Type sizes,
    /// against the references in `__Snapshots__`.
    ///
    /// macOS has no Dynamic Type, so the styles keep the theme's points and
    /// metrics there and each size must match the one reference for its
    /// variant and color scheme. Growth with Dynamic Type is checked on iOS by
    /// `stylesGrowWithDynamicTypeOnlyWhereThePlatformScalesText`.
    @Test(arguments: UIFnStyleSubject.allCases, UIFnSnapshotAppearance.allCases)
    func styleMatchesItsSnapshot(_ subject: UIFnStyleSubject, _ appearance: UIFnSnapshotAppearance) async throws {
        let bitmap = await UIFnSnapshot.render(
            colorScheme: appearance.colorScheme,
            dynamicTypeSize: appearance.dynamicTypeSize
        ) { subject.view.snapshotCanvas() }
        try UIFnSnapshot.assertMatches(
            bitmap,
            named: "macOS/\(subject.rawValue)-\(appearance.colorScheme == .dark ? "dark" : "light")"
        )
    }
    #endif

    /// Without the canvas behind it, the control itself must change with the
    /// color scheme; on iOS this is UIKit resolving the dynamic token colors.
    @Test(arguments: UIFnStyleSubject.allCases)
    func lightAndDarkDrawDifferentTokens(_ subject: UIFnStyleSubject) async throws {
        let light = try #require(await UIFnSnapshot.render(colorScheme: .light) { subject.view.uifnFontFamily(snapshotFontFamily) })
        let dark = try #require(await UIFnSnapshot.render(colorScheme: .dark) { subject.view.uifnFontFamily(snapshotFontFamily) })
        #expect(dark.differingFraction(from: light) > UIFnStateChange.minimumDifferingFraction)
    }

    @Test(arguments: UIFnStyleSubject.allCases)
    func stylesGrowWithDynamicTypeOnlyWhereThePlatformScalesText(_ subject: UIFnStyleSubject) async throws {
        var heights: [Int] = []
        for size in [DynamicTypeSize.xSmall, .large, .accessibility3] {
            heights.append(try #require(await UIFnSnapshot.render(dynamicTypeSize: size) { subject.view.snapshotCanvas() }).height)
        }
        #if os(macOS)
        #expect(Set(heights).count == 1, "\(heights)")
        #else
        #expect(heights[0] < heights[1] && heights[1] < heights[2], "\(heights)")
        #endif
    }
}
