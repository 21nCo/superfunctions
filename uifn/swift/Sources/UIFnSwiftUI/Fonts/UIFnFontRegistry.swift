import CoreText
import Foundation
import os
import SwiftUI

/// One weight of a font family: a font file in a consumer's bundle.
///
/// Each file must contain exactly one face (a `.ttf` or `.otf`, not a collection).
public struct UIFnFontFace: Equatable, Sendable {
    public let weight: UIFnFontWeight
    public let resource: String
    public let fileExtension: String?
    public let subdirectory: String?

    public init(weight: UIFnFontWeight, resource: String, fileExtension: String? = nil, subdirectory: String? = nil) {
        self.weight = weight
        self.resource = resource
        self.fileExtension = fileExtension
        self.subdirectory = subdirectory
    }
}

public enum UIFnFontRegistrationError: Error, Equatable {
    case noFaces(family: String)
    case duplicateWeight(family: String, weight: Double)
    case fileNotFound(resource: String)
    /// The file is not a font, or holds more than one face.
    case invalidFontFile(URL)
    /// Core Text rejected the file; `code` is the `CTFontManagerError` code.
    case registrationFailed(URL, code: Int)
}

/// Registers font files from a consumer's bundle by family and weight, and
/// resolves a family and weight to a registered face.
///
/// Fonts default to the system font; uifn bundles no font files. To use your
/// own family, register its files from your bundle once at launch, then set
/// the family on a view:
///
/// ```swift
/// try UIFnFontRegistry.shared.register(family: "Brand Sans", faces: [
///     UIFnFontFace(weight: UIFnFontWeight(400), resource: "BrandSans-Regular", fileExtension: "otf"),
///     UIFnFontFace(weight: UIFnFontWeight(700), resource: "BrandSans-Bold", fileExtension: "otf"),
/// ], from: .main)
///
/// ContentView().uifnFontFamily("Brand Sans")
/// ```
///
/// ``SwiftUI/View/uifnFont(_:weight:)`` then uses the face nearest the
/// requested weight, scaled exactly like the system font. An unregistered
/// family falls back to the system font and logs once at debug level.
///
/// Fonts are registered with Core Text for the current process. Registering
/// a file again, from any registry, or one the app already registered (for
/// example through `UIAppFonts`), succeeds without registering it twice.
public final class UIFnFontRegistry: @unchecked Sendable {
    public static let shared = UIFnFontRegistry()

    private let lock = NSLock()
    private let log: @Sendable (String) -> Void
    private let registerFont: @Sendable (URL) throws -> Bool
    /// Family name -> weight value -> PostScript name.
    private var families: [String: [Double: String]] = [:]
    private var loggedMissingFamilies: Set<String> = []

    public convenience init() {
        let logger = Logger(subsystem: UIFnSwiftUI.productName, category: "fonts")
        self.init { message in logger.debug("\(message, privacy: .public)") }
    }

    init(
        log: @escaping @Sendable (String) -> Void,
        registerFont: @escaping @Sendable (URL) throws -> Bool = { try UIFnFontRegistry.registerWithCoreText($0) }
    ) {
        self.log = log
        self.registerFont = registerFont
    }

    /// Registers each face's file from `bundle` under `family`.
    ///
    /// Registering a family again adds its faces; a face for a weight the
    /// family already has replaces it. If any face fails, the files this call
    /// registered are unregistered and the family is unchanged. A file a
    /// completed registration in any registry relies on is never unregistered.
    public func register(family: String, faces: [UIFnFontFace], from bundle: Bundle) throws {
        guard !faces.isEmpty else { throw UIFnFontRegistrationError.noFaces(family: family) }
        var weights = Set<Double>()
        for face in faces where !weights.insert(face.weight.value).inserted {
            throw UIFnFontRegistrationError.duplicateWeight(family: family, weight: face.weight.value)
        }

        let resolved = try faces.map { face in
            guard let url = bundle.url(
                forResource: face.resource,
                withExtension: face.fileExtension,
                subdirectory: face.subdirectory
            ) else {
                throw UIFnFontRegistrationError.fileNotFound(resource: face.resource)
            }
            return (weight: face.weight.value, url: url, postScriptName: try postScriptName(of: url))
        }

        let files = UIFnRegisteredFontFiles.process
        files.lock.lock()
        defer { files.lock.unlock() }
        var attempted: Set<URL> = []
        var registeredNow: [URL] = []
        do {
            for face in resolved where !files.urls.contains(face.url) && attempted.insert(face.url).inserted {
                if try registerFont(face.url) {
                    registeredNow.append(face.url)
                }
            }
        } catch {
            // No completed registration recorded these files: they were not
            // registered when this call began, and it holds the process lock.
            for url in registeredNow {
                CTFontManagerUnregisterFontsForURL(url as CFURL, .process, nil)
            }
            throw error
        }
        files.urls.formUnion(attempted)
        lock.lock()
        for face in resolved {
            families[family, default: [:]][face.weight] = face.postScriptName
        }
        lock.unlock()
    }

