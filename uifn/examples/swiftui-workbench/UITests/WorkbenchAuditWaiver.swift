import XCTest
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Where an audit ran: the screen, its color scheme, and frames, in the
/// audit's coordinates, of the screen's page and the window, with the macOS
/// elements AppKit and SwiftUI make around the app's views.
struct WorkbenchAuditContext {
    /// The screen's launch argument, or nil for the list of screens.
    let screen: String?
    /// "light" or "dark".
    let colorScheme: String
    /// The frame of the screen's scrolling page, or nil for the list of screens.
    let page: CGRect?
    let window: CGRect
    /// The unlabeled groups AppKit and SwiftUI put around the app's views on
    /// macOS, found by ``WorkbenchFrameworkElements/find(in:touchBars:)``.
    var frameworkGroups: [WorkbenchAuditElement] = []
    /// The Touch Bars AppKit shows for the app on macOS, and their items.
    var touchBarItems: [WorkbenchAuditElement] = []
    /// The texts AppKit draws as children of a window or its toolbar on
    /// macOS, such as the window's title.
    var windowTitles: [WorkbenchAuditElement] = []
}

extension CGRect {
    func isWithinAPoint(of other: CGRect) -> Bool {
        abs(minX - other.minX) <= 1 && abs(minY - other.minY) <= 1
            && abs(width - other.width) <= 1 && abs(height - other.height) <= 1
    }
}

/// What a waiver sees of an audit issue's element, read once when the audit
/// reports it.
struct WorkbenchAuditElement {
    var type: XCUIElement.ElementType
    var identifier = ""
    var label = ""
    var value = ""
    var frame: CGRect
    var isEnabled = true

    /// Whether the other element has this one's type, frame, label and
    /// identifier, all an element and a snapshot of it share.
    func isSame(as other: WorkbenchAuditElement) -> Bool {
        !frame.isEmpty && type == other.type && label == other.label && identifier == other.identifier
            && frame.isWithinAPoint(of: other.frame)
    }
}

extension WorkbenchAuditElement {
    init(_ element: XCUIElement) {
        self.init(
            type: element.elementType,
            identifier: element.identifier,
            label: element.label,
            value: (element.value as? String) ?? "",
            frame: element.frame,
            isEnabled: element.isEnabled
        )
    }
}

/// An element of the app's accessibility tree with its children.
struct WorkbenchAuditNode {
    var element: WorkbenchAuditElement
    var children: [WorkbenchAuditNode] = []
}

extension WorkbenchAuditNode {
    init(_ snapshot: XCUIElementSnapshot) {
        element = WorkbenchAuditElement(
            type: snapshot.elementType,
            identifier: snapshot.identifier,
            label: snapshot.label,
            value: (snapshot.value as? String) ?? "",
            frame: snapshot.frame,
            isEnabled: snapshot.isEnabled
        )
        children = snapshot.children.map(WorkbenchAuditNode.init)
    }
}

/// Finds the elements AppKit and SwiftUI make around the app's views on
/// macOS by where they sit in the app's tree.
enum WorkbenchFrameworkElements {
    /// The workbench's sidebar section headers.
    static let sectionHeaders: Set<String> = ["Styles", "Components"]

