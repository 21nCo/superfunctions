import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// The accessibility elements each component gives assistive technologies:
/// their roles (traits on iOS), labels and values, read from the tree SwiftUI
/// builds for them in a window.
///
/// Each test holds the main actor while it lays out and reads a window, so
/// they run one at a time and other suites' main-actor work runs between them.
@MainActor @Suite(.serialized)
struct UIFnComponentAccessibilityTests {
    private func elements(_ view: some View) -> [UIFnAccessibilityElement] {
        let host = UIFnAccessibilityHost(view.environment(\.locale, Locale(identifier: "en_US")))
        defer { host.close() }
        return host.elements()
    }

    private func expect(
        _ elements: [UIFnAccessibilityElement],
        _ expected: [(UIFnAccessibilityRole, label: String?, value: String?)],
        sourceLocation: SourceLocation = #_sourceLocation
    ) {
        #expect(elements.count == expected.count, "\(elements)", sourceLocation: sourceLocation)
        for (element, (role, label, value)) in zip(elements, expected) {
            #expect(element.is(role), "\(element) is not \(role)", sourceLocation: sourceLocation)
            #expect(element.label == label, "\(element)", sourceLocation: sourceLocation)
            #expect(element.value == value, "\(element)", sourceLocation: sourceLocation)
        }
    }

    // MARK: - Segmented meter

    /// The meter is one progress indicator with its label, whose value is the
    /// share of its range as a percentage, whatever its segments light.
    @Test(arguments: [
        (0.6, 0.0...1.0, "60%"),
        (30, 0...50, "60%"),
        (-5, 0...50, "0%"),
        (1.5, 0...1, "100%"),
        (.nan, 0...1, "0%"),
        (0.04, 0...1, "4%"),
    ] as [(Double, ClosedRange<Double>, String)])
    func segmentedMeterIsAProgressIndicatorWithItsValueAsAPercentage(_ value: Double, _ bounds: ClosedRange<Double>, _ percent: String) {
        expect(
            elements(UIFnSegmentedMeter("Storage", value: value, in: bounds, segments: 5)),
            [(.progressIndicator, "Storage", percent)]
        )
    }

    /// A current value label is drawn, but the value read is the percentage.
    @Test
    func segmentedMeterReadsThePercentageOverItsCurrentValueLabel() {
        expect(
            elements(UIFnSegmentedMeter(value: 3, in: 0...5, segments: 5) { Text("Signal") } currentValueLabel: { Text("3 bars") }),
            [(.progressIndicator, "Signal", "60%")]
        )
    }

    // MARK: - Banner

    @Test
    func bannerReadsItsTextThenItsActionsThenItsDismissButton() {
        expect(
            elements(UIFnBanner("Upload failed", message: "The file is too large.", tone: .danger, dismiss: UIFnBannerDismiss("Dismiss") {}) {
                Button("Retry") {}
            }),
            [(.staticText, "Upload failed", "The file is too large."), (.button, "Retry", nil), (.button, "Dismiss", nil)]
        )
    }

    /// The tone bar and the drawn cross are not elements of their own.
    @Test
    func aBannerWithOnlyATitleIsOneText() {
        expect(elements(UIFnBanner("Saved")), [(.staticText, "Saved", nil)])
    }

    @Test
    func pressingTheDismissButtonDismissesOnce() throws {
        var dismissals = 0
        let banner = UIFnBanner("Saved", dismiss: UIFnBannerDismiss("Dismiss") { dismissals += 1 })
        let button = try #require(elements(banner).first { $0.is(.button) })
        #expect(button.press())
        #expect(dismissals == 1)
    }

    // MARK: - Empty state

    /// The title is a heading and the icon is not read.
    @Test
    func emptyStateReadsItsTitleAsAHeadingThenItsMessageAndActions() {
        expect(
            elements(UIFnEmptyState("No files", message: "Files you add appear here.") {
                Image(systemName: "tray")
            } actions: {
                Button("Add a file") {}
            }),
            [(.heading, "No files", nil), (.staticText, "Files you add appear here.", nil), (.button, "Add a file", nil)]
        )
    }

    @Test
    func anEmptyStateWithOnlyATitleIsOneHeading() {
        expect(elements(UIFnEmptyState("No files")), [(.heading, "No files", nil)])
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
    func skeletonIsOneBusyIndicatorWithItsLabel(_ reduceMotion: Bool) {
        expect(
            elements(UIFnSkeleton("Loading messages") {
                HStack {
                    UIFnSkeletonBlock(.circle).frame(width: 32, height: 32)
                    VStack(alignment: .leading) {
                        UIFnSkeletonBlock(.capsule).frame(width: 160, height: 12)
                        UIFnSkeletonBlock(.capsule).frame(width: 100, height: 12)
                    }
                }
            }
            .environment(\._accessibilityReduceMotion, reduceMotion)),
            [(.busyIndicator, "Loading messages", Self.busyIndicatorValue)]
        )
    }
}
