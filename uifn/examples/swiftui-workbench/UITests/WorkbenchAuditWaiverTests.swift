import UIFnSwiftUI
import XCTest

/// The waivers cover only the elements their reasons name: an app element
/// that merely shares a weak property with them, such as no label or a frame
/// outside the window, is still audited. These tests run no app.
final class WorkbenchAuditWaiverTests: XCTestCase {
    /// Each listed text's theme tokens give its token ratio, at least 4.5:1,
    /// in the sRGB values the app draws on an sRGB display such as CI's.
    func testEachKnownContrastMisreadsTokensReach4_5To1() throws {
        func token(_ name: String) throws -> UIFnColorToken {
            let colors = UIFnTheme.uifn.colors
            switch name {
            case "text.primary": return colors.text.primary
            case "text.secondary": return colors.text.secondary
            case "surface.canvas": return colors.surface.canvas
            case "surface.sunken": return colors.surface.sunken
            case "success.subtle": return colors.success.subtle
            default: throw NSError(domain: "WorkbenchAuditWaiverTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "No token named \(name) in this test's table"])
            }
        }
        func luminance(_ color: UIFnRGB) -> Double {
            func linear(_ s: Double) -> Double { s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4) }
            return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
        }
        for misread in WorkbenchContrastMisread.all {
            let dark = misread.colorScheme == "dark"
            let background = luminance(try token(misread.background).value(dark: dark, highContrast: false).sRGB)
            let ratios = try misread.foregrounds.map { name in
                let foreground = luminance(try token(name).value(dark: dark, highContrast: false).sRGB)
                return (max(foreground, background) + 0.05) / (min(foreground, background) + 0.05)
            }
            let lowest = try XCTUnwrap(ratios.min(), misread.id)
            XCTAssertEqual(String(format: "%.2f", lowest), String(format: "%.2f", misread.tokenRatio), misread.id)
            XCTAssertGreaterThanOrEqual(lowest, 4.5, misread.id)
        }
    }

    private func waiver(_ auditType: String, _ element: WorkbenchAuditElement?, _ context: WorkbenchAuditContext) -> String? {
        WorkbenchAuditWaiver.matching(auditType, on: element, in: context)?.id
    }

    /// `disabled-contrast` covers only the controls a screen disables, and
    /// only while the audit reports them disabled.
    func testTheDisabledWaiverCoversOnlyTheControlsTheScreensDisable() {
        let context = { (screen: String) in
            WorkbenchAuditContext(screen: screen, colorScheme: "light", page: CGRect(x: 0, y: 100, width: 400, height: 600), window: CGRect(x: 0, y: 0, width: 400, height: 800))
        }
        for (screen, _, names) in WorkbenchAuditWaiver.disabledControls {
            for name in names {
                let disabled = [
                    WorkbenchAuditElement(type: .button, label: name, frame: CGRect(x: 24, y: 452, width: 57, height: 33), isEnabled: false),
                    WorkbenchAuditElement(type: .staticText, value: name, frame: CGRect(x: 24, y: 452, width: 57, height: 16), isEnabled: false),
                ]
                for element in disabled {
                    XCTAssertEqual(waiver("contrast", element, context(screen)), "disabled-contrast", "\(name) on \(screen)")
                    var enabled = element
                    enabled.isEnabled = true
                    XCTAssertNotEqual(waiver("contrast", enabled, context(screen)), "disabled-contrast", "\(name) on \(screen), enabled")
                    // Another screen that does not disable it.
                    XCTAssertNil(waiver("contrast", element, context("banners")), "\(name) on banners")
                }
            }
        }
        // A disabled control no screen disables.
        XCTAssertNil(waiver("contrast", WorkbenchAuditElement(type: .button, label: "Show toast", frame: CGRect(x: 24, y: 100, width: 90, height: 24), isEnabled: false), context("buttons")))
    }

