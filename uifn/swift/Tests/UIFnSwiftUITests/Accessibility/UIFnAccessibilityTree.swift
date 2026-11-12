import Foundation
import SwiftUI
import Testing

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// What an assistive technology is told an element is, as each platform says it.
enum UIFnAccessibilityRole: CustomStringConvertible {
    case progressIndicator, busyIndicator, staticText, heading, button, popUpButton

    #if os(macOS)
    /// The element's accessibility role.
    var platformRole: String {
        switch self {
        case .progressIndicator: NSAccessibility.Role.progressIndicator.rawValue
        case .busyIndicator: NSAccessibility.Role.busyIndicator.rawValue
        case .staticText: NSAccessibility.Role.staticText.rawValue
        case .heading: "AXHeading"
        case .button: NSAccessibility.Role.button.rawValue
        case .popUpButton: NSAccessibility.Role.popUpButton.rawValue
        }
    }
    #else
    /// The element's accessibility traits. UIKit has no role, so a progress
    /// indicator and a busy indicator both update frequently, and only a
    /// progress indicator has a value.
    var platformRole: String {
        let traits: UIAccessibilityTraits = switch self {
        case .progressIndicator, .busyIndicator: .updatesFrequently
        case .staticText: .staticText
        case .heading: [.header, .staticText]
        case .button, .popUpButton: .button
        }
        return UIFnAccessibilityElement.describe(traits)
    }
    #endif

    var description: String { platformRole }
}

/// One element of a view's accessibility tree, as the platform's assistive
/// technologies read it.
struct UIFnAccessibilityElement: CustomStringConvertible {
    /// The macOS role, or a description of the UIKit traits.
    let platformRole: String
    /// The label: on macOS a text's content when it has no label, as
    /// VoiceOver reads it.
    let label: String?
    /// The value: on macOS its description, such as a percentage, where it has one.
    let value: String?
    /// Presses the element, as VoiceOver's activate does.
    let press: @MainActor () -> Bool
    /// On macOS, the text of the element that names it, such as a switch's
    /// label beside it, which VoiceOver reads when the element has no label.
    var titleElementText: String? = nil
    /// The element's frame in screen coordinates, in points.
    var frame: CGRect = .zero

    func `is`(_ role: UIFnAccessibilityRole) -> Bool { platformRole == role.platformRole }

    var description: String { "\(platformRole) label=\(label ?? "nil") value=\(value ?? "nil")" }

    #if !os(macOS)
    static func describe(_ traits: UIAccessibilityTraits) -> String {
        let names: [(UIAccessibilityTraits, String)] = [
            (.button, "button"), (.header, "header"), (.staticText, "staticText"), (.image, "image"),
            (.updatesFrequently, "updatesFrequently"), (.notEnabled, "notEnabled"), (.selected, "selected"),
        ]
        let known = names.filter { traits.contains($0.0) }.map(\.1)
        let rest = traits.subtracting(UIAccessibilityTraits(names.map(\.0)))
        return (known + (rest.isEmpty ? [] : ["0x\(String(rest.rawValue, radix: 16))"])).joined(separator: "+")
    }
    #endif
}

/// Hosts a view in a window and reads the accessibility elements SwiftUI
/// makes for it.
///
/// SwiftUI builds its accessibility tree only for assistive technologies, so
/// the host reads it as one: on macOS by turning on the app's enhanced user
/// interface, as VoiceOver does, and on iOS by turning on accessibility
/// automation, as UI tests do.
///
/// Each read turns it on, reads the elements and turns it off again in one
/// main-actor turn, so other tests never run with it.
@MainActor
final class UIFnAccessibilityHost<Content: View> {
    #if os(macOS)
    private let window: NSWindow
    private let host: NSHostingView<Content>
    #else
    private let window: UIWindow
    private let controller: UIHostingController<Content>
    #endif

