import XCTest

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
    /// The audit type, by its name in ``XCUIAccessibilityAuditType/workbenchName``,
    /// since some types exist on one platform only.
    let auditType: String
    /// Whether the issue's element is one the waiver covers.
    let element: (XCUIElement) -> Bool
    let reason: String

    static let all: [WorkbenchAuditWaiver] = [
        WorkbenchAuditWaiver(
            id: "disabled-contrast",
            screens: [],
            platform: nil,
            auditType: "contrast",
            element: { !$0.isEnabled },
            reason: "Disabled controls fade so they read as unavailable. WCAG 2.2 success criterion 1.4.3 exempts text in inactive controls."
        ),
        WorkbenchAuditWaiver(
            id: "unchecked-checkbox-contrast",
            screens: ["toggles"],
            platform: nil,
            auditType: "contrast",
            element: { ["Send me news", "Archive"].contains($0.label) },
            reason: "The audit compares the unchecked box's raised fill with the canvas (1.1:1); the checked rows with the same label color pass. The label is the primary text color on the canvas (17:1), and the box's strong border meets the 3:1 non-text minimum (4.0:1 light, 3.6:1 dark)."
        ),
        WorkbenchAuditWaiver(
            id: "text-field-hit-region",
            screens: ["text-fields"],
            platform: .iOS,
            auditType: "hitRegion",
            element: { $0.elementType == .textField },
            reason: "The audit measures the system text field inside the style's padding. A tap anywhere in the padded field focuses it, so the touch target is the whole field."
        ),
        WorkbenchAuditWaiver(
            id: "text-field-text-clipped",
            screens: ["text-fields"],
            platform: .iOS,
            auditType: "textClipped",
            element: { $0.elementType == .textField },
            reason: "Text fields are one line, like the system's, and grow taller with Dynamic Type. A value wider than the field scrolls while it is edited and truncates otherwise; the audit also flags values that fit at every size, such as \"Design\"."
        ),
        WorkbenchAuditWaiver(
            id: "segmented-picker-text-clipped",
            screens: ["segmented-pickers"],
            platform: .iOS,
            auditType: "textClipped",
            element: { ["Day", "Week", "Month", "Overview", "Activity", "Settings"].contains($0.label) },
            reason: "The segments share the picker's width, so they stop growing at the largest text size before the accessibility sizes and shrink a label that still does not fit; at the largest accessibility size every label shows in full. The audit predicts clipping from the segment's frame and does not see that the segments stop growing."
        ),
    ]

    static func matching(_ issue: XCUIAccessibilityAuditIssue, screen: String?) -> WorkbenchAuditWaiver? {
        all.first { waiver in
            (waiver.screens.isEmpty || screen.map(waiver.screens.contains) == true)
                && (waiver.platform == nil || waiver.platform == .current)
                && issue.auditType.workbenchName == waiver.auditType
                && issue.element.map(waiver.element) == true
        }
    }
}