    /// The PostScript name of `family`'s face nearest to `weight` (regular,
    /// 400, when nil), or nil when the family is not registered. A weight
    /// halfway between two faces takes the lighter one.
    public func postScriptName(family: String, weight: UIFnFontWeight? = nil) -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard let faces = families[family] else { return nil }
        let target = weight?.value ?? 400
        return faces.min { lhs, rhs in
            let (left, right) = (abs(lhs.key - target), abs(rhs.key - target))
            return left == right ? lhs.key < rhs.key : left < right
        }?.value
    }

    /// The face for `family` and `weight`, or nil after logging once that the
    /// family is not registered.
    func resolve(family: String, weight: UIFnFontWeight?) -> String? {
        if let name = postScriptName(family: family, weight: weight) { return name }
        lock.lock()
        let firstMiss = loggedMissingFamilies.insert(family).inserted
        lock.unlock()
        if firstMiss {
            log("Font family \"\(family)\" is not registered; using the system font.")
        }
        return nil
    }

    private func postScriptName(of url: URL) throws -> String {
        guard
            let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
            descriptors.count == 1,
            let name = CTFontDescriptorCopyAttribute(descriptors[0], kCTFontNameAttribute) as? String
        else {
            throw UIFnFontRegistrationError.invalidFontFile(url)
        }
        return name
    }

    /// Returns whether this call registered the file; false when it was
    /// already registered outside this registry.
    static func registerWithCoreText(_ url: URL) throws -> Bool {
        var error: Unmanaged<CFError>?
        if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) { return true }
        let code = error.map { CFErrorGetCode($0.takeRetainedValue()) } ?? 0
        if code == CTFontManagerError.alreadyRegistered.rawValue { return false }
        throw UIFnFontRegistrationError.registrationFailed(url, code: code)
    }
}

/// The font files uifn's registries have registered, or found registered,
/// for this process. Core Text registration is process-wide, so one lock
/// serializes every registry's registration and rollback.
private final class UIFnRegisteredFontFiles: @unchecked Sendable {
    static let process = UIFnRegisteredFontFiles()

    let lock = NSLock()
    var urls: Set<URL> = []
}

public extension UIFnTypeSize {
    /// The registered `family`'s face nearest to `weight`, at `points` scaled
    /// for `dynamicTypeSize` relative to the size's text style, exactly as the
    /// system font scales. Without a family, or when the family is not
    /// registered, this is the system font (an unregistered family is logged
    /// at debug level once).
    ///
    /// The result has a fixed size for the `dynamicTypeSize` you pass (by
    /// default `.large`, the theme's points) and does not follow a view's
    /// Dynamic Type size. In views, use ``SwiftUI/View/uifnFont(_:weight:)``,
    /// which reads the environment's family and Dynamic Type size. This does
    /// not use `Font.custom(_:size:relativeTo:)`: that scales with the
    /// `UIFontMetrics` curve, which can render a larger type size smaller, and
    /// custom and system fonts must scale alike to keep the type scale in
    /// order.
    func font(
        family: String?,
        weight: UIFnFontWeight? = nil,
        dynamicTypeSize: DynamicTypeSize = .large,
        registry: UIFnFontRegistry = .shared
    ) -> Font {
        guard let family, let name = registry.resolve(family: family, weight: weight) else {
            return font(weight: weight, dynamicTypeSize: dynamicTypeSize)
        }
        return .custom(name, fixedSize: scaledPoints(for: dynamicTypeSize))
    }
}

private struct UIFnFontFamilyKey: EnvironmentKey {
    static let defaultValue: String? = nil
}

public extension EnvironmentValues {
    /// The registered font family ``SwiftUI/View/uifnFont(_:weight:)`` uses;
    /// nil uses the system font.
    var uifnFontFamily: String? {
        get { self[UIFnFontFamilyKey.self] }
        set { self[UIFnFontFamilyKey.self] = newValue }
    }
}

public extension View {
    /// Sets the font family theme type sizes use in this view, from fonts
    /// registered with ``UIFnFontRegistry/shared``.
    func uifnFontFamily(_ family: String?) -> some View {
        environment(\.uifnFontFamily, family)
    }
}
