import XCTest

/// The waivers cover only the elements their reasons name: an app element
/// that merely shares a weak property with them, such as no label or a frame
/// outside the window, is still audited. These tests run no app.
final class WorkbenchAuditWaiverTests: XCTestCase {
    #if os(macOS)
    private let window = CGRect(x: 32, y: 31, width: 960, height: 674)
    private let sidebar = CGRect(x: 40, y: 39, width: 240, height: 658)
    private let header = CGRect(x: 54, y: 83, width: 224, height: 19)
    private let fullScreenButton = CGRect(x: 97, y: 50, width: 14, height: 14)
    private let touchBar = CGRect(x: 80, y: 0, width: 685, height: 30)
    private let emoji = WorkbenchAuditElement(type: .button, label: "emoji & symbols", frame: CGRect(x: 79, y: -1, width: 74, height: 32))

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
        (context.frameworkGroups, context.touchBarItems) = WorkbenchFrameworkElements.find(
            in: app ?? self.app(),
            touchBars: touchBars ?? [node(.touchBar, touchBar, [node(.button, emoji.frame, label: emoji.label)])]
        )
        return context
    }

    private func waiver(_ auditType: String, _ element: WorkbenchAuditElement?, _ context: WorkbenchAuditContext) -> String? {
        WorkbenchAuditWaiver.matching(auditType, on: element, in: context)?.id
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

    func testNoWaiverCoversTheSidebarsRows() {
        let screens: [String?] = [nil, "buttons", "toggles", "text-fields", "menus", "segmented-pickers", "progress", "segmented-meters", "banners", "toasts", "empty-states", "skeletons"]
        for screen in screens {
            for colorScheme in ["light", "dark"] {
                for (id, title) in [("buttons", "Buttons"), ("text-fields", "Text fields"), ("skeletons", "Skeletons")] {
                    let row = WorkbenchAuditElement(
                        type: .staticText, identifier: WorkbenchApp.sidebarPrefix + id, value: title,
                        frame: CGRect(x: 56, y: 110, width: 62, height: 16)
                    )
                    XCTAssertNil(waiver("contrast", row, context(screen: screen, colorScheme: colorScheme)), "\(id) on \(screen ?? "the list") in \(colorScheme)")
                }
            }
        }
    }
    #endif
}