    init(_ content: Content, width: CGFloat = 400, height: CGFloat = 300) {
        #if os(macOS)
        _ = NSApplication.shared
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: height),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        host = NSHostingView(rootView: content)
        window.contentView = host
        window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
        #else
        window = UIWindow(frame: CGRect(x: 0, y: 0, width: width, height: height))
        controller = UIHostingController(rootView: content)
        window.rootViewController = controller
        window.isHidden = false
        controller.view.layoutIfNeeded()
        #endif
    }

    func close() {
        #if os(macOS)
        window.close()
        #else
        window.isHidden = true
        #endif
    }

    /// The elements an assistive technology reads, in its reading order.
    func elements() -> [UIFnAccessibilityElement] {
        #if os(macOS)
        let app = NSApplication.shared
        let enhanced = NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface")
        app.accessibilitySetValue(true, forAttribute: enhanced)
        defer { app.accessibilitySetValue(false, forAttribute: enhanced) }
        host.layoutSubtreeIfNeeded()
        return (host.accessibilityChildren() ?? []).flatMap(Self.elements(of:))
        #else
        UIFnAccessibilityAutomation.set(true)
        defer { UIFnAccessibilityAutomation.set(false) }
        controller.view.layoutIfNeeded()
        return Self.elements(of: controller.view)
        #endif
    }

    /// The elements, read again on the main actor while the view updates, for
    /// up to `seconds`, until `complete` holds for them; the last read when
    /// it never does.
    ///
    /// A tree SwiftUI is still updating, as on a loaded machine, then does not
    /// fail a test on its first read; one that never holds what the test
    /// expects fails it with the last read. Each read still turns the tree on
    /// and off in one main-actor turn.
    func elements(
        upTo seconds: Double = 2,
        until complete: ([UIFnAccessibilityElement]) -> Bool
    ) async -> [UIFnAccessibilityElement] {
        var read = elements()
        let deadline = Date().addingTimeInterval(seconds)
        while !complete(read), Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
            read = elements()
        }
        return read
    }

    /// Waits on the main actor while the view updates, for up to `seconds`,
    /// until `condition` holds.
    func wait(upTo seconds: Double = 2, until condition: () -> Bool) async {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    #if os(macOS)
    /// SwiftUI's elements are Objective-C objects that answer the
    /// `NSAccessibility` methods without Swift seeing them conform, so they are
    /// asked through the Objective-C runtime.
    private static func elements(of node: Any) -> [UIFnAccessibilityElement] {
        let element = node as AnyObject
        let children = (element.accessibilityChildren?() ?? nil) ?? []
        let role = (element.accessibilityRole?() ?? nil)?.rawValue ?? ""
        if role == NSAccessibility.Role.group.rawValue, !children.isEmpty {
            return children.flatMap(elements(of:))
        }
        let label = element.accessibilityLabel?() ?? nil
        let value = (element.accessibilityValueDescription?() ?? nil) ?? object(element, "accessibilityValue").map { "\($0)" }
        let isText = role == NSAccessibility.Role.staticText.rawValue || role == "AXHeading"
        let titleElement = (element.accessibilityTitleUIElement?() ?? nil).map { $0 as AnyObject }
        return [UIFnAccessibilityElement(
            platformRole: role,
            label: label ?? (isText ? value : nil),
            value: label == nil && isText ? nil : value,
            press: { element.accessibilityPerformPress?() ?? false },
            titleElementText: titleElement.flatMap { object($0, "accessibilityValue") as? String },
            frame: element.accessibilityFrame?() ?? .zero
        )]
    }

    /// The object a method that takes no arguments returns, or nil when the
    /// element has no such method. `accessibilityValue` is asked this way
    /// because AppKit declares it with several return types.
    private static func object(_ element: AnyObject, _ method: String) -> Any? {
        let selector = NSSelectorFromString(method)
        guard let object = element as? NSObject, object.responds(to: selector) else { return nil }
        return object.perform(selector)?.takeUnretainedValue()
    }
    #else
    private static func elements(of node: NSObject) -> [UIFnAccessibilityElement] {
        if node.isAccessibilityElement {
            return [UIFnAccessibilityElement(
                platformRole: UIFnAccessibilityElement.describe(node.accessibilityTraits),
                label: node.accessibilityLabel,
                value: node.accessibilityValue,
                press: { node.accessibilityActivate() },
                frame: node.accessibilityFrame
            )]
        }
        if let children = node.accessibilityElements as? [NSObject] {
            return children.flatMap(elements(of:))
        }
        let count = node.accessibilityElementCount()
        if count > 0, count != NSNotFound {
            return (0..<count).compactMap { node.accessibilityElement(at: $0) as? NSObject }.flatMap(elements(of:))
        }
        return (node as? UIView)?.subviews.flatMap(elements(of:)) ?? []
    }
    #endif
}

#if !os(macOS)
/// Turns UIKit's accessibility automation, which UI tests use, on and off.
private enum UIFnAccessibilityAutomation {
    private typealias SetEnabled = @convention(c) (Int32) -> Void

    private static let setEnabled: SetEnabled? = {
        guard let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
              let symbol = dlsym(library, "_AXSSetAutomationEnabled")
        else { return nil }
        return unsafeBitCast(symbol, to: SetEnabled.self)
    }()

    static func set(_ enabled: Bool) {
        guard let setEnabled else {
            Issue.record("libAccessibility has no _AXSSetAutomationEnabled; the accessibility tree cannot be read")
            return
        }
        setEnabled(enabled ? 1 : 0)
    }
}
#endif