    /// The framework's unlabeled groups, the Touch Bars and their items, and
    /// the texts that are children of a window or its toolbar.
    /// The groups are those whose parent is a window or the split view, the
    /// group a sidebar row's cell holds around a section header's text, and
    /// those in the window's full-screen button. An element is left out when
    /// any other element of the app has its type and frame, so that an app
    /// element that coincides with one is still audited.
    static func find(in app: WorkbenchAuditNode, touchBars: [WorkbenchAuditNode]) -> (groups: [WorkbenchAuditElement], touchBarItems: [WorkbenchAuditElement], windowTitles: [WorkbenchAuditElement]) {
        var groups: [WorkbenchAuditElement] = []
        var touchBarItems: [WorkbenchAuditElement] = []
        var windowTitles: [WorkbenchAuditElement] = []
        var others: [WorkbenchAuditElement] = []
        func visit(_ node: WorkbenchAuditNode, ancestors: [WorkbenchAuditNode]) {
            if node.element.type == .touchBar || ancestors.contains(where: { $0.element.type == .touchBar }) {
                touchBarItems.append(node.element)
            } else if isAFrameworkGroup(node, ancestors: ancestors) {
                groups.append(node.element)
            } else if node.element.type == .staticText, let parent = ancestors.last, [.window, .toolbar].contains(parent.element.type) {
                windowTitles.append(node.element)
            } else {
                others.append(node.element)
            }
            node.children.forEach { visit($0, ancestors: ancestors + [node]) }
        }
        visit(app, ancestors: [])
        touchBars.forEach { visit($0, ancestors: [app]) }
        let isUnique = { (element: WorkbenchAuditElement) in
            !others.contains { $0.type == element.type && $0.frame.isWithinAPoint(of: element.frame) }
        }
        return (groups.filter(isUnique), touchBarItems.filter(isUnique), windowTitles.filter(isUnique))
    }

    private static func isAFrameworkGroup(_ node: WorkbenchAuditNode, ancestors: [WorkbenchAuditNode]) -> Bool {
        let element = node.element
        guard element.type == .group, element.label.isEmpty, element.identifier.isEmpty, let parent = ancestors.last else { return false }
        switch parent.element.type {
        case .window, .splitGroup:
            return true
        case .cell:
            return ancestors.dropLast().last?.element.type == .outlineRow
                && node.children.contains { $0.element.type == .staticText && sectionHeaders.contains($0.element.label) }
        default:
            return ancestors.contains { $0.element.type == .button && $0.element.identifier == "_XCUI:FullScreenWindow" }
        }
    }
}

/// An accessibility audit issue the workbench accepts, with the reason.
///
/// The README's waiver table lists the same waivers with the same reasons;
/// `testTheReadmeListsEveryWaiver` checks that it does.
struct WorkbenchAuditWaiver {
    enum Platform: String {
        case macOS
        case iOS

        static var current: Platform {
            #if os(macOS)
            .macOS
            #else
            .iOS
            #endif
        }
    }

    /// The waiver's name in the README table.
    let id: String
    /// The screens' launch arguments, or empty for every screen.
    let screens: Set<String>
    /// The platform, or nil for both.
    let platform: Platform?
    /// The audit types, by their names in ``XCUIAccessibilityAuditType/workbenchName``,
    /// since some types exist on one platform only.
    let auditTypes: Set<String>
    /// Whether the issue's element, or nil for an issue the audit reports on
    /// no element, is one the waiver covers where the audit ran.
    let element: (WorkbenchAuditElement?, WorkbenchAuditContext) -> Bool
    let reason: String

    /// The controls the screens disable, by screen and as the audit names
    /// them. `disabled-contrast` covers only these, and only an element the
    /// audit reports disabled; each audit first checks that each is on its
    /// screen and disabled.
    static let disabledControls: [(screen: String, title: String, names: [String])] = [
        ("buttons", "Buttons", ["Save", "Cancel", "More", "Delete"]),
        ("toggles", "Toggles", ["Sync (disabled)", "Accept terms (disabled)"]),
        ("text-fields", "Text fields", ["Workspace (disabled)"]),
        ("segmented-pickers", "Segmented pickers", ["Day", "Week", "Month"]),
    ]

