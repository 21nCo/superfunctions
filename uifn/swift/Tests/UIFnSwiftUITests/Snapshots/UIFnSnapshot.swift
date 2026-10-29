import CoreGraphics
import Foundation
import ImageIO
import SwiftUI
import Testing
import UniformTypeIdentifiers

/// An 8-bit sRGB RGBA image, the form snapshots are compared in.
struct UIFnBitmap: Equatable {
    let width: Int
    let height: Int
    let pixels: [UInt8]

    init?(_ image: CGImage) {
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { return nil }
        self.width = width
        self.height = height
        self.pixels = pixels
    }

    init?(png: Data) {
        guard let source = CGImageSourceCreateWithData(png as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { return nil }
        self.init(image)
    }

    var cgImage: CGImage? {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let provider = CGDataProvider(data: Data(pixels) as CFData)
        else { return nil }
        return CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: width * 4,
            space: space,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )
    }

    func png() -> Data? {
        guard let image = cgImage else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)
        else { return nil }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }

    /// The fraction of pixels in which any channel differs from `other` by
    /// more than `tolerance` (out of 255); 1 when the sizes differ.
    ///
    /// The default tolerance absorbs color conversion rounding between OS releases.
    func differingFraction(from other: UIFnBitmap, tolerance: UInt8 = 8) -> Double {
        guard width == other.width, height == other.height else { return 1 }
        let limit = Int(tolerance)
        let differing = pixels.withUnsafeBufferPointer { lhs in
            other.pixels.withUnsafeBufferPointer { rhs in
                var count = 0
                for pixel in stride(from: 0, to: lhs.count, by: 4) {
                    for channel in pixel..<pixel + 4 where abs(Int(lhs[channel]) - Int(rhs[channel])) > limit {
                        count += 1
                        break
                    }
                }
                return count
            }
        }
        return Double(differing) / Double(width * height)
    }
}

/// Renders SwiftUI views with `ImageRenderer` and compares them with the
/// reference PNGs in `__Snapshots__` next to the test file.
///
/// Set `UIFN_RECORD_SNAPSHOTS=1` to write the references instead of comparing
/// them. A missing reference is written and fails the test, so a new snapshot
/// is always reviewed. On a mismatch the rendered image is written to
/// `UIFN_SNAPSHOT_ARTIFACTS`, or a temporary directory, for inspection.
///
/// Only rendering runs on the main actor, one view at a time, so other
/// suites' main-actor work keeps running while snapshots render and compare.
enum UIFnSnapshot {
    private static let renders = UIFnRenderGate()

    /// The fraction of changed pixels a snapshot may have, for antialiasing
    /// differences between OS releases. Every state and variant change the
    /// styles draw changes several times more pixels than this.
    static let maximumDifferingFraction = 0.005
    static let scale: CGFloat = 2

    static var isRecording: Bool {
        ProcessInfo.processInfo.environment["UIFN_RECORD_SNAPSHOTS"] == "1"
    }

    /// Renders the view `content` builds at `scale` and its ideal size.
    static func render(
        colorScheme: ColorScheme = .light,
        dynamicTypeSize: DynamicTypeSize = .large,
        _ content: @escaping @MainActor () -> some View
    ) async -> UIFnBitmap? {
        await renders.enter()
        let image = await MainActor.run {
            let renderer = ImageRenderer(
                content: content()
                    .environment(\.colorScheme, colorScheme)
                    .environment(\.dynamicTypeSize, dynamicTypeSize)
            )
            renderer.scale = scale
            return renderer.cgImage
        }
        await renders.leave()
        return image.flatMap(UIFnBitmap.init)
    }

    static func assertMatches(
        _ bitmap: UIFnBitmap?,
        named name: String,
        filePath: String = #filePath,
        sourceLocation: SourceLocation = #_sourceLocation
    ) throws {
        let bitmap = try #require(bitmap, "\(name) did not render", sourceLocation: sourceLocation)
        let png = try #require(bitmap.png(), "\(name) did not encode", sourceLocation: sourceLocation)
        let reference = URL(fileURLWithPath: filePath)
            .deletingLastPathComponent()
            .appendingPathComponent("__Snapshots__", isDirectory: true)
            .appendingPathComponent("\(name).png")
        let fileManager = FileManager.default
        if isRecording || !fileManager.fileExists(atPath: reference.path) {
            try fileManager.createDirectory(at: reference.deletingLastPathComponent(), withIntermediateDirectories: true)
            try png.write(to: reference)
            if !isRecording {
                Issue.record("Recorded a new reference for \(name) at \(reference.path); review it and run again", sourceLocation: sourceLocation)
            }
            return
        }
        let expected = try #require(
            UIFnBitmap(png: try Data(contentsOf: reference)),
            "\(name)'s reference is not a PNG",
            sourceLocation: sourceLocation
        )
        let fraction = bitmap.differingFraction(from: expected)
        guard fraction > maximumDifferingFraction else { return }
        let failure = try writeFailure(png, named: name)
        Issue.record(
            """
            \(name) differs from its reference in \(String(format: "%.2f", fraction * 100))% of pixels \
            (\(bitmap.width)×\(bitmap.height) rendered, \(expected.width)×\(expected.height) expected); \
            rendered image: \(failure.path)
            """,
            sourceLocation: sourceLocation
        )
    }

    private static func writeFailure(_ png: Data, named name: String) throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        let directory = environment["UIFN_SNAPSHOT_ARTIFACTS"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("uifn-snapshots", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("\(name).png")
        try png.write(to: url)
        return url
    }
}

/// Admits one render at a time, in arrival order.
private actor UIFnRenderGate {
    private var isBusy = false
    private var waiting: [CheckedContinuation<Void, Never>] = []

    func enter() async {
        guard isBusy else {
            isBusy = true
            return
        }
        await withCheckedContinuation { waiting.append($0) }
    }

    func leave() {
        if waiting.isEmpty {
            isBusy = false
        } else {
            waiting.removeFirst().resume()
        }
    }
}
