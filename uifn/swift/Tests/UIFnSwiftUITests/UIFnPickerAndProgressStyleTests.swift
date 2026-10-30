import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// The pickers, the menu style and the progress and gauge styles draw what
/// their public API is given: the selection, enabled state, menu indicator,
/// progress and gauge value.
struct UIFnPickerAndProgressStyleTests {
    init() throws {
        try registerSnapshotFont()
    }

    private func expectSameRendering(
        _ view: @escaping @MainActor () -> some View,
        _ expected: @escaping @MainActor () -> some View,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async throws {
        let rendered = try #require(await UIFnSnapshot.render { view().isolated() }, sourceLocation: sourceLocation)
        let reference = try #require(await UIFnSnapshot.render { expected().isolated() }, sourceLocation: sourceLocation)
        #expect(rendered.width == reference.width && rendered.height == reference.height, sourceLocation: sourceLocation)
        #expect(rendered.differingFraction(from: reference) == 0, sourceLocation: sourceLocation)
    }

    private func render(_ view: @escaping @MainActor () -> some View) async throws -> UIFnBitmap {
        try #require(await UIFnSnapshot.render { view().isolated() })
    }

    // MARK: - Segmented picker

    private static let labels = UIFnStatefulControl.segmentLabels

    @Test(arguments: UIFnSegmentedPickerVariant.allCases, [true, false])
    func segmentedPickerDrawsItsSelectionAndEnabledState(_ variant: UIFnSegmentedPickerVariant, _ isEnabled: Bool) async throws {
        try await expectSameRendering(
            {
                UIFnSegmentedPicker("Range", selection: .constant("Week"), options: Self.labels, variant: variant) { Text($0) }
                    .fixedSize()
                    .disabled(!isEnabled)
            },
            { UIFnStatefulControl.segments(variant, selected: 1, state: UIFnControlState(isEnabled: isEnabled)) }
        )
    }

    @Test(arguments: UIFnSegmentedPickerVariant.allCases)
    func aSelectionThatIsNotAnOptionSelectsNoSegment(_ variant: UIFnSegmentedPickerVariant) async throws {
        try await expectSameRendering(
            { UIFnSegmentedPicker("Range", selection: .constant("Year"), options: Self.labels, variant: variant) { Text($0) }.fixedSize() },
            { UIFnStatefulControl.segments(variant, selected: nil, state: UIFnControlState()) }
        )
    }

    @Test
    func optionsThatRepeatAnEarlierOneAreLeftOut() async throws {
        #expect(uifnUniqueOptions(["Day", "Week", "Day", "Month", "Week"]) == ["Day", "Week", "Month"])
        try await expectSameRendering(
            {
                UIFnSegmentedPicker("Range", selection: .constant("Week"), options: ["Day", "Week", "Day", "Month", "Week"]) { Text($0) }
                    .fixedSize()
            },
            { UIFnStatefulControl.segments(.segmented, selected: 1, state: UIFnControlState()) }
        )
    }

    @Test
    func theArrowKeysSelectTheNeighborAndStopAtTheEnds() {
        #expect(UIFnSegmentedSelection.index(after: 1, forward: true, count: 3) == 2)
        #expect(UIFnSegmentedSelection.index(after: 1, forward: false, count: 3) == 0)
        #expect(UIFnSegmentedSelection.index(after: 2, forward: true, count: 3) == nil)
        #expect(UIFnSegmentedSelection.index(after: 0, forward: false, count: 3) == nil)
        #expect(UIFnSegmentedSelection.index(after: nil, forward: true, count: 3) == 0)
        #expect(UIFnSegmentedSelection.index(after: nil, forward: false, count: 3) == 2)
        #expect(UIFnSegmentedSelection.index(after: nil, forward: true, count: 0) == nil)
    }

    /// Segments are as wide as the widest without a width offered, share the
    /// width offered, and run from the leading edge in either direction.
    @Test(arguments: [LayoutDirection.leftToRight, .rightToLeft])
    func segmentsShareTheWidthEquallyFromTheLeadingEdge(_ direction: LayoutDirection) async throws {
        @MainActor func segments() -> some View {
            UIFnSegmentsLayout {
                Color(.sRGB, red: 1, green: 0, blue: 0).frame(idealWidth: 10)
                Color(.sRGB, red: 0, green: 0, blue: 1).frame(idealWidth: 30)
            }
            .frame(height: 4)
            .environment(\.layoutDirection, direction)
        }
        let ideal = try #require(await UIFnSnapshot.render { segments() })
        #expect(ideal.width == Int(60 * UIFnSnapshot.scale))
        let offered = try #require(await UIFnSnapshot.render { segments().frame(width: 100) })
        #expect(offered.width == Int(100 * UIFnSnapshot.scale))
        // The color of the pixel a quarter and three quarters across.
        func isRed(_ bitmap: UIFnBitmap, at fraction: Double) -> Bool {
            let x = Int(Double(bitmap.width) * fraction)
            let pixel = (bitmap.width * (bitmap.height / 2) + x) * 4
            return bitmap.pixels[pixel] > 200 && bitmap.pixels[pixel + 2] < 50
        }
        for bitmap in [ideal, offered] {
            #expect(isRed(bitmap, at: 0.25) == (direction == .leftToRight))
            #expect(isRed(bitmap, at: 0.75) == (direction == .rightToLeft))
        }
    }

    // MARK: - Menu

    // UIKit draws iOS menus, which ImageRenderer cannot, so these check the
    // public menu on macOS only.
    #if os(macOS)
    @Test(arguments: [true, false])
    func menuStyleDrawsTheEnabledState(_ isEnabled: Bool) async throws {
        try await expectSameRendering(
            { Menu("Options") { Button("Rename") {} }.menuStyle(.uifn).disabled(!isEnabled) },
            { UIFnMenuAppearance(label: Text("Options"), state: UIFnControlState(isEnabled: isEnabled)) }
        )
    }

    @Test
    func aHiddenMenuIndicatorLeavesOutTheChevron() async throws {
        try await expectSameRendering(
            { Menu("Options") { Button("Rename") {} }.menuStyle(.uifn).menuIndicator(.hidden) },
            { UIFnMenuAppearance(label: Text("Options"), state: UIFnControlState(), showsIndicator: false) }
        )
        let shown = try await render { UIFnMenuAppearance(label: Text("Options"), state: UIFnControlState()) }
        let hidden = try await render { UIFnMenuAppearance(label: Text("Options"), state: UIFnControlState(), showsIndicator: false) }
        #expect(hidden.width < shown.width)
    }

    @Test(arguments: [true, false])
    func menuPickerShowsTheSelectedOptionOrItsMutedLabel(_ isEnabled: Bool) async throws {
        try await expectSameRendering(
            { UIFnMenuPicker("Sort", selection: .constant("Date"), options: ["Name", "Date"]) { Text($0) }.disabled(!isEnabled) },
            { UIFnMenuAppearance(label: Text("Date"), state: UIFnControlState(isEnabled: isEnabled)) }
        )
        try await expectSameRendering(
            { UIFnMenuPicker("Sort", selection: .constant("Size"), options: ["Name", "Date"]) { Text($0) }.disabled(!isEnabled) },
            { UIFnMenuAppearance(label: UIFnMutedText(text: "Sort"), state: UIFnControlState(isEnabled: isEnabled)) }
        )
    }
    #endif

    // MARK: - Progress

    @MainActor
    private static func progress(_ variant: UIFnProgressViewStyle.Variant, _ progress: UIFnProgress) -> some View {
        UIFnProgressAppearance(variant: variant, progress: progress, label: Text("Upload"), currentValueLabel: Text("40%"))
            .frame(width: variant == .linear ? 200 : nil)
    }

    @Test(arguments: UIFnProgressViewStyle.Variant.allCases, [0, 0.4, 1])
    func progressViewStyleDrawsTheProgress(_ variant: UIFnProgressViewStyle.Variant, _ fraction: Double) async throws {
        try await expectSameRendering(
            {
                ProgressView(value: fraction) { Text("Upload") } currentValueLabel: { Text("40%") }
                    .progressViewStyle(.uifn(variant))
                    .frame(width: variant == .linear ? 200 : nil)
            },
            { Self.progress(variant, .determinate(fraction)) }
        )
    }

    @Test(arguments: UIFnProgressViewStyle.Variant.allCases)
    func progressOutsideZeroToOneDrawsTheNearerEndAndNotANumberNone(_ variant: UIFnProgressViewStyle.Variant) async throws {
        let none = try await render { Self.progress(variant, .determinate(0)) }
        let full = try await render { Self.progress(variant, .determinate(1)) }
        #expect(full.differingFraction(from: none) > UIFnStateChange.minimumDifferingFraction)
        #expect(try await render { Self.progress(variant, .determinate(-0.5)) }.differingFraction(from: none) == 0)
        #expect(try await render { Self.progress(variant, .determinate(.nan)) }.differingFraction(from: none) == 0)
        #expect(try await render { Self.progress(variant, .determinate(1.5)) }.differingFraction(from: full) == 0)
        #expect(try await render { Self.progress(variant, .determinate(.infinity)) }.differingFraction(from: full) == 0)
    }

    /// The public style draws indeterminate progress at the time it renders,
    /// so two renders apart in time differ.
    @Test(arguments: UIFnProgressViewStyle.Variant.allCases)
    func indeterminateProgressMoves(_ variant: UIFnProgressViewStyle.Variant) async throws {
        @MainActor func indeterminate() -> some View {
            ProgressView().progressViewStyle(.uifn(variant)).frame(width: variant == .linear ? 200 : nil)
        }
        let first = try await render { indeterminate() }
        try await Task.sleep(nanoseconds: 300_000_000)
        let later = try await render { indeterminate() }
        #expect(later.differingFraction(from: first) > 0)
    }

    /// Under Reduce Motion the indicator stays where it is and fades, so two
    /// phases at the same opacity draw the same.
    @Test(arguments: UIFnProgressViewStyle.Variant.allCases)
    func indeterminateProgressFadesInPlaceUnderReduceMotion(_ variant: UIFnProgressViewStyle.Variant) async throws {
        func phase(_ phase: Double, reduceMotion: Bool) async throws -> UIFnBitmap {
            try await render {
                Self.progress(variant, .indeterminate(phase: phase)).environment(\._accessibilityReduceMotion, reduceMotion)
            }
        }
        let moving = (try await phase(0.25, reduceMotion: false), try await phase(0.75, reduceMotion: false))
        #expect(moving.0.differingFraction(from: moving.1) > UIFnStateChange.minimumDifferingFraction)
        let still = (try await phase(0.25, reduceMotion: true), try await phase(0.75, reduceMotion: true))
        #expect(still.0.differingFraction(from: still.1) == 0)
        let faded = try await phase(0.5, reduceMotion: true)
        #expect(faded.differingFraction(from: still.0) > 0)
        #expect(UIFnProgress.fadingOpacity(phase: 0) == 1)
        #expect(abs(UIFnProgress.fadingOpacity(phase: 0.25) - UIFnProgress.fadingOpacity(phase: 0.75)) < 1e-9)
    }

    @Test
    func theIndeterminatePhaseRunsFromZeroToOneEachPeriod() {
        let period = 1.5
        for seconds in [0, 0.75, 1.5, 2.25, -0.75, 1_000_000.3] {
            let phase = UIFnProgress.phase(at: Date(timeIntervalSinceReferenceDate: seconds), period: period)
            #expect((0..<1).contains(phase), "\(seconds)")
        }
        #expect(UIFnProgress.phase(at: Date(timeIntervalSinceReferenceDate: 0.75), period: period) == 0.5)
        #expect(UIFnProgress.phase(at: Date(timeIntervalSinceReferenceDate: -0.375), period: period) == 0.75)
    }

    // MARK: - Gauge

    @MainActor
    private static func gauge(_ variant: UIFnGaugeStyle.Variant, _ value: Double) -> some View {
        UIFnGaugeAppearance(
            variant: variant,
            value: value,
            label: Text("Storage"),
            currentValueLabel: Text("60"),
            minimumValueLabel: Text("0"),
            maximumValueLabel: Text("50")
        )
        .frame(width: variant == .linear ? 220 : nil)
    }

    /// The gauge draws its value as a fraction of its range, and a value
    /// outside the range as the nearer end.
    @Test(arguments: UIFnGaugeStyle.Variant.allCases, [(30.0, 0.6), (0, 0), (50, 1), (80, 1), (-10, 0)])
    func gaugeStyleDrawsTheValueThroughItsRange(_ variant: UIFnGaugeStyle.Variant, _ value: (Double, Double)) async throws {
        try await expectSameRendering(
            {
                Gauge(value: value.0, in: 0...50) { Text("Storage") } currentValueLabel: { Text("60") } minimumValueLabel: { Text("0") } maximumValueLabel: { Text("50") }
                    .gaugeStyle(.uifn(variant))
                    .frame(width: variant == .linear ? 220 : nil)
            },
            { Self.gauge(variant, value.1) }
        )
    }

    @Test(arguments: UIFnGaugeStyle.Variant.allCases)
    func aGaugeValueOutsideZeroToOneDrawsTheNearerEndAndNotANumberTheMinimum(_ variant: UIFnGaugeStyle.Variant) async throws {
        let empty = try await render { Self.gauge(variant, 0) }
        let full = try await render { Self.gauge(variant, 1) }
        #expect(full.differingFraction(from: empty) > UIFnStateChange.minimumDifferingFraction)
        #expect(try await render { Self.gauge(variant, -1) }.differingFraction(from: empty) == 0)
        #expect(try await render { Self.gauge(variant, .nan) }.differingFraction(from: empty) == 0)
        #expect(try await render { Self.gauge(variant, 2) }.differingFraction(from: full) == 0)
    }

    @Test(arguments: UIFnGaugeStyle.Variant.allCases)
    func aGaugeWithoutBoundLabelsLeavesThemOut(_ variant: UIFnGaugeStyle.Variant) async throws {
        try await expectSameRendering(
            {
                Gauge(value: 0.6) { Text("Storage") } currentValueLabel: { Text("60") }
                    .gaugeStyle(.uifn(variant))
                    .frame(width: variant == .linear ? 220 : nil)
            },
            {
                UIFnGaugeAppearance(
                    variant: variant,
                    value: 0.6,
                    label: Text("Storage"),
                    currentValueLabel: Text("60"),
                    minimumValueLabel: EmptyView?.none,
                    maximumValueLabel: EmptyView?.none
                )
                .frame(width: variant == .linear ? 220 : nil)
            }
        )
    }
}