    static let all: [WorkbenchAuditWaiver] = [
        WorkbenchAuditWaiver(
            id: "disabled-contrast",
            screens: Set(disabledControls.map(\.screen)),
            platform: nil,
            auditTypes: ["contrast"],
            element: { element, context in
                guard let element, !element.isEnabled else { return false }
                let names = disabledControls.first { $0.screen == context.screen }?.names ?? []
                return names.contains(element.label) || names.contains(element.value)
            },
            reason: "Disabled controls fade so they read as unavailable, and WCAG 2.2 success criterion 1.4.3 exempts text in inactive controls. Only the controls the screens disable are waived, each only when the audit reports it disabled, and each audit first checks that they are on its screen and disabled: "
                + disabledControls.map { "\($0.title) \($0.names.map { "“\($0)”" }.joined(separator: ", "))" }.joined(separator: "; ") + "."
        ),
        WorkbenchAuditWaiver(
            id: "text-field-hit-region",
            screens: ["text-fields"],
            platform: .iOS,
            auditTypes: ["hitRegion"],
            element: { element, _ in element?.type == .textField },
            reason: "The audit measures the system text field inside the style's padding. A tap anywhere in the padded field focuses it, so the touch target is the whole field."
        ),
        WorkbenchAuditWaiver(
            id: "text-field-text-clipped",
            screens: ["text-fields"],
            platform: .iOS,
            auditTypes: ["textClipped"],
            element: { element, _ in element?.type == .textField },
            reason: "Text fields are one line, like the system's, and grow taller with Dynamic Type. A value wider than the field scrolls while it is edited and truncates otherwise; the audit also flags values that fit at every size, such as \"Design\"."
        ),
        WorkbenchAuditWaiver(
            id: "segmented-picker-text-clipped",
            screens: ["segmented-pickers"],
            platform: .iOS,
            auditTypes: ["textClipped"],
            element: { element, _ in element.map { ["Day", "Week", "Month", "Overview", "Activity", "Settings"].contains($0.label) } ?? false },
            reason: "The segments share the picker's width, so they stop growing at the largest text size before the accessibility sizes and shrink a label that still does not fit; at the largest accessibility size every label shows in full. The audit predicts clipping from the segment's frame and does not see that the segments stop growing."
        ),
        WorkbenchAuditWaiver(
            id: "macos-window-groups",
            screens: [],
            platform: .macOS,
            auditTypes: ["sufficientElementDescription", "parentChild"],
            element: { element, context in
                guard let element else { return false }
                return context.frameworkGroups.contains { $0.isSame(as: element) }
            },
            reason: "SwiftUI and AppKit make these unlabeled groups around the app's views: the hosting views of the window, its sidebar and detail columns and the list's section headers, and the group inside the window's full-screen button. They are not elements VoiceOver stops on. Each is found by its place in the app's tree, and one whose frame an element of the app's own shares is still audited, as is any other unlabeled group."
        ),
        WorkbenchAuditWaiver(
            id: "macos-touch-bar",
            screens: [],
            platform: .macOS,
            auditTypes: ["sufficientElementDescription", "action"],
            element: { element, context in
                guard let element else { return false }
                return element.type == .touchBar || context.touchBarItems.contains { $0.isSame(as: element) }
            },
            reason: "The CI Mac shows a Touch Bar, and AppKit fills it, adding items such as \"emoji & symbols\" while a text field has focus. They are not the app's views. Only the Touch Bar and the elements in it are waived, and not one whose frame an element of the app's own shares."
        ),
        WorkbenchAuditWaiver(
            id: "macos-elementless-parent-child",
            screens: ["text-fields"],
            platform: .macOS,
            auditTypes: ["parentChild"],
            element: { element, _ in element == nil },
            reason: "With a text field focused, the audit reports a parent/child mismatch on no element, so there is no view of the app's to fix. The fields themselves are audited."
        ),
        WorkbenchAuditWaiver(
            id: "swiftui-gauge-role",
            screens: ["progress"],
            platform: .macOS,
            auditTypes: ["sufficientElementDescription"],
            element: { element, _ in element.map { ["Storage, 62 GB", "Battery, 80"].contains($0.label) } ?? false },
            reason: "SwiftUI gives a gauge with a custom style an element with no macOS role, whatever the style's body or accessibility representation, even a system gauge or progress view. The gauge reads its label, current value label and value, which UIFnSwiftUI's tests check."
        ),
        WorkbenchAuditWaiver(
            id: "swiftui-menu-action",
            screens: ["menus"],
            platform: .macOS,
            auditTypes: ["action"],
            element: { element, _ in element.map { $0.type == .menuButton && ["Options", "Share"].contains($0.label) } ?? false },
            reason: "The menu is SwiftUI's own, in the system button menu style; the UIFn style only draws its label. The audit finds no press action on the menu button SwiftUI makes. Opening it with VoiceOver and Full Keyboard Access is checked under UIF-29."
        ),
        WorkbenchAuditWaiver(
            id: "macos-window-title",
            screens: [],
            platform: .macOS,
            auditTypes: ["contrast"],
            element: { element, context in
                guard let element else { return false }
                return context.windowTitles.contains { $0.isSame(as: element) }
            },
            reason: "AppKit draws the window's title in its toolbar in its own colors (light text at 15.7:1 on the dark toolbar), so neither the app nor UIFn sets them. Only a text that is a child of the window or its toolbar is waived, and not one whose type and frame an element of the app's own shares."
        ),
        WorkbenchAuditWaiver(
            id: "contrast-misread",
            screens: [],
            platform: nil,
            auditTypes: ["contrast"],
            element: { element, context in
                guard let element else { return false }
                return WorkbenchContrastMisread.matching(element, in: context) != nil
            },
            reason: "Apple's contrast engine samples five rows of a text's screenshot and compares only its two most frequent exact colors, so it can fail text whose colors pass. Only the texts in the known contrast misreads table are waived, each on its platform and screens and in its color scheme: an offline run of the engine on the screenshot CI failed reproduces the reported ratio, and the text's theme tokens give at least 4.5:1. Any other contrast issue fails, as does the selected sidebar row."
        ),
    ]

