import AppKit
import ApplicationServices

/// Records the colors the empty state's message exposes to accessibility in
/// dark, and what Apple's contrast engine makes of them, for the workflow's
/// AX color step. "Try a different search.", drawn in the same tokens,
/// passes the audit and is recorded beside it.
///
/// Usage: RecordAXColors <SwiftUIWorkbench.app> <CI screenshot of the message>
/// Exits 1 if it cannot read the colors.
@main
enum RecordAXColors {
    static let texts = ["Files you add appear here.", "Try a different search."]
    static let app = Process()

    static func main() throws {
        let arguments = CommandLine.arguments
        guard arguments.count == 3 else { fail("usage: RecordAXColors <app> <png>") }
        guard AXIsProcessTrusted() else { fail("This process is not trusted for accessibility, so it cannot read the colors.") }
        let screenshot = try Data(contentsOf: URL(fileURLWithPath: arguments[2]))
        app.standardOutput = FileHandle.nullDevice
        app.standardError = FileHandle.nullDevice
        app.executableURL = URL(fileURLWithPath: arguments[1]).appendingPathComponent("Contents/MacOS/SwiftUIWorkbench")
        app.arguments = ["-UIFnWorkbenchColorScheme", "dark", "-UIFnWorkbenchScreen", "empty-states", "-ApplePersistenceIgnoreState", "YES"]
        try app.run()
        defer { app.terminate() }
        let root = AXUIElementCreateApplication(app.processIdentifier)
        // As an assistive app does, so the app builds its whole tree;
        // without it a window can list the application as its child.
        AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        AXUIElementSetMessagingTimeout(root, 2)
        var found: [String: AXUIElement] = [:]
        let deadline = Date().addingTimeInterval(30)
        while found.count < texts.count, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
            AXUIElementSetAttributeValue(root, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            found = elements(in: root)
        }
        guard found.count == texts.count else {
            let children = (attribute(root, "AXChildren") as? [AXUIElement] ?? []).map { attribute($0, "AXRole") as? String ?? "?" }
            fail("Found only \(found.keys.sorted()) in the app's accessibility tree; the application's children are \(children).")
        }
        for text in texts {
            guard let element = found[text] else { continue }
            let colors = exposedColors(of: element, length: text.utf16.count)
            print("\"\(text)\" (dark) exposes:")
            for key in ["AXForegroundColor", "AXBackgroundColor"] {
                print("  \(key): \(colors[key].map(describe) ?? "none")")
            }
            // The engine takes hex colors. The components are read both as
            // given and converted from their color space to sRGB. The
            // screenshot is the message's, so only the message is judged.
            for (reading, hex) in [("as given", rawHex), ("in sRGB", sRGBHex)] where text == texts[0] {
                let foreground = colors["AXForegroundColor"].flatMap(hex), background = colors["AXBackgroundColor"].flatMap(hex)
                guard foreground != nil || background != nil else { continue }
                let result = WorkbenchContrastEngine.contrast(png: screenshot, fontSize: 14, foreground: foreground, background: background)
                let verdict = result.map { $0.ratio < 4.5 ? "reproduces a failing ratio" : "does not reproduce a failure" } ?? "engine did not run"
                print("  Apple's engine, colors \(reading) (foreground \(foreground ?? "none"), background \(background ?? "none")) on the CI screenshot: \(result.map { String(format: "%.2f:1", $0.ratio) } ?? "-"), \(verdict); \(result?.summary ?? "")")
            }
        }
    }

    /// The static texts named in `texts`, by value, in the tree under the
    /// application, which a child that is an application again would loop.
    static func elements(in element: AXUIElement, depth: Int = 0) -> [String: AXUIElement] {
        var found: [String: AXUIElement] = [:]
        let role = attribute(element, "AXRole") as? String
        guard depth < 40, depth == 0 || role != "AXApplication" else { return found }
        if role == "AXStaticText", let value = attribute(element, "AXValue") as? String, texts.contains(value) {
            found[value] = element
        }
        for child in attribute(element, "AXChildren") as? [AXUIElement] ?? [] {
            found.merge(elements(in: child, depth: depth + 1)) { first, _ in first }
        }
        return found
    }

    /// The colors of the text's attributed string, by attribute name.
    static func exposedColors(of element: AXUIElement, length: Int) -> [String: CGColor] {
        var range = CFRange(location: 0, length: length), value: AnyObject?
        guard let parameter = AXValueCreate(.cfRange, &range),
              AXUIElementCopyParameterizedAttributeValue(element, "AXAttributedStringForRange" as CFString, parameter, &value) == .success,
              let string = value as? NSAttributedString else { return [:] }
        var colors: [String: CGColor] = [:]
        string.enumerateAttributes(in: NSRange(location: 0, length: string.length)) { attributes, _, _ in
            for (key, value) in attributes where CFGetTypeID(value as CFTypeRef) == CGColor.typeID {
                colors[key.rawValue] = colors[key.rawValue] ?? (value as! CGColor)
            }
        }
        return colors
    }

    static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    static func hex(_ components: [CGFloat]) -> String {
        String(format: "#%02X%02X%02X", Int((components[0] * 255).rounded()), Int((components[1] * 255).rounded()), Int((components[2] * 255).rounded()))
    }

    static func rawHex(_ color: CGColor) -> String? {
        color.numberOfComponents >= 3 ? color.components.map { hex(Array($0.prefix(3))) } : nil
    }

    static func sRGBHex(_ color: CGColor) -> String? {
        guard let sRGB = CGColorSpace(name: CGColorSpace.sRGB), let converted = color.converted(to: sRGB, intent: .defaultIntent, options: nil) else { return nil }
        return rawHex(converted)
    }

    static func describe(_ color: CGColor) -> String {
        "\(color.colorSpace?.name.map { $0 as String } ?? "no color space") \(color.components ?? []), \(rawHex(color) ?? "-") as given, \(sRGBHex(color) ?? "-") in sRGB"
    }

    static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("RecordAXColors: \(message)\n".utf8))
        if app.isRunning { app.terminate() }
        exit(1)
    }
}
