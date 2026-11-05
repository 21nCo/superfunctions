import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// The segmented meter lights the segments its value calls for from the
/// leading edge, and the skeleton's highlight sweeps from the leading edge
/// except under Reduce Motion, where it stays still.
struct UIFnComponentTests {
    // MARK: - Segmented meter

    /// Rounded to the nearest segment, except that only the minimum lights none
    /// and only the maximum lights all.
    @Test(arguments: [
        (0, 5, 0), (0.001, 5, 1), (0.09, 5, 1), (0.3, 5, 2), (0.5, 5, 3), (0.6, 5, 3), (0.7, 5, 4),
        (0.95, 5, 4), (0.999, 5, 4), (1, 5, 5), (1.5, 5, 5), (-1, 5, 0), (.nan, 5, 0),
        (0.01, 100, 1),
        // Counts below the minimum light as 2 segments: an interior value lights 1.
        (0.5, 2, 1), (0.001, 2, 1), (0.999, 2, 1), (1, 2, 2), (0, 2, 0),
        (0.5, 1, 1), (1, 1, 2), (0, 1, 0), (0.5, 0, 1), (1, 0, 2), (0.5, -3, 1),
        // Counts above the maximum light as 100 segments.
        (0.5, 1_000, 50), (0.999, 1_000, 99), (1, 1_000, 100), (0.001, Int.max, 1),
        (0.5, Int.max, 50), (0.999, Int.max, 99), (1, Int.max, 100), (0.5, Int.min, 1), (1, Int.min, 2),
    ] as [(Double, Int, Int)])
    func aMeterLightsItsShareOfSegments(_ fraction: Double, _ segments: Int, _ lit: Int) {
        #expect(UIFnMeterValue.litSegments(fraction, of: segments) == lit)
    }

    /// A whole percentage, except that only the minimum reads 0 and only the
    /// maximum reads 100, matching the lit segments.
    @Test(arguments: [
        (0, 0), (0.004, 1), (0.005, 1), (0.014, 1), (0.016, 2), (0.4, 40), (0.984, 98),
        (0.995, 99), (0.996, 99), (0.9999, 99), (1, 100), (-1, 0), (2, 100), (.nan, 0),
    ] as [(Double, Int)])
    func aMeterReadsAsTheWholePercentageItsSegmentsShow(_ fraction: Double, _ percent: Int) {
        #expect(UIFnMeterValue.percent(fraction) == percent)
    }

    @Test(arguments: [
        (5, 0...10, 0.5), (15, 0...10, 1), (-5, 0...10, 0), (.nan, 0...10, 0), (.infinity, 0...10, 1),
        (5, 5...5, 0), (5, -Double.infinity...Double.infinity, 0), (-.infinity, 0...1, 0),
    ] as [(Double, ClosedRange<Double>, Double)])
    func aMetersFractionIsWithinItsRange(_ value: Double, _ bounds: ClosedRange<Double>, _ fraction: Double) {
        #expect(UIFnMeterValue.fraction(value, in: bounds) == fraction)
    }

    /// Finite bounds too far apart to subtract still give a value its share:
    /// the midpoint of the widest range lights half the segments and reads 50%.
    @Test(arguments: [
        (0, -Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude, 0.5, 2, 50),
        (Double.greatestFiniteMagnitude / 2, -Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude, 0.75, 3, 75),
        (-Double.greatestFiniteMagnitude, -Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude, 0, 0, 0),
        (Double.greatestFiniteMagnitude, -Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude, 1, 4, 100),
        (.infinity, -Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude, 1, 4, 100),
        (-.infinity, -Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude, 0, 0, 0),
        (.nan, -Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude, 0, 0, 0),
        (0, -Double.greatestFiniteMagnitude...0, 1, 4, 100),
        (Double.greatestFiniteMagnitude, -Double.greatestFiniteMagnitude / 2...Double.greatestFiniteMagnitude, 1, 4, 100),
    ] as [(Double, ClosedRange<Double>, Double, Int, Int)])
    func aMeterOverTheWidestRangeLightsAndReadsItsShare(
        _ value: Double, _ bounds: ClosedRange<Double>, _ fraction: Double, _ lit: Int, _ percent: Int
    ) {
        let share = UIFnMeterValue.fraction(value, in: bounds)
        #expect(share == fraction)
        #expect(UIFnMeterValue.litSegments(share, of: 4) == lit)
        #expect(UIFnMeterValue.percent(share) == percent)
    }

    /// Any floating-point type's widest range works too.
    @Test
    func aMeterOverAFloatTypesWidestRangeReadsItsShare() {
        #expect(UIFnMeterValue.fraction(Float(0), in: -Float.greatestFiniteMagnitude...Float.greatestFiniteMagnitude) == 0.5)
        #expect(UIFnMeterValue.fraction(Float(1), in: 0...4) == 0.25)
    }