    /// The first waiver that covers an issue of the audit type, by its name in
    /// ``XCUIAccessibilityAuditType/workbenchName``, on the element.
    static func matching(_ auditType: String, on element: WorkbenchAuditElement?, in context: WorkbenchAuditContext) -> WorkbenchAuditWaiver? {
        all.first { waiver in
            (waiver.screens.isEmpty || context.screen.map(waiver.screens.contains) == true)
                && (waiver.platform == nil || waiver.platform == .current)
                && waiver.auditTypes.contains(auditType)
                && waiver.element(element, context)
        }
    }
}

/// A text the macOS contrast audit fails although its theme colors pass, from
/// the fixed list that the README's known contrast misreads table mirrors.
/// An offline run of Apple's engine (``WorkbenchContrastEngine``) on the
/// screenshot the audit failed on CI reproduces the reported ratio, and the
/// theme tokens the text is drawn in give the token ratio, at least 4.5:1;
/// `WorkbenchAuditWaiverTests` checks both.
struct WorkbenchContrastMisread {
    let id: String
    let platform: WorkbenchAuditWaiver.Platform
    /// The screens, as the README names them.
    let screens: String
    /// "light" or "dark".
    let colorScheme: String
    /// The element, as the README names it.
    let element: String
    /// Whether an audited element on the screen, nil for the list of
    /// screens, is this text.
    let matches: (WorkbenchAuditElement, String?) -> Bool
    /// The ratio Apple's engine gives the screenshot.
    let reportedRatio: Double
    /// The screenshot the audit failed on CI, a PNG in the test bundle, and
    /// the text's size in points.
    let screenshot: String
    let fontSize: Double
    /// The tokens the text is drawn in, such as "text.primary", and the one
    /// it is drawn on.
    let foregrounds: [String]
    let background: String
    /// The lowest ratio of a foreground token to the background token.
    let tokenRatio: Double

