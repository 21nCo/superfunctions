import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// The accessibility elements each component gives assistive technologies:
/// their roles (traits on iOS), labels and values, read from the tree SwiftUI
/// builds for them in a window.
///
/// Each test shows a window on the main actor and reads its tree until it
/// holds what the test expects or a moment passes, then checks the last read.
/// The tests run one at a time, and other suites' main-actor work runs
/// between reads.
@MainActor @Suite(.serialized)
struct UIFnComponentAccessibilityTests {
    private typealias Expected = (UIFnAccessibilityRole, label: String?, value: String?)

    /// Whether the elements are the expected ones, in order.
    private static func match(_ elements: [UIFnAccessibilityElement], _ expected: [Expected]) -> Bool {
        elements.count == expected.count && zip(elements, expected).allSatisfy { element, expected in
            element.is(expected.0) && element.label == expected.label && element.value == expected.value
        }
    }

    /// The view's elements, once they match `expected` or after a moment.
    private func elements(_ view: some View, matching expected: [Expected]) async -> [UIFnAccessibilityElement] {
        let host = UIFnAccessibilityHost(view.environment(\.locale, Locale(identifier: "en_US")))
        defer { host.close() }
        return await host.elements { Self.match($0, expected) }
    }

    /// Expects the view's elements to be the expected ones, in order.
    private func expectElements(
        _ view: some View,
        _ expected: [Expected],
        sourceLocation: SourceLocation = #_sourceLocation
    ) async {
        let elements = await elements(view, matching: expected)
        #expect(elements.count == expected.count, "\(elements)", sourceLocation: sourceLocation)
        for (element, (role, label, value)) in zip(elements, expected) {
            #expect(element.is(role), "\(element) is not \(role)", sourceLocation: sourceLocation)
            #expect(element.label == label, "\(element)", sourceLocation: sourceLocation)
            #expect(element.value == value, "\(element)", sourceLocation: sourceLocation)
        }
    }

    // MARK: - Segmented meter

    /// The meter is one progress indicator with its label, whose value is the
    /// share of its range as a whole percentage. Like the lit segments, a value
    /// strictly inside the range never reads as 0% or 100%.
    @Test(arguments: [
        (0.6, 0.0...1.0, "60%"),
        (30, 0...50, "60%"),
        (-5, 0...50, "0%"),
        (1.5, 0...1, "100%"),
        (.nan, 0...1, "0%"),
        (0.04, 0...1, "4%"),
        (0.004, 0...1, "1%"),
        (0.996, 0...1, "99%"),
        (0.2, 0...1000, "1%"),
        (999.8, 0...1000, "99%"),
        (0, -Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude, "50%"),
        (-Double.greatestFiniteMagnitude, -Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude, "0%"),
        (Double.greatestFiniteMagnitude, -Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude, "100%"),
    ] as [(Double, ClosedRange<Double>, String)])
    func segmentedMeterIsAProgressIndicatorWithItsValueAsAPercentage(_ value: Double, _ bounds: ClosedRange<Double>, _ percent: String) async {
        await expectElements(
            UIFnSegmentedMeter("Storage", value: value, in: bounds, segments: 5),
            [(.progressIndicator, "Storage", percent)]
        )
    }

    /// A `Float` meter reads what the same `Double` meter does, and a value
    /// just inside either end of its range reads 1% or 99%, not 0% or 100%.
    @Test(arguments: [
        (Float(70), Float(0)...Float(100), "70%"),
        (Float(1).nextDown, Float(-1)...Float(1), "99%"),
        (Float(-1).nextUp, Float(-1)...Float(1), "1%"),
        (Float(1), Float(-1)...Float(1), "100%"),
    ] as [(Float, ClosedRange<Float>, String)])
    func aFloatSegmentedMeterReadsItsShareAsAPercentage(_ value: Float, _ bounds: ClosedRange<Float>, _ percent: String) async {
        await expectElements(
            UIFnSegmentedMeter("Storage", value: value, in: bounds, segments: 5),
            [(.progressIndicator, "Storage", percent)]
        )
    }

    #if (arch(i386) || arch(x86_64)) && !(os(Windows) || os(Android))
    /// A `Float80` value halfway through a range narrower than a `Double` can
    /// tell apart reads 50%.
    @Test
    func aFloat80SegmentedMeterReadsItsShareAsAPercentage() async {
        let step = Float80(Double.ulpOfOne)
        await expectElements(
            UIFnSegmentedMeter("Storage", value: 1 + step / 2, in: 1...1 + step, segments: 5),
            [(.progressIndicator, "Storage", "50%")]
        )
    }
    #endif

