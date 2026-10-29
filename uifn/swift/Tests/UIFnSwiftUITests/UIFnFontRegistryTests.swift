import CoreText
import Foundation
import SwiftUI
import Testing
@testable import UIFnSwiftUI

private let family = "UIFn Test Sans"
private let faces = [
    UIFnFontFace(weight: UIFnFontWeight(400), resource: "UIFnTestSans-Regular", fileExtension: "ttf", subdirectory: "Fonts"),
    UIFnFontFace(weight: UIFnFontWeight(700), resource: "UIFnTestSans-Bold", fileExtension: "ttf", subdirectory: "Fonts"),
]

/// Records strings from any thread.
private final class LogRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []

    var messages: [String] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func record(_ message: String) {
        lock.lock()
        recorded.append(message)
        lock.unlock()
    }
}

/// The PostScript name Core Text resolves for `name`; Core Text substitutes
/// another font when `name` is not registered.
private func resolvedPostScriptName(_ name: String) -> String {
    CTFontCopyPostScriptName(CTFontCreateWithName(name as CFString, 12, nil)) as String
}

struct UIFnFontRegistryTests {
    @Test
    func registeringAFamilyFromABundleIsIdempotent() async throws {
        let log = LogRecorder()
        let coreTextCalls = LogRecorder()
        let registry = UIFnFontRegistry(log: { log.record($0) }) { url in
            coreTextCalls.record(url.lastPathComponent)
            return try UIFnFontRegistry.registerWithCoreText(url)
        }
        try registry.register(family: family, faces: faces, from: .module)
        #expect(resolvedPostScriptName("UIFnTestSans-Regular") == "UIFnTestSans-Regular")
        #expect(resolvedPostScriptName("UIFnTestSans-Bold") == "UIFnTestSans-Bold")

        // Again, from another registry (as if the app registered the files
        // itself), and concurrently: every call succeeds with the same faces.
        try registry.register(family: family, faces: faces, from: .module)
        try UIFnFontRegistry(log: { log.record($0) }).register(family: family, faces: faces, from: .module)
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<8 {
                group.addTask { try registry.register(family: family, faces: faces, from: .module) }
            }
            try await group.waitForAll()
        }
        #expect(coreTextCalls.messages.sorted() == ["UIFnTestSans-Bold.ttf", "UIFnTestSans-Regular.ttf"])
        #expect(registry.postScriptName(family: family) == "UIFnTestSans-Regular")
        #expect(registry.postScriptName(family: family, weight: UIFnFontWeight(700)) == "UIFnTestSans-Bold")
        #expect(log.messages.isEmpty)
    }

    @Test
    func weightsResolveToTheNearestRegisteredFace() throws {
        let registry = UIFnFontRegistry(log: { _ in })
        try registry.register(family: family, faces: faces, from: .module)
        let weight = UIFnTheme.uifn.typography.weight
        #expect(registry.postScriptName(family: family, weight: weight.medium) == "UIFnTestSans-Regular")
        #expect(registry.postScriptName(family: family, weight: weight.semibold) == "UIFnTestSans-Bold")
        #expect(registry.postScriptName(family: family, weight: UIFnFontWeight(550)) == "UIFnTestSans-Regular")
        #expect(registry.postScriptName(family: family, weight: UIFnFontWeight(900)) == "UIFnTestSans-Bold")
    }

    @Test
    func typeSizesResolveToTheFamilyAndScaleWithDynamicType() throws {
        let registry = UIFnFontRegistry(log: { _ in })
        try registry.register(family: family, faces: faces, from: .module)
        let size = UIFnTheme.uifn.typography.size
        let bold = UIFnTheme.uifn.typography.weight.bold

        #expect(size.md.font(family: family, registry: registry) == .custom("UIFnTestSans-Regular", fixedSize: 14))
        #expect(size.xl.font(family: family, weight: bold, registry: registry) == .custom("UIFnTestSans-Bold", fixedSize: 18))
        for dynamicTypeSize in DynamicTypeSize.allCases {
            let points = size.md.scaledPoints(for: dynamicTypeSize)
            let font = size.md.font(family: family, dynamicTypeSize: dynamicTypeSize, registry: registry)
            #expect(font == .custom("UIFnTestSans-Regular", fixedSize: points), "\(dynamicTypeSize)")
        }
        #if os(iOS) || os(tvOS) || os(visionOS)
        #expect(size.md.scaledPoints(for: .accessibility3) > size.md.points * 1.5)
        #expect(size.md.scaledPoints(for: .xSmall) < size.md.points)
        #endif
    }

    @Test
    func aMissingFamilyFallsBackToTheSystemFontWithOneDebugLog() {
        let log = LogRecorder()
        let registry = UIFnFontRegistry(log: { log.record($0) })
        let size = UIFnTheme.uifn.typography.size
        let semibold = UIFnTheme.uifn.typography.weight.semibold

        #expect(size.md.font(family: "Unregistered Family", weight: semibold, registry: registry) == .system(size: 14, weight: .semibold))
        #expect(size.md.font(family: "Unregistered Family", registry: registry) == size.md.font())
        #expect(log.messages == ["Font family \"Unregistered Family\" is not registered; using the system font."])

        // No family is the system font, and not a miss.
        #expect(size.xl.font(family: nil, registry: registry) == .system(size: 18))
        #expect(log.messages.count == 1)
    }

    @Test
    func registrationRejectsBadInputAndLeavesTheFamilyUnchanged() throws {
        let registry = UIFnFontRegistry(log: { _ in })
        #expect(throws: UIFnFontRegistrationError.noFaces(family: "Empty")) {
            try registry.register(family: "Empty", faces: [], from: .module)
        }
        #expect(throws: UIFnFontRegistrationError.duplicateWeight(family: "Twice", weight: 400)) {
            try registry.register(family: "Twice", faces: [faces[0], faces[0]], from: .module)
        }
        let missing = UIFnFontFace(weight: UIFnFontWeight(700), resource: "Missing-Bold", fileExtension: "ttf", subdirectory: "Fonts")
        #expect(throws: UIFnFontRegistrationError.fileNotFound(resource: "Missing-Bold")) {
            try registry.register(family: "Partial", faces: [faces[0], missing], from: .module)
        }

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let regular = try #require(Bundle.module.url(forResource: "UIFnTestSans-Regular", withExtension: "ttf", subdirectory: "Fonts"))
        try FileManager.default.copyItem(at: regular, to: directory.appendingPathComponent("Regular.ttf"))
        try Data("not a font".utf8).write(to: directory.appendingPathComponent("NotAFont.ttf"))
        let bundle = try #require(Bundle(url: directory))
        let copied = UIFnFontFace(weight: UIFnFontWeight(400), resource: "Regular", fileExtension: "ttf")
        let invalid = UIFnFontFace(weight: UIFnFontWeight(700), resource: "NotAFont", fileExtension: "ttf")
        let invalidURL = try #require(bundle.url(forResource: "NotAFont", withExtension: "ttf"))
        #expect(throws: UIFnFontRegistrationError.invalidFontFile(invalidURL)) {
            try registry.register(family: "Partial", faces: [copied, invalid], from: bundle)
        }

        for name in ["Empty", "Twice", "Partial"] {
            #expect(registry.postScriptName(family: name) == nil)
        }
    }

    @Test
    func aFailedFaceUnregistersTheFilesItsCallRegistered() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        for face in faces {
            let source = try #require(Bundle.module.url(forResource: face.resource, withExtension: "ttf", subdirectory: "Fonts"))
            try FileManager.default.copyItem(at: source, to: directory.appendingPathComponent("\(face.resource).ttf"))
        }
        let bundle = try #require(Bundle(url: directory))
        let copies = faces.map { UIFnFontFace(weight: $0.weight, resource: $0.resource, fileExtension: "ttf") }
        let regular = try #require(bundle.url(forResource: copies[0].resource, withExtension: "ttf"))
        let bold = try #require(bundle.url(forResource: copies[1].resource, withExtension: "ttf"))

        let registry = UIFnFontRegistry(log: { _ in }) { url in
            if url == bold { throw UIFnFontRegistrationError.registrationFailed(url, code: 305) }
            return CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        #expect(throws: UIFnFontRegistrationError.registrationFailed(bold, code: 305)) {
            try registry.register(family: "Rolled Back", faces: copies, from: bundle)
        }
        #expect(registry.postScriptName(family: "Rolled Back") == nil)
        // The regular copy was unregistered, so Core Text registers it anew.
        #expect(CTFontManagerRegisterFontsForURL(regular as CFURL, .process, nil))
        CTFontManagerUnregisterFontsForURL(regular as CFURL, .process, nil)
    }
}