    static let all: [WorkbenchContrastMisread] = [
        WorkbenchContrastMisread(
            id: "toasts-row", platform: .macOS, screens: "All but Toasts", colorScheme: "light", element: "The unselected sidebar row “Toasts”",
            matches: { element, screen in element.identifier == WorkbenchApp.sidebarPrefix + "toasts" && screen != "toasts" },
            reportedRatio: 4.35, screenshot: "contrast-toasts-row-light", fontSize: 13,
            foregrounds: ["text.primary"], background: "surface.sunken", tokenRatio: 15.19
        ),
        WorkbenchContrastMisread(
            id: "toggles-alerts", platform: .macOS, screens: "Toggles", colorScheme: "light", element: "The switch label “Alerts”",
            matches: { element, screen in screen == "toggles" && element.value == "Alerts" },
            reportedRatio: 1.01, screenshot: "contrast-alerts-light", fontSize: 14,
            foregrounds: ["text.primary"], background: "surface.canvas", tokenRatio: 17.09
        ),
        WorkbenchContrastMisread(
            id: "toast-link-copied", platform: .macOS, screens: "Toasts", colorScheme: "dark", element: "The toast “Link copied” with its message",
            matches: { element, screen in screen == "toasts" && element.label == "Link copied" && element.value == "The link is on the clipboard." },
            reportedRatio: 1.01, screenshot: "contrast-toast-dark", fontSize: 14,
            foregrounds: ["text.primary", "text.secondary"], background: "success.subtle", tokenRatio: 8.20
        ),
        // The engine compares the canvas with the unchecked box's raised fill.
        uncheckedCheckbox("send-me-news", "Send me news", colorScheme: "light", reportedRatio: 1.06, tokenRatio: 17.09),
        uncheckedCheckbox("send-me-news", "Send me news", colorScheme: "dark", reportedRatio: 1.09, tokenRatio: 17.01),
        uncheckedCheckbox("archive", "Archive", colorScheme: "light", reportedRatio: 1.06, tokenRatio: 17.09),
        uncheckedCheckbox("archive", "Archive", colorScheme: "dark", reportedRatio: 1.09, tokenRatio: 17.01),
    ]

    /// An unchecked checkbox on Toggles on iOS, with its label in the
    /// primary text color on the canvas.
    private static func uncheckedCheckbox(_ id: String, _ label: String, colorScheme: String, reportedRatio: Double, tokenRatio: Double) -> WorkbenchContrastMisread {
        WorkbenchContrastMisread(
            id: "\(id)-\(colorScheme)", platform: .iOS, screens: "Toggles", colorScheme: colorScheme, element: "The unchecked checkbox “\(label)”",
            matches: { element, screen in screen == "toggles" && element.label == label },
            reportedRatio: reportedRatio, screenshot: "contrast-\(id)-\(colorScheme)", fontSize: 17,
            foregrounds: ["text.primary"], background: "surface.canvas", tokenRatio: tokenRatio
        )
    }

    /// The row of the README's table: the id, then each column.
    var readmeRow: [String] {
        [
            "`\(id)`", platform.rawValue, screens, colorScheme, element, String(format: "%.2f:1", reportedRatio),
            "\(foregrounds.map { "`\($0)`" }.joined(separator: " and ")) on `\(background)`", String(format: "%.2f:1", tokenRatio),
        ]
    }

    /// The listed text an enabled static text is, on this platform where the
    /// audit ran, or nil.
    static func matching(_ element: WorkbenchAuditElement, in context: WorkbenchAuditContext) -> WorkbenchContrastMisread? {
        guard element.type == .staticText, element.isEnabled else { return nil }
        return all.first { $0.platform == .current && $0.colorScheme == context.colorScheme && $0.matches(element, context.screen) }
    }
}

/// The pixels of a screenshot, to compare two screenshots.
enum WorkbenchPixels {
    struct RGB: Hashable {
        var red, green, blue: UInt8

        /// WCAG 2.2 relative luminance.
        var luminance: Double {
            func linear(_ value: UInt8) -> Double {
                let s = Double(value) / 255
                return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
            }
            return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
        }

        func contrast(with other: RGB) -> Double {
            let (a, b) = (luminance, other.luminance)
            return (max(a, b) + 0.05) / (min(a, b) + 0.05)
        }
    }

    /// The image's pixels in sRGB, in rows, top row first.
    static func pixels(of image: CGImage) -> [RGB]? {
        let (width, height) = (image.width, image.height)
        guard width > 0, height > 0, let sRGB = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: sRGB, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ) else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        return drawn ? stride(from: 0, to: bytes.count, by: 4).map { RGB(red: bytes[$0], green: bytes[$0 + 1], blue: bytes[$0 + 2]) } : nil
    }
}