    /// The unchecked checkboxes are listed misreads on iOS only, where the
    /// audit failed them, and only as the unchecked "Send me news" and "Archive".
    func testTheUncheckedCheckboxesAreListedOnIOSOnly() {
        for colorScheme in ["light", "dark"] {
            let context = WorkbenchAuditContext(screen: "toggles", colorScheme: colorScheme, page: CGRect(x: 0, y: 100, width: 400, height: 600), window: CGRect(x: 0, y: 0, width: 400, height: 800))
            for label in ["Send me news", "Archive", "Remember me", "Inbox"] {
                let element = WorkbenchAuditElement(type: .staticText, label: label, frame: CGRect(x: 24, y: 454, width: 111, height: 20))
                let listed = WorkbenchAuditWaiver.Platform.current == .iOS && ["Send me news", "Archive"].contains(label)
                XCTAssertEqual(waiver("contrast", element, context), listed ? "contrast-misread" : nil, "\(label) in \(colorScheme)")
            }
        }
    }

    #if os(macOS)
    /// Apple's engine, run offline on the screenshot the audit failed on CI,
    /// reproduces each listed ratio, and fails the selected row's screenshot
    /// at its true ratio.
    func testAppleEngineReproducesEachKnownContrastMisread() throws {
        func ratio(_ name: String, fontSize: Double) throws -> Double {
            let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "png"), "The test bundle has no \(name).png")
            let result = try XCTUnwrap(WorkbenchContrastEngine.contrast(png: Data(contentsOf: url), fontSize: fontSize), "Apple's contrast engine did not run on \(name)")
            return result.ratio
        }
        for misread in WorkbenchContrastMisread.all {
            let reported = try ratio(misread.screenshot, fontSize: misread.fontSize)
            XCTAssertEqual(String(format: "%.2f", reported), String(format: "%.2f", misread.reportedRatio), misread.id)
            XCTAssertLessThan(reported, 4.5, misread.id)
        }
        // The selected row's text.primary on the accent selection: 3.36:1.
        XCTAssertEqual(String(format: "%.2f", try ratio("contrast-selected-row-light", fontSize: 13)), "3.36")
    }

    private let window = CGRect(x: 32, y: 31, width: 960, height: 674)
    private let sidebar = CGRect(x: 40, y: 39, width: 240, height: 658)
    private let header = CGRect(x: 54, y: 83, width: 224, height: 19)
    private let fullScreenButton = CGRect(x: 97, y: 50, width: 14, height: 14)
    private let touchBar = CGRect(x: 80, y: 0, width: 685, height: 30)
    private let emoji = WorkbenchAuditElement(type: .button, label: "emoji & symbols", frame: CGRect(x: 79, y: -1, width: 74, height: 32))
    private let title = CGRect(x: 284, y: 31, width: 704, height: 52)

    private func node(_ type: XCUIElement.ElementType, _ frame: CGRect, label: String = "", identifier: String = "", _ children: [WorkbenchAuditNode] = []) -> WorkbenchAuditNode {
        WorkbenchAuditNode(element: WorkbenchAuditElement(type: type, identifier: identifier, label: label, frame: frame), children: children)
    }

    /// The app as the macOS audit saw it on CI, with `extra` among a page's views.
    private func app(page extra: [WorkbenchAuditNode] = []) -> WorkbenchAuditNode {
        let row = CGRect(x: 40, y: 83, width: 240, height: 19)
        let cell = CGRect(x: 50, y: 83, width: 220, height: 19)
        let headerRow = node(.outlineRow, row, [node(.cell, cell, [node(.group, header, [node(.staticText, CGRect(x: 54, y: 85, width: 34, height: 14), label: "Styles")])])])
        // A row's cell holding an unlabeled group of the app's.
        let appRow = node(.outlineRow, row.offsetBy(dx: 0, dy: 40), [node(.cell, cell.offsetBy(dx: 0, dy: 40), [node(.group, header.offsetBy(dx: 0, dy: 40), [node(.staticText, CGRect(x: 56, y: 130, width: 48, height: 16), identifier: "workbench.sidebar.buttons")])])])
        let page = CGRect(x: 280, y: 83, width: 712, height: 622)
        return node(.application, .zero, [
            node(.window, window, [
                node(.group, window, [
                    node(.splitGroup, window, [
                        node(.group, sidebar, [node(.scrollView, CGRect(x: 40, y: 83, width: 240, height: 614), [node(.outline, CGRect(x: 39, y: 82, width: 242, height: 616), label: "Sidebar", [headerRow, appRow])])]),
                        node(.group, window, [node(.scrollView, page, identifier: "workbench.screen.buttons", extra)]),
                    ]),
                ]),
                node(.staticText, title),
                node(.button, CGRect(x: 96, y: 49, width: 16, height: 16), identifier: "_XCUI:FullScreenWindow", [node(.group, fullScreenButton, [node(.group, fullScreenButton)])]),
            ]),
        ])
    }

    private func context(screen: String? = nil, colorScheme: String = "light", app: WorkbenchAuditNode? = nil, touchBars: [WorkbenchAuditNode]? = nil) -> WorkbenchAuditContext {
        var context = WorkbenchAuditContext(
            screen: screen,
            colorScheme: colorScheme,
            page: screen == nil ? nil : CGRect(x: 280, y: 83, width: 712, height: 622),
            window: window
        )
        (context.frameworkGroups, context.touchBarItems, context.windowTitles) = WorkbenchFrameworkElements.find(
            in: app ?? self.app(),
            touchBars: touchBars ?? [node(.touchBar, touchBar, [node(.button, emoji.frame, label: emoji.label)])]
        )
        return context
    }

    func testTheWindowGroupsWaiverCoversOnlyTheFrameworksGroups() {
        for screen in [nil, "buttons"] {
            let context = context(screen: screen)
            for frame in [window, sidebar, header] {
                XCTAssertEqual(waiver("sufficientElementDescription", .init(type: .group, frame: frame), context), "macos-window-groups", "\(frame)")
            }
            XCTAssertEqual(waiver("parentChild", .init(type: .group, frame: fullScreenButton), context), "macos-window-groups")

            // The app's unlabeled group in a row's cell, an unknown group, a
            // group with an empty frame, and a labeled group or another element
            // where a framework group is.
            for element in [
                WorkbenchAuditElement(type: .group, frame: header.offsetBy(dx: 0, dy: 40)),
                WorkbenchAuditElement(type: .group, frame: CGRect(x: 304, y: 107, width: 200, height: 40)),
                WorkbenchAuditElement(type: .group, frame: .zero),
                WorkbenchAuditElement(type: .group, label: "Styles", frame: header),
                WorkbenchAuditElement(type: .image, frame: header),
            ] {
                XCTAssertNil(waiver("sufficientElementDescription", element, context), "\(element)")
            }
        }
        // An unlabeled group of the app's that fills the window or shares the
        // sidebar's frame leaves those frames audited.
        let shared = context(screen: "buttons", app: app(page: [node(.group, window), node(.group, sidebar)]))
        XCTAssertNil(waiver("sufficientElementDescription", .init(type: .group, frame: window), shared))
        XCTAssertNil(waiver("sufficientElementDescription", .init(type: .group, frame: sidebar), shared))
        XCTAssertEqual(waiver("sufficientElementDescription", .init(type: .group, frame: header), shared), "macos-window-groups")
    }

    func testTheTouchBarWaiverCoversOnlyTheTouchBar() {
        let context = context(screen: "text-fields")
        XCTAssertEqual(waiver("sufficientElementDescription", .init(type: .touchBar, frame: touchBar), context), "macos-touch-bar")
        XCTAssertEqual(waiver("action", emoji, context), "macos-touch-bar")
        XCTAssertEqual(waiver("sufficientElementDescription", emoji, context), "macos-touch-bar")

        // The app's own elements: with an empty frame, off the window, or in it.
        for frame in [CGRect.zero, CGRect(x: 0, y: 768, width: 0, height: 0), CGRect(x: 1100, y: 300, width: 40, height: 20), CGRect(x: 304, y: 289, width: 91, height: 33), touchBar] {
            XCTAssertNil(waiver("action", .init(type: .button, frame: frame), context), "\(frame)")
        }
        // Not in a Touch Bar.
        XCTAssertNil(waiver("action", emoji, self.context(screen: "text-fields", touchBars: [])))
        // An element of the app's with the item's frame leaves it audited.
        let shared = self.context(screen: "text-fields", app: app(page: [node(.button, emoji.frame, label: emoji.label)]))
        XCTAssertNil(waiver("action", emoji, shared))
    }

    func testTheWindowTitleWaiverCoversOnlyAppKitsTitle() {
        let context = context(screen: "text-fields", colorScheme: "dark")
        XCTAssertEqual(waiver("contrast", .init(type: .staticText, value: "Text fields", frame: title), context), "macos-window-title")
        // The app's own texts: the list's row of the same name, and a text on
        // the page.
        XCTAssertNil(waiver("contrast", .init(type: .staticText, identifier: WorkbenchApp.sidebarPrefix + "text-fields", value: "Text fields", frame: CGRect(x: 56, y: 142, width: 70, height: 16)), context))
        XCTAssertNil(waiver("contrast", .init(type: .staticText, value: "Text fields", frame: CGRect(x: 304, y: 107, width: 80, height: 20)), context))
        // A text of the app's with the title's frame leaves it audited.
        let shared = self.context(screen: "text-fields", app: app(page: [node(.staticText, title)]))
        XCTAssertNil(waiver("contrast", .init(type: .staticText, frame: title), shared))
    }

    func testTheMisreadWaiverCoversOnlyListedTextsOutsideTheSelectedRow() {
        let screens: [String?] = [nil, "buttons", "toggles", "text-fields", "menus", "segmented-pickers", "progress", "segmented-meters", "banners", "toasts", "empty-states", "skeletons"]
        for screen in screens {
            for colorScheme in ["light", "dark"] {
                let context = context(screen: screen, colorScheme: colorScheme)
                for (id, title) in [("buttons", "Buttons"), ("toggles", "Toggles"), ("toasts", "Toasts"), ("empty-states", "Empty states")] {
                    let row = WorkbenchAuditElement(type: .staticText, identifier: WorkbenchApp.sidebarPrefix + id, value: title, frame: CGRect(x: 56, y: 110, width: 40, height: 16))
                    // Only the unselected "Toasts" row, in light.
                    XCTAssertEqual(
                        waiver("contrast", row, context), id == "toasts" && screen != "toasts" && colorScheme == "light" ? "contrast-misread" : nil,
                        "\(id) on \(screen ?? "the list") in \(colorScheme)"
                    )
                }
            }
        }
        // "Alerts" on the toggles in light, and nowhere else.
        let alerts = WorkbenchAuditElement(type: .staticText, value: "Alerts", frame: CGRect(x: 304, y: 139, width: 36, height: 16))
        XCTAssertEqual(waiver("contrast", alerts, context(screen: "toggles", colorScheme: "light")), "contrast-misread")
        XCTAssertNil(waiver("contrast", alerts, context(screen: "toggles", colorScheme: "dark")))
        XCTAssertNil(waiver("contrast", alerts, context(screen: "buttons")))
        var other = alerts
        other.value = "Sounds"
        XCTAssertNil(waiver("contrast", other, context(screen: "toggles")))
        // The empty state's message is not listed: the engine does not
        // reproduce its failure from its screenshot.
        let emptyMessage = WorkbenchAuditElement(type: .staticText, value: "Files you add appear here.", frame: CGRect(x: 550, y: 218, width: 172, height: 17))
        for colorScheme in ["light", "dark"] {
            XCTAssertNil(waiver("contrast", emptyMessage, context(screen: "empty-states", colorScheme: colorScheme)))
        }
        // The toast's text in dark, and only an enabled text.
        let context = context(screen: "toasts", colorScheme: "dark")
        for element in [
            WorkbenchAuditElement(type: .group, label: "Link copied", frame: CGRect(x: 412, y: 640, width: 167, height: 37)),
            WorkbenchAuditElement(type: .button, label: "Show toast", frame: CGRect(x: 304, y: 139, width: 90, height: 24)),
        ] {
            XCTAssertNil(waiver("contrast", element, context), "\(element.type)")
        }
        var toastText = WorkbenchAuditElement(type: .staticText, label: "Link copied", value: "The link is on the clipboard.", frame: CGRect(x: 412, y: 640, width: 167, height: 37))
        XCTAssertEqual(waiver("contrast", toastText, context), "contrast-misread")
        XCTAssertNil(waiver("contrast", toastText, self.context(screen: "toasts", colorScheme: "light")))
        // Toasts disables no control.
        toastText.isEnabled = false
        XCTAssertNil(waiver("contrast", toastText, context))
    }
    #endif
}
