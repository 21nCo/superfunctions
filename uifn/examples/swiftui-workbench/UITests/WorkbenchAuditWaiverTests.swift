import ImageIO
import XCTest

/// The waivers cover only the elements their reasons name: an app element
/// that merely shares a weak property with them, such as no label or a frame
/// outside the window, is still audited. These tests run no app.
final class WorkbenchAuditWaiverTests: XCTestCase {
    private typealias RGB = WorkbenchContrastMeasurement.RGB
    private let canvas = RGB(red: 229, green: 236, blue: 243)
    private let accent = RGB(red: 0, green: 100, blue: 225)
    private let ink = RGB(red: 15, green: 23, blue: 31)

    /// A screenshot the macOS audit attached on CI, from this bundle.
    private func crop(_ name: String) throws -> WorkbenchContrastMeasurement {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "png"), "The test bundle has no \(name).png")
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        return try XCTUnwrap(WorkbenchContrastMeasurement(XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))))
    }

    /// A drawn crop: lines of text 11 rows tall, each column of a stroke in
    /// the line's colors in turn, with a blended edge column after it.
    private func pixels(on background: RGB, lines: [[RGB]], width: Int = 60) -> [RGB] {
        let blank = [RGB](repeating: background, count: width)
        var pixels = blank + blank + blank
        for colors in lines {
            let row = (0..<width).map { x -> RGB in
                let color = colors[(x / 4) % colors.count]
                func half(_ a: UInt8, _ b: UInt8) -> UInt8 { UInt8((Int(a) + Int(b)) / 2) }
                switch x % 4 {
                case 0: return color
                case 1: return RGB(red: half(color.red, background.red), green: half(color.green, background.green), blue: half(color.blue, background.blue))
                default: return background
                }
            }
            for _ in 0..<11 { pixels += row }
            for _ in 0..<5 { pixels += blank }
        }
        return pixels
    }

    private func crop(on background: RGB, lines: [[RGB]]) -> WorkbenchContrastMeasurement? {
        WorkbenchContrastMeasurement(pixels: pixels(on: background, lines: lines), width: 60)
    }

    func testTheMeasurementReadsTheAuditsScreenshots() throws {
        // The selected row's text.primary on the accent selection: 3.36:1.
        let selected = try crop("contrast-selected-row-light")
        XCTAssertFalse(selected.passes, selected.summary)
        XCTAssertEqual(selected.background, accent)
        XCTAssertLessThan(selected.lines.first?.contrast ?? 0, 3.4, selected.summary)
        // The unselected "Toasts" row the audit failed, in the same colors as
        // the "Banners" row it passed.
        let toasts = try crop("contrast-toasts-row-light")
        XCTAssertTrue(toasts.passes, toasts.summary)
        XCTAssertEqual(toasts.background, canvas)
        // The toast's title and message, each measured.
        let toast = try crop("contrast-toast-dark")
        XCTAssertTrue(toast.passes, toast.summary)
        XCTAssertEqual(toast.lines.count, 2, toast.summary)
        // AppKit's window title, under the toolbar's separator.
        let title = try crop("contrast-window-title-dark")
        XCTAssertTrue(title.passes, title.summary)
        XCTAssertEqual(title.lines.count, 1, title.summary)
        XCTAssertEqual(title.rules.count, 1, title.summary)
    }

    func testTheMeasurementFailsEveryTextItCannotShowReaches45To1() throws {
        let faint = RGB(red: 160, green: 166, blue: 173)
        let secondary = RGB(red: 51, green: 59, blue: 69)
        XCTAssertTrue(try XCTUnwrap(crop(on: canvas, lines: [[ink]])).passes)
        XCTAssertTrue(try XCTUnwrap(crop(on: canvas, lines: [[ink], [secondary]])).passes)
        // A title that passes does not carry a message that fails.
        XCTAssertFalse(try XCTUnwrap(crop(on: canvas, lines: [[ink], [faint]])).passes)
        // Nor does one color carry another on the same line.
        let twoColors = try XCTUnwrap(crop(on: canvas, lines: [[ink, RGB(red: 200, green: 30, blue: 30)]]))
        XCTAssertFalse(twoColors.passes, twoColors.summary)
        // A few pixels of higher contrast do not lift a failing line.
        var stray = [RGB](repeating: accent, count: 60 * 19)
        for row in 3..<14 { for x in stride(from: 0, to: 60, by: 4) { stray[row * 60 + x] = ink } }
        for x in [1, 5, 9] { stray[8 * 60 + x] = RGB(red: 255, green: 255, blue: 255) }
        let accentRow = try XCTUnwrap(WorkbenchContrastMeasurement(pixels: stray, width: 60))
        XCTAssertFalse(accentRow.passes, accentRow.summary)
        // No text, or no one background.
        XCTAssertFalse(try XCTUnwrap(crop(on: canvas, lines: [])).passes)
        let mixed = pixels(on: canvas, lines: [[ink]]).enumerated().map { $1 == canvas && $0 % 2 == 0 ? RGB(red: 209, green: 216, blue: 223) : $1 }
        let noBackground = try XCTUnwrap(WorkbenchContrastMeasurement(pixels: mixed, width: 60))
        XCTAssertFalse(noBackground.passes, noBackground.summary)
    }

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

    func testTheMisreadWaiverCoversOnlyMeasuredTextOutsideTheSelectedRow() throws {
        let passing = try crop("contrast-toasts-row-light")
        let failing = try crop("contrast-selected-row-light")
        let screens: [String?] = [nil, "buttons", "toggles", "text-fields", "menus", "segmented-pickers", "progress", "segmented-meters", "banners", "toasts", "empty-states", "skeletons"]
        for screen in screens {
            for colorScheme in ["light", "dark"] {
                let context = context(screen: screen, colorScheme: colorScheme)
                for (id, title) in [("buttons", "Buttons"), ("toggles", "Toggles"), ("toasts", "Toasts"), ("skeletons", "Skeletons")] {
                    var row = WorkbenchAuditElement(
                        type: .staticText, identifier: WorkbenchApp.sidebarPrefix + id, value: title,
                        frame: CGRect(x: 56, y: 110, width: 62, height: 16)
                    )
                    let name = "\(id) on \(screen ?? "the list") in \(colorScheme)"
                    XCTAssertNil(waiver("contrast", row, context), "unmeasured \(name)")
                    row.contrast = failing
                    XCTAssertNil(waiver("contrast", row, context), "failing \(name)")
                    row.contrast = passing
                    XCTAssertEqual(waiver("contrast", row, context), id == screen ? nil : "macos-contrast-misread", "passing \(name)")
                }
            }
        }
        // A text is waived by what it measures, not by its name.
        var alerts = WorkbenchAuditElement(type: .staticText, value: "Alerts", frame: CGRect(x: 304, y: 139, width: 36, height: 16))
        alerts.contrast = failing
        XCTAssertNil(waiver("contrast", alerts, context(screen: "toggles", colorScheme: "light")))
        // Only an enabled text.
        let context = context(screen: "toasts")
        for element in [
            WorkbenchAuditElement(type: .group, label: "Link copied", frame: CGRect(x: 412, y: 640, width: 167, height: 37), contrast: passing),
            WorkbenchAuditElement(type: .button, label: "Show toast", frame: CGRect(x: 304, y: 139, width: 90, height: 24), contrast: passing),
        ] {
            XCTAssertNil(waiver("contrast", element, context), "\(element.type)")
        }
        // A toast's title and message, each measured.
        var toast = WorkbenchAuditElement(type: .staticText, label: "Link copied", frame: CGRect(x: 412, y: 640, width: 167, height: 37))
        toast.contrast = try crop("contrast-toast-dark")
        XCTAssertEqual(waiver("contrast", toast, context), "macos-contrast-misread")
        toast.contrast = crop(on: canvas, lines: [[ink], [RGB(red: 160, green: 166, blue: 173)]])
        XCTAssertNil(waiver("contrast", toast, context))
        toast.isEnabled = false
        toast.contrast = try crop("contrast-toasts-row-light")
        XCTAssertEqual(waiver("contrast", toast, context), "disabled-contrast")
    }
    #endif
}