    /// A title string is shown as it is, as the other components' text is,
    /// not looked up or parsed as Markdown as a localized key would be.
    @Test
    func segmentedMetersTitleIsReadAsItIs() async {
        await expectElements(
            UIFnSegmentedMeter("*Storage*", value: 0.5),
            [(.progressIndicator, "*Storage*", "50%")]
        )
    }

    /// A current value label is drawn, but the value read is the percentage.
    @Test
    func segmentedMeterReadsThePercentageOverItsCurrentValueLabel() async {
        await expectElements(
            UIFnSegmentedMeter(value: 3, in: 0...5, segments: 5) { Text("Signal") } currentValueLabel: { Text("3 bars") },
            [(.progressIndicator, "Signal", "60%")]
        )
    }

    // MARK: - Banner

    @Test
    func bannerReadsItsTextThenItsActionsThenItsDismissButton() async {
        await expectElements(
            UIFnBanner("Upload failed", message: "The file is too large.", tone: .danger, dismiss: UIFnBannerDismiss("Dismiss") {}) {
                Button("Retry") {}
            },
            [(.staticText, "Upload failed", "The file is too large."), (.button, "Retry", nil), (.button, "Dismiss", nil)]
        )
    }

    /// The tone bar and the drawn cross are not elements of their own.
    @Test
    func aBannerWithOnlyATitleIsOneText() async {
        await expectElements(UIFnBanner("Saved"), [(.staticText, "Saved", nil)])
    }

    @Test
    func pressingTheDismissButtonDismissesOnce() async throws {
        var dismissals = 0
        let banner = UIFnBanner("Saved", dismiss: UIFnBannerDismiss("Dismiss") { dismissals += 1 })
        let button = try #require(await elements(banner, matching: [(.staticText, "Saved", nil), (.button, "Dismiss", nil)]).last)
        #expect(button.is(.button) && button.label == "Dismiss", "\(button)")
        #expect(button.press())
        #expect(dismissals == 1)
    }

    // MARK: - Empty state

    /// The title is a heading and the icon is not read.
    @Test
    func emptyStateReadsItsTitleAsAHeadingThenItsMessageAndActions() async {
        await expectElements(
            UIFnEmptyState("No files", message: "Files you add appear here.") {
                Image(systemName: "tray")
            } actions: {
                Button("Add a file") {}
            },
            [(.heading, "No files", nil), (.staticText, "Files you add appear here.", nil), (.button, "Add a file", nil)]
        )
    }

    /// A single trailing closure is the icon, so a text in it is not read;
    /// actions passed labeled are read after the title.
    @Test
    func anEmptyStatesSingleTrailingClosureIsAHiddenIcon() async {
        await expectElements(UIFnEmptyState("No files") { Text("Decoration") }, [(.heading, "No files", nil)])
        await expectElements(
            UIFnEmptyState("No files", actions: { Button("Add a file") {} }),
            [(.heading, "No files", nil), (.button, "Add a file", nil)]
        )
    }

    @Test
    func anEmptyStateWithOnlyATitleIsOneHeading() async {
        await expectElements(UIFnEmptyState("No files"), [(.heading, "No files", nil)])
    }

    // MARK: - Skeleton

    #if os(macOS)
    private static let busyIndicatorValue: String? = "0"
    #else
    private static let busyIndicatorValue: String? = nil
    #endif

    /// The placeholder blocks are one busy indicator with the skeleton's
    /// label. AppKit gives every busy indicator the value 0, which VoiceOver
    /// does not read; UIKit gives it none.
    @Test(arguments: [false, true])
    func skeletonIsOneBusyIndicatorWithItsLabel(_ reduceMotion: Bool) async {
        await expectElements(
            UIFnSkeleton("Loading messages") {
                HStack {
                    UIFnSkeletonBlock(.circle).frame(width: 32, height: 32)
                    VStack(alignment: .leading) {
                        UIFnSkeletonBlock(.capsule).frame(width: 160, height: 12)
                        UIFnSkeletonBlock(.capsule).frame(width: 100, height: 12)
                    }
                }
            }
            .environment(\._accessibilityReduceMotion, reduceMotion),
            [(.busyIndicator, "Loading messages", Self.busyIndicatorValue)]
        )
    }
}
