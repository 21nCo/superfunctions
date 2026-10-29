import Foundation
import SwiftUI
import Testing

struct UIFnSnapshotTests {
    /// CI uploads the artifact directory when snapshots fail, so a mismatch
    /// must write its rendered image there, under the snapshot's own
    /// subdirectory, and record where it is.
    @Test
    func aMismatchWritesTheRenderedImageAndRecordsWhereItIs() async throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent("uifn-snapshot-\(UUID().uuidString)", isDirectory: true)
        defer { try? fileManager.removeItem(at: root) }
        let testFile = root.appendingPathComponent("Tests/SquareTests.swift").path
        let references = root.appendingPathComponent("Tests/__Snapshots__/macOS", isDirectory: true)
        let artifacts = root.appendingPathComponent("artifacts", isDirectory: true)
        let red = try #require(await UIFnSnapshot.render { Color.red.frame(width: 8, height: 8) })
        let blue = try #require(await UIFnSnapshot.render { Color.blue.frame(width: 8, height: 8) })
        try fileManager.createDirectory(at: references, withIntermediateDirectories: true)
        try #require(blue.png()).write(to: references.appendingPathComponent("square.png"))

        let artifact = artifacts.appendingPathComponent("macOS/square.png")
        try withKnownIssue {
            try UIFnSnapshot.assertMatches(
                red,
                named: "macOS/square",
                filePath: testFile,
                isRecording: false,
                artifactDirectory: artifacts
            )
        } matching: { issue in
            issue.comments.contains { $0.rawValue.contains("macOS/square differs") && $0.rawValue.contains(artifact.path) }
        }
        #expect(UIFnBitmap(png: try Data(contentsOf: artifact)) == red)
    }
}
