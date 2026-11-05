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
        (0.5, 1, 0), (1, 1, 1), (0.5, 2, 1), (0.01, 100, 1), (0.5, 0, 0), (1, 0, 1),
        // Counts above the maximum light as 100 segments.
        (0.5, 1_000, 50), (0.999, 1_000, 99), (1, 1_000, 100), (0.001, Int.max, 1),
        (0.5, Int.max, 50), (0.999, Int.max, 99), (1, Int.max, 100), (0.5, Int.min, 0),
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

    /// A meter of fewer than one segment draws one.
    @Test(arguments: [0, -3])
    func aMeterHasAtLeastOneSegment(_ segments: Int) async throws {
        for value in [0.5, 1] {
            let drawn = try #require(await UIFnSnapshot.render { Self.meter(value, segments: segments) })
            let one = try #require(await UIFnSnapshot.render { Self.meter(value, segments: 1) })
            #expect(drawn.differingFraction(from: one, tolerance: 0) == 0, "\(value)")
        }
    }

    /// A meter has from 1 to 100 segments, whatever count it is given.
    @Test(arguments: [
        (Int.min, 1), (-3, 1), (0, 1), (1, 1), (5, 5), (100, 100), (101, 100), (1_000, 100), (Int.max, 100),
    ])
    func aMetersSegmentCountIsFromOneToTheMaximum(_ segments: Int, _ count: Int) {
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
