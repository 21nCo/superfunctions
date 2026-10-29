import CoreText
import Foundation
import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// The regular (400) and bold (700) faces of a test family in `Fonts`.
///
/// Core Text registration is process-wide and tests run in parallel, so a
/// test that depends on which files are registered uses its own family; the
/// shared "UIFn Test Sans" is only registered, from this bundle.
private func testFaces(_ family: String) -> [UIFnFontFace] {
    let file = family.replacingOccurrences(of: " ", with: "")
    return [
        UIFnFontFace(weight: UIFnFontWeight(400), resource: "\(file)-Regular", fileExtension: "ttf", subdirectory: "Fonts"),
        UIFnFontFace(weight: UIFnFontWeight(700), resource: "\(file)-Bold", fileExtension: "ttf", subdirectory: "Fonts"),
    ]
}

private let family = "UIFn Test Sans"
private let faces = testFaces(family)

private func url(of face: UIFnFontFace) throws -> URL {
    try #require(Bundle.module.url(forResource: face.resource, withExtension: face.fileExtension, subdirectory: face.subdirectory))
}

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
        let family = "UIFn Test Repeat"
        let faces = testFaces(family)
        // The app registered the regular face itself (for example through UIAppFonts).
        #expect(CTFontManagerRegisterFontsForURL(try url(of: faces[0]) as CFURL, .process, nil))

        let log = LogRecorder()
        let coreTextCalls = LogRecorder()
        let countingRegistry = { UIFnFontRegistry(log: { log.record($0) }) { url in
            coreTextCalls.record(url.lastPathComponent)
            return try UIFnFontRegistry.registerWithCoreText(url)
        } }
        let registry = countingRegistry()
        try registry.register(family: family, faces: faces, from: .module)
        #expect(resolvedPostScriptName("UIFnTestRepeat-Regular") == "UIFnTestRepeat-Regular")
        #expect(resolvedPostScriptName("UIFnTestRepeat-Bold") == "UIFnTestRepeat-Bold")

        // Again, from another registry, and concurrently: every call succeeds
        // with the same faces, and Core Text is asked once per file.
        try registry.register(family: family, faces: faces, from: .module)
        let other = countingRegistry()
        try other.register(family: family, faces: faces, from: .module)
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<8 {
                group.addTask { try registry.register(family: family, faces: faces, from: .module) }
            }
            try await group.waitForAll()
        }
        #expect(coreTextCalls.messages.sorted() == ["UIFnTestRepeat-Bold.ttf", "UIFnTestRepeat-Regular.ttf"])
        for registry in [registry, other] {
            #expect(registry.postScriptName(family: family) == "UIFnTestRepeat-Regular")
            #expect(registry.postScriptName(family: family, weight: UIFnFontWeight(700)) == "UIFnTestRepeat-Bold")
        }
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
        try FileManager.default.copyItem(at: try url(of: faces[0]), to: directory.appendingPathComponent("Regular.ttf"))
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
        let family = "UIFn Test Rollback"
        let faces = testFaces(family)
        let bold = try url(of: faces[1])
        let registry = UIFnFontRegistry(log: { _ in }) { url in
            if url == bold { throw UIFnFontRegistrationError.registrationFailed(url, code: 305) }
            return try UIFnFontRegistry.registerWithCoreText(url)
        }
        #expect(throws: UIFnFontRegistrationError.registrationFailed(bold, code: 305)) {
            try registry.register(family: family, faces: faces, from: .module)
        }
        #expect(registry.postScriptName(family: family) == nil)
        #expect(resolvedPostScriptName("UIFnTestRollback-Regular") != "UIFnTestRollback-Regular")

        // Nothing recorded the rolled-back file, so a later call registers it anew.
        let later = UIFnFontRegistry(log: { _ in })
        try later.register(family: family, faces: faces, from: .module)
        #expect(later.postScriptName(family: family) == "UIFnTestRollback-Regular")
        #expect(resolvedPostScriptName("UIFnTestRollback-Regular") == "UIFnTestRollback-Regular")
        #expect(resolvedPostScriptName("UIFnTestRollback-Bold") == "UIFnTestRollback-Bold")
    }

    @Test
    func aFailedCallNeverUnregistersAFileAnotherRegistryCompletedWith() throws {
        let family = "UIFn Test Owner"
        let faces = testFaces(family)
        let bold = try url(of: faces[1])
        let other = UIFnFontRegistry(log: { _ in })
        let otherCall = DispatchGroup()
        let otherOutcome = LogRecorder()
        let failing = UIFnFontRegistry(log: { _ in }) { url in
            guard url == bold else { return try UIFnFontRegistry.registerWithCoreText(url) }
            // The regular file is registered and this call is about to fail:
            // another registry registers the regular face meanwhile.
            otherCall.enter()
            DispatchQueue.global().async {
                do {
                    try other.register(family: family, faces: [faces[0]], from: .module)
                    otherOutcome.record("registered")
                } catch {
                    otherOutcome.record("\(error)")
                }
                otherCall.leave()
            }
            if otherCall.wait(timeout: .now() + 0.5) == .success {
                otherOutcome.record("completed during the failing call")
            }
            throw UIFnFontRegistrationError.registrationFailed(url, code: 305)
        }
        #expect(throws: UIFnFontRegistrationError.registrationFailed(bold, code: 305)) {
            try failing.register(family: family, faces: faces, from: .module)
        }
        otherCall.wait()

        #expect(otherOutcome.messages == ["registered"])
        #expect(failing.postScriptName(family: family) == nil)
        #expect(other.postScriptName(family: family) == "UIFnTestOwner-Regular")
        #expect(resolvedPostScriptName("UIFnTestOwner-Regular") == "UIFnTestOwner-Regular")

        // Registering again stays consistent with Core Text.
        try other.register(family: family, faces: [faces[0]], from: .module)
        #expect(other.postScriptName(family: family) == "UIFnTestOwner-Regular")
        let later = UIFnFontRegistry(log: { _ in })
        try later.register(family: family, faces: faces, from: .module)
        #expect(later.postScriptName(family: family, weight: UIFnFontWeight(700)) == "UIFnTestOwner-Bold")
        #expect(resolvedPostScriptName("UIFnTestOwner-Regular") == "UIFnTestOwner-Regular")
        #expect(resolvedPostScriptName("UIFnTestOwner-Bold") == "UIFnTestOwner-Bold")
    }
}