    /// A value strictly inside the range, however close to an end, lights
    /// at least one of five segments and leaves one unlit, and reads from 1%
    /// to 99%; a `Float` value lights what the same `Double` value does.
    @Test
    func aMeterNeverShowsAValueInsideItsRangeAsAnEnd() {
        let widest = -Double.greatestFiniteMagnitude...Double.greatestFiniteMagnitude
        let rows: [(String, Double, Int, Int)] = [
            ("Float 70 in 0...100", UIFnMeterValue.fraction(Float(70), in: 0...100), 4, 70),
            ("Float 1.nextDown in -1...1", UIFnMeterValue.fraction(Float(1).nextDown, in: -1...1), 4, 99),
            ("Float -1.nextUp in -1...1", UIFnMeterValue.fraction(Float(-1).nextUp, in: -1...1), 1, 1),
            ("Float 100.nextDown in 0...100", UIFnMeterValue.fraction(Float(100).nextDown, in: 0...100), 4, 99),
            ("Float 1 in -1...1", UIFnMeterValue.fraction(Float(1), in: -1...1), 5, 100),
            ("Float -1 in -1...1", UIFnMeterValue.fraction(Float(-1), in: -1...1), 0, 0),
            ("Double 1.nextDown in -1...1", UIFnMeterValue.fraction(Double(1).nextDown, in: -1...1), 4, 99),
            ("Double -1.nextUp in -1...1", UIFnMeterValue.fraction(Double(-1).nextUp, in: -1...1), 1, 1),
            (
                "Double leastNonzero in 0...max",
                UIFnMeterValue.fraction(Double.leastNonzeroMagnitude, in: 0...Double.greatestFiniteMagnitude), 1, 1
            ),
            ("Double max.nextDown in widest", UIFnMeterValue.fraction(Double.greatestFiniteMagnitude.nextDown, in: widest), 4, 99),
            ("Double -max.nextUp in widest", UIFnMeterValue.fraction((-Double.greatestFiniteMagnitude).nextUp, in: widest), 1, 1),
        ]
        for (name, share, lit, percent) in rows {
            #expect(UIFnMeterValue.litSegments(share, of: 5) == lit, "\(name): \(share)")
            #expect(UIFnMeterValue.percent(share) == percent, "\(name): \(share)")
        }
        #expect(UIFnMeterValue.fraction(Float(70), in: 0...100) == UIFnMeterValue.fraction(70.0, in: 0...100))
    }

    #if (arch(i386) || arch(x86_64)) && !(os(Windows) || os(Android))
    /// A type wider than `Double` keeps its precision: a `Float80` value
    /// halfway through a range narrower than a `Double` can tell apart reads
    /// as halfway, not as an end.
    @Test
    func aFloat80MeterKeepsItsPrecision() {
        let step = Float80(Double.ulpOfOne)
        let rows: [(String, Double, Int, Int)] = [
            ("1 + step/2 in 1...1+step", UIFnMeterValue.fraction(1 + step / 2, in: 1...1 + step), 3, 50),
            ("1 + step/4 in 1...1+step", UIFnMeterValue.fraction(1 + step / 4, in: 1...1 + step), 1, 25),
            ("-1 - step/2 in -1-step...-1", UIFnMeterValue.fraction(-1 - step / 2, in: -1 - step...(-1)), 3, 50),
            (
                "least/2 in 0...least",
                UIFnMeterValue.fraction(Float80(Double.leastNonzeroMagnitude) / 2, in: 0...Float80(Double.leastNonzeroMagnitude)), 3, 50
            ),
        ]
        for (name, share, lit, percent) in rows {
            #expect(UIFnMeterValue.litSegments(share, of: 5) == lit, "\(name): \(share)")
            #expect(UIFnMeterValue.percent(share) == percent, "\(name): \(share)")
        }
    }
    #endif

