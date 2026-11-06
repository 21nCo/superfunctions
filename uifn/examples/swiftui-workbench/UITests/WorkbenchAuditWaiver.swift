import XCTest

/// Where an audit ran: the screen, its color scheme, and frames, in the
/// audit's coordinates, of the screen's page, the window and the macOS
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
    /// macOS, found by where they sit in the window (see ``WorkbenchApp/frameworkGroups(in:)``).
    var frameworkGroups: [CGRect] = []
    /// The Touch Bars AppKit shows for the app on macOS.
    var touchBars: [CGRect] = []

    /// Whether the frame lies within the screen's page, which holds the
    /// screen's own views.
    func isOnThePage(_ frame: CGRect) -> Bool {
        page.map { $0.insetBy(dx: -1, dy: -1).contains(frame) } ?? false
    }

    /// Whether the frame is one of the framework's groups around the app's views.
    func isAFrameworkGroup(_ frame: CGRect) -> Bool {
        !frame.isEmpty && frameworkGroups.contains { !$0.isEmpty && $0.isWithinAPoint(of: frame) }
    }

    /// Whether the frame lies in a Touch Bar, outside the app's window.
    func isInATouchBar(_ frame: CGRect) -> Bool {
        !frame.isEmpty && !window.insetBy(dx: 1, dy: 1).intersects(frame)
            && touchBars.contains { !$0.isEmpty && $0.insetBy(dx: -2, dy: -2).contains(frame) }
    }
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
    /// For a contrast issue, the contrast ratio between the lightest and the
    /// darkest pixels of the element's screenshot, or nil when not measured.
    var measuredContrast: Double?
}

extension WorkbenchAuditElement {
    init(_ element: XCUIElement, measuredContrast: Double?) {
        self.init(
            type: element.elementType,
            identifier: element.identifier,
            label: element.label,
            value: (element.value as? String) ?? "",
            frame: element.frame,
            isEnabled: element.isEnabled,
            measuredContrast: measuredContrast
        )
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

    static let all: [WorkbenchAuditWaiver] = [
        WorkbenchAuditWaiver(
            id: "disabled-contrast",
            screens: [],
            platform: nil,
            auditTypes: ["contrast"],
            element: { element, _ in element.map { !$0.isEnabled } ?? false },
            reason: "Disabled controls fade so they read as unavailable. WCAG 2.2 success criterion 1.4.3 exempts text in inactive controls."
        ),
        WorkbenchAuditWaiver(
            id: "unchecked-checkbox-contrast",
            screens: ["toggles"],
            platform: nil,
            auditTypes: ["contrast"],
            element: { element, _ in element.map { ["Send me news", "Archive"].contains($0.label) } ?? false },
            reason: "The audit compares the unchecked box's raised fill with the canvas (1.1:1); the checked rows with the same label color pass. The label is the primary text color on the canvas (17:1), and the box's strong border meets the 3:1 non-text minimum (4.0:1 light, 3.6:1 dark)."
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
                return element.type == .group && element.label.isEmpty && element.identifier.isEmpty
                    && context.isAFrameworkGroup(element.frame)
            },
            reason: "SwiftUI and AppKit make these unlabeled groups around the app's views: the hosting views of the window, its sidebar and detail columns and the list's section headers, and the group inside the window's full-screen button. They are not elements VoiceOver stops on. Each is matched by where it sits in the window; any other unlabeled group, on a page or in the list, is still audited."
        ),
        WorkbenchAuditWaiver(
            id: "macos-touch-bar",
            screens: [],
            platform: .macOS,
            auditTypes: ["sufficientElementDescription", "action"],
            element: { element, context in
                guard let element else { return false }
                return element.type == .touchBar || context.isInATouchBar(element.frame)
            },
            reason: "The CI Mac shows a Touch Bar, and AppKit fills it, adding items such as \"emoji & symbols\" while a text field has focus. They are not the app's views. Only the Touch Bar and elements inside its frame, outside the app's window, are waived."
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
            id: "macos-contrast-misread",
            screens: ["toggles", "empty-states", "toasts", "text-fields"],
            platform: .macOS,
            auditTypes: ["contrast"],
            element: { element, context in
                // Only when the text's own pixels show the contrast the audit
                // did not find.
                guard let element, (element.measuredContrast ?? 0) >= 4.5 else { return false }
                let text = element.value
                switch (context.screen, context.colorScheme) {
                case ("toggles", "light"): return text == "Alerts"
                case ("empty-states", "dark"): return text == "Files you add appear here."
                case ("toasts", "dark"): return element.label == "Link copied"
                // The window title, not the list's row of the same name.
                case ("text-fields", "dark"):
                    return text == "Text fields" && !context.isOnThePage(element.frame)
                        && !element.identifier.hasPrefix(WorkbenchApp.sidebarPrefix)
                default: return false
                }
            },
            reason: "The colors of these texts measure well above 4.5:1: \"Alerts\" 17.1:1 (text.primary on the light canvas), the empty state's message 11.3:1 (text.secondary on the dark canvas), the toast 8.2:1 or more (on the dark success tone), and the window title is AppKit's. Other texts in the same colors on the same screens pass. Each is waived only when the lightest and darkest pixels of its own screenshot, taken when the audit reports it, differ by 4.5:1 or more; the screenshot and that ratio are attached to the test's result."
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