    /// A `Float` meter just below its maximum draws as a `Double` meter at
    /// 0.75, four of five segments lit, not as a full one.
    @Test
    func aFloatMeterJustBelowItsMaximumIsNotDrawnFull() async throws {
        let nearTop = try #require(await UIFnSnapshot.render {
            UIFnSegmentedMeter(value: Float(1).nextDown, in: -1...1, segments: 5) { EmptyView() }.frame(width: 100)
        })
        let fourLit = try #require(await UIFnSnapshot.render { Self.meter(0.75, segments: 5) })
        let full = try #require(await UIFnSnapshot.render { Self.meter(1, segments: 5) })
        #expect(nearTop.differingFraction(from: fourLit, tolerance: 0) == 0)
        #expect(nearTop.differingFraction(from: full, tolerance: 0) > 0)
    }

    @MainActor
    private static func meter(_ value: Double, segments: Int, _ direction: LayoutDirection = .leftToRight) -> some View {
        UIFnSegmentedMeter(value: value, segments: segments) { EmptyView() }
            .frame(width: 100)
            .environment(\.layoutDirection, direction)
    }

    /// The red, green and blue of the pixel a fraction of the way across the
    /// middle of the bitmap's bottom row of points, where a meter's bar is.
    private static func barPixel(_ bitmap: UIFnBitmap, at fraction: Double) -> [UInt8] {
        let x = Int(Double(bitmap.width) * fraction)
        let y = bitmap.height - Int(2 * UIFnSnapshot.scale)
        let pixel = (bitmap.width * y + x) * 4
        return Array(bitmap.pixels[pixel..<pixel + 3])
    }

    /// One lit segment of five is at the leading end: the left in a
    /// left-to-right layout and the right in a right-to-left one.
    @Test
    func aMeterLightsSegmentsFromTheLeadingEdge() async throws {
        let ltr = try #require(await UIFnSnapshot.render { Self.meter(0.2, segments: 5) })
        let rtl = try #require(await UIFnSnapshot.render { Self.meter(0.2, segments: 5, .rightToLeft) })
        let lit = Self.barPixel(ltr, at: 0.1)
        let unlit = Self.barPixel(ltr, at: 0.9)
        #expect(lit != unlit)
        #expect(Self.barPixel(ltr, at: 0.5) == unlit)
        #expect(Self.barPixel(rtl, at: 0.9) == lit)
        #expect(Self.barPixel(rtl, at: 0.1) == unlit)
    }

    /// A meter of fewer than two segments draws two, so a value inside the
    /// range lights the first and leaves the second unlit.
    @Test(arguments: [1, 0, -3, Int.min])
    func aMeterHasAtLeastTwoSegments(_ segments: Int) async throws {
        for value in [0.001, 0.5, 0.999, 1] {
            let drawn = try #require(await UIFnSnapshot.render { Self.meter(value, segments: segments) })
            let two = try #require(await UIFnSnapshot.render { Self.meter(value, segments: 2) })
            #expect(drawn.differingFraction(from: two, tolerance: 0) == 0, "\(value)")
        }
        let half = try #require(await UIFnSnapshot.render { Self.meter(0.5, segments: segments) })
        let full = try #require(await UIFnSnapshot.render { Self.meter(1, segments: segments) })
        let empty = try #require(await UIFnSnapshot.render { Self.meter(0, segments: segments) })
        #expect(Self.barPixel(half, at: 0.25) == Self.barPixel(full, at: 0.25))
        #expect(Self.barPixel(half, at: 0.75) == Self.barPixel(empty, at: 0.75))
        #expect(Self.barPixel(half, at: 0.25) != Self.barPixel(half, at: 0.75))
    }

    /// A meter has from 2 to 100 segments, whatever count it is given.
    @Test(arguments: [
        (Int.min, 2), (-3, 2), (0, 2), (1, 2), (2, 2), (5, 5), (100, 100), (101, 100), (1_000, 100), (Int.max, 100),
    ])
    func aMetersSegmentCountIsFromTheMinimumToTheMaximum(_ segments: Int, _ count: Int) {
        #expect(UIFnMeterValue.segmentCount(segments) == count)
    }

    /// Segments past the maximum are not drawn, and drawing as many segments
    /// as an `Int` holds does not overflow.
    @Test
    func aMetersSegmentsStopAtTheMaximum() {
        let rect = CGRect(x: 0, y: 0, width: 400, height: 8)
        func rects(_ count: Int, lit: Range<Int>) -> Int {
            var moves = 0
            UIFnMeterSegments(count: count, lit: lit, gap: 2, cornerRadius: 2).path(in: rect).forEach {
                if case .move = $0 { moves += 1 }
            }
            return moves
        }
        #expect(rects(100, lit: 0..<100) == 100)
        #expect(rects(Int.max, lit: 0..<Int.max) == 100)
        #expect(rects(1_000, lit: 50..<1_000) == 50)
        #expect(rects(1, lit: 0..<1) == 1)
        #expect(rects(0, lit: 0..<Int.max) == 2)
        let drawn = UIFnMeterSegments(count: Int.max, lit: 0..<Int.max, gap: 2, cornerRadius: 2).path(in: rect)
        let most = UIFnMeterSegments(count: 100, lit: 0..<100, gap: 2, cornerRadius: 2).path(in: rect)
        #expect(drawn.boundingRect == most.boundingRect)
    }

    /// A meter of more than 100 segments draws 100.
    @Test(arguments: [1_000, Int.max])
    func aMeterHasAtMostTheMaximumSegments(_ segments: Int) async throws {
        for value in [0.5, 0.999] {
            let drawn = try #require(await UIFnSnapshot.render { Self.meter(value, segments: segments) })
            let most = try #require(await UIFnSnapshot.render { Self.meter(value, segments: 100) })
            #expect(drawn.differingFraction(from: most, tolerance: 0) == 0, "\(value)")
        }
    }

    // MARK: - Empty state

    /// A single trailing closure fills the icon slot, as the first of two
    /// trailing closures does; actions alone are passed labeled.
    @Test
    @MainActor
    func anEmptyStatesSingleTrailingClosureIsItsIcon() async throws {
        let icon: UIFnEmptyState<Image, EmptyView> = UIFnEmptyState("No files") { Image(systemName: "tray") }
        let labeledIcon = UIFnEmptyState("No files", icon: { Image(systemName: "tray") })
        let actions: UIFnEmptyState<EmptyView, Button<Text>> = UIFnEmptyState("No files", actions: { Button("Add") {} })
        let titled = try #require(await UIFnSnapshot.render { UIFnEmptyState("No files").frame(width: 200) })
        let drawnIcon = try #require(await UIFnSnapshot.render { icon.frame(width: 200) })
        let drawnLabeledIcon = try #require(await UIFnSnapshot.render { labeledIcon.frame(width: 200) })
        let drawnActions = try #require(await UIFnSnapshot.render { actions.frame(width: 200) })
        #expect(drawnIcon.differingFraction(from: drawnLabeledIcon, tolerance: 0) == 0)
        #expect(drawnIcon.height > titled.height)
        #expect(drawnActions.height > titled.height)
    }

    // MARK: - Skeleton

    @MainActor
    private static func skeleton(reduceMotion: Bool, _ direction: LayoutDirection = .leftToRight) -> some View {
        UIFnSkeleton("Loading") { UIFnSkeletonSample() }
            .environment(\._accessibilityReduceMotion, reduceMotion)
            .environment(\.layoutDirection, direction)
    }

    /// Under Reduce Motion the skeleton draws its blocks without a highlight,
    /// the same whenever it renders.
    @Test
    func underReduceMotionASkeletonDoesNotAnimate() async throws {
        let still = try #require(await UIFnSnapshot.render { UIFnSkeletonAppearance(placeholder: UIFnSkeletonSample(), phase: nil) })
        let first = try #require(await UIFnSnapshot.render { Self.skeleton(reduceMotion: true) })
        try await Task.sleep(nanoseconds: 400_000_000)
        let later = try #require(await UIFnSnapshot.render { Self.skeleton(reduceMotion: true) })
        #expect(first.differingFraction(from: still, tolerance: 0) == 0)
        #expect(later.differingFraction(from: still, tolerance: 0) == 0)
    }

    /// Otherwise the highlight sweeps across the blocks: two renders a moment
    /// apart differ from each other and from the still blocks.
    @Test
    func withoutReduceMotionASkeletonsHighlightMoves() async throws {
        let still = try #require(await UIFnSnapshot.render { UIFnSkeletonAppearance(placeholder: UIFnSkeletonSample(), phase: nil) })
        let first = try #require(await UIFnSnapshot.render { Self.skeleton(reduceMotion: false) })
        try await Task.sleep(nanoseconds: 400_000_000)
        let later = try #require(await UIFnSnapshot.render { Self.skeleton(reduceMotion: false) })
        #expect(first.differingFraction(from: later, tolerance: 0) > 0)
        #expect(first.differingFraction(from: still, tolerance: 0) > 0 || later.differingFraction(from: still, tolerance: 0) > 0)
    }

    /// The highlight enters at the leading edge: a quarter of the way through
    /// its sweep it is on the left in a left-to-right layout and on the right
    /// in a right-to-left one.
    @Test
    func aSkeletonsHighlightSweepsFromTheLeadingEdge() async throws {
        @MainActor func block(_ phase: Double?, _ direction: LayoutDirection) -> some View {
            UIFnSkeletonAppearance(placeholder: UIFnSkeletonBlock().frame(width: 100, height: 10), phase: phase)
                .environment(\.layoutDirection, direction)
        }
        let still = try #require(await UIFnSnapshot.render { block(nil, .leftToRight) })
        let ltr = try #require(await UIFnSnapshot.render { block(0.25, .leftToRight) })
        let rtl = try #require(await UIFnSnapshot.render { block(0.25, .rightToLeft) })
        func highlighted(_ bitmap: UIFnBitmap, at fraction: Double) -> Bool {
            let x = Int(Double(bitmap.width) * fraction)
            let pixel = (bitmap.width * (bitmap.height / 2) + x) * 4
            return bitmap.pixels[pixel..<pixel + 3] != still.pixels[pixel..<pixel + 3]
        }
        #expect(highlighted(ltr, at: 0.15) && !highlighted(ltr, at: 0.85))
        #expect(highlighted(rtl, at: 0.85) && !highlighted(rtl, at: 0.15))
    }
}
