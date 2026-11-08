import ImageIO
import XCTest

/// The waivers cover only the elements their reasons name: an app element
/// that merely shares a weak property with them, such as no label or a frame
/// outside the window, is still audited. These tests run no app.
final class WorkbenchAuditWaiverTests: XCTestCase {
    #if os(macOS)
    private typealias RGB = WorkbenchTextProof.RGB
    private typealias Line = WorkbenchExpectedLine
    private let alerts = [Line(text: "Alerts", points: 14)]
    private let emptyState = [Line(text: "Files you add appear here.", points: 14)]
    private let toast = [Line(text: "Link copied", points: 14, isSemibold: true), Line(text: "The link is on the clipboard.", points: 13)]
    private func row(_ title: String) -> [Line] { [Line(text: title, points: 13)] }

    /// A screenshot the macOS audit attached on CI, from this bundle, as
    /// rows of pixels, top row first.
    private func screenshot(_ name: String) throws -> (pixels: [RGB], width: Int) {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "png"), "The test bundle has no \(name).png")
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        return try (XCTUnwrap(WorkbenchTextProof.pixels(of: image)), image.width)
    }

    /// The proof of `expected` in the screenshot, after `edit` changes its
    /// pixels, given the screenshot's background and its words' columns.
    private func proof(_ name: String, _ expected: [Line], edit: (inout [RGB], Int, RGB, [ClosedRange<Int>]) -> Void = { _, _, _, _ in }) throws -> WorkbenchTextProof {
        var (pixels, width) = try screenshot(name)
        let background = try XCTUnwrap(WorkbenchTextProof(pixels: pixels, width: width, expected: []), name).background
        // Words: columns with ink, split at three or more columns without.
        var words: [ClosedRange<Int>] = []
        for x in 0..<width where stride(from: x, to: pixels.count, by: width).contains(where: { pixels[$0].offset(from: background).contains { abs($0) > 3 } }) {
            if let last = words.last, x - last.upperBound <= 3 { words[words.count - 1] = last.lowerBound...x } else { words.append(x...x) }
        }
        edit(&pixels, width, background, words)
        return try XCTUnwrap(WorkbenchTextProof(pixels: pixels, width: width, expected: expected), name)
    }

    /// Sets each pixel in the columns that `pick` returns for the
    /// screenshot's words to `color(pixel, background)`.
    private func recolor(_ pick: @escaping ([ClosedRange<Int>]) -> ClosedRange<Int>, rows: ClosedRange<Int>? = nil, _ color: @escaping (RGB, RGB) -> RGB) -> (inout [RGB], Int, RGB, [ClosedRange<Int>]) -> Void {
        { pixels, width, background, words in
            for index in pixels.indices where pick(words).contains(index % width) && rows?.contains(index / width) != false {
                pixels[index] = color(pixels[index], background)
            }
        }
    }

    func testTheProofPassesTheTextsTheAuditMisreadOnCI() throws {
        for (name, expected) in [("contrast-toasts-row-light", row("Toasts")), ("contrast-alerts-light", alerts), ("contrast-empty-state-dark", emptyState), ("contrast-toast-dark", toast)] {
            let proof = try proof(name, expected)
            XCTAssertTrue(proof.passes, "\(name): \(proof.summary)")
        }
        // The selected row's text.primary on the accent selection: 3.36:1.
        let selected = try proof("contrast-selected-row-light", row("Toggles"))
        XCTAssertFalse(selected.passes, selected.summary)
        XCTAssertEqual(selected.lines.first?.glyphs.allSatisfy { (0.85...1.15).contains($0.strength) && $0.misfit <= 0.12 }, true, selected.summary)
        XCTAssertLessThan(selected.lines.first?.contrast ?? 0, 3.4, selected.summary)
        // AppKit's window title, which spans the toolbar's separator and the
        // window's corner (see the macos-window-title waiver).
        XCTAssertFalse(try proof("contrast-window-title-dark", [Line(text: "Text fields", points: 13)]).passes)
    }

    func testTheProofFailsTextTheScreenshotDoesNotShowInFull() throws {
        // Another text, size or weight, a line too many or none.
        for expected in [row("Toast"), row("Banners"), [Line(text: "Toasts", points: 13, isSemibold: true)], [Line(text: "Toasts", points: 14)], row("Toasts") + row("Toasts"), []] {
            let proof = try proof("contrast-toasts-row-light", expected)
            XCTAssertFalse(proof.passes, "\(expected): \(proof.summary)")
        }
        // A screenshot that cuts the text off: the top of each glyph, or most
        // of the last "s".
        let (pixels, width) = try screenshot("contrast-toasts-row-light")
        let lowered = try XCTUnwrap(WorkbenchTextProof(pixels: Array(pixels.dropFirst(6 * width)), width: width, expected: row("Toasts")))
        XCTAssertFalse(lowered.passes, lowered.summary)
        let narrowed = stride(from: 0, to: pixels.count, by: width).flatMap { pixels[$0..<$0 + width - 4] }
        let cut = try XCTUnwrap(WorkbenchTextProof(pixels: narrowed, width: width - 4, expected: row("Toasts")))
        XCTAssertFalse(cut.passes, cut.summary)
        // Crops that leave whole glyphs out, with no columns to fit: they
        // stay unproven, and their summary reads rather than trapping.
        let white = RGB(red: 255, green: 255, blue: 255), black = RGB(red: 0, green: 0, blue: 0)
        let firstColumns = stride(from: 0, to: pixels.count, by: width).flatMap { pixels[$0..<$0 + 8] }
        for (name, crop, cropWidth) in [("one column", [white, white, black, white, white], 1), ("first 8 columns", firstColumns, 8)] {
            guard let unfitted = WorkbenchTextProof(pixels: crop, width: cropWidth, expected: row("Toasts")) else { continue }
            XCTAssertFalse(unfitted.passes, "\(name): \(unfitted.summary)")
            XCTAssertTrue(unfitted.summary.hasSuffix("not proven"), "\(name): \(unfitted.summary)")
        }
        let middle = { (words: [ClosedRange<Int>]) in words[2] }
        let edits: [(String, String, [Line], (inout [RGB], Int, RGB, [ClosedRange<Int>]) -> Void)] = [
            // A word within 3 of the background, which no band of ink shows.
            ("invisible word", "contrast-empty-state-dark", emptyState, recolor(middle) { _, background in background.blend(toward: RGB(red: 255, green: 255, blue: 255), 0.01) }),
            ("missing word", "contrast-empty-state-dark", emptyState, recolor(middle) { _, background in background }),
            ("faint word", "contrast-empty-state-dark", emptyState, recolor(middle) { pixel, background in background.blend(toward: pixel, 0.3) }),
            ("word in another color", "contrast-empty-state-dark", emptyState, recolor(middle) { pixel, background in pixel == background ? pixel : RGB(red: 230, green: 120, blue: 120) }),
            // A faint mark of the text's hue touching the "l", at about 1.9:1.
            ("faint mark touching a glyph", "contrast-alerts-light", alerts, recolor({ _ in 12...14 }, rows: 4...13) { pixel, background in
                pixel.offset(from: background).allSatisfy { abs($0) <= 3 } ? background.blend(toward: RGB(red: 15, green: 23, blue: 31), 0.3) : pixel
            }),
            ("faint message line", "contrast-toast-dark", toast, recolor({ _ in 0...Int.max }, rows: 20...36) { pixel, background in background.blend(toward: pixel, 0.3) }),
            // A dot four columns after the title "Link copied", which ends at column 76.
            ("mark after the text", "contrast-toast-dark", toast, recolor({ _ in 80...81 }, rows: 14...15) { _, _ in RGB(red: 234, green: 239, blue: 245) }),
            // The top of the "T" at 40% of its strength.
            ("glyph half faint", "contrast-toasts-row-light", row("Toasts"), recolor({ $0[0].lowerBound...($0[0].lowerBound + 7) }, rows: 0...7) { pixel, background in background.blend(toward: pixel, 0.4) }),
            // Each glyph mostly in a color at 4.22:1, with every third pixel of
            // ink in a darker one of the same hue at 6.78:1, so the glyphs'
            // ink averages 87% of the darker color's, which would reach 4.9:1.
            ("same-hue text below 4.5:1", "contrast-toasts-row-light", row("Toasts"), { pixels, _, background, _ in
                var inked = 0
                for index in pixels.indices where pixels[index] != background {
                    let share = (Double(background.green) - Double(pixels[index].green)) / (Double(background.green) - 23)
                    pixels[index] = background.blend(toward: inked % 3 == 0 ? RGB(red: 73, green: 81, blue: 88) : RGB(red: 104, green: 112, blue: 119), min(max(share, 0), 1))
                    inked += 1
                }
            }),
            ("fill behind a glyph", "contrast-toasts-row-light", row("Toasts"), recolor({ $0[0].lowerBound...($0[0].lowerBound + 6) }) { pixel, _ in pixel.blend(toward: RGB(red: 200, green: 160, blue: 120), 0.5) }),
            ("no one background", "contrast-toasts-row-light", row("Toasts"), { pixels, _, background, _ in
                for index in pixels.indices where index % 2 == 0 && pixels[index] == background { pixels[index] = background.blend(toward: RGB(red: 0, green: 0, blue: 0), 0.05) }
            }),
        ]
        for (name, screenshot, expected, edit) in edits {
            let proof = try proof(screenshot, expected, edit: edit)
            XCTAssertFalse(proof.passes, "\(name): \(proof.summary)")
        }
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

    func testTheMisreadWaiverCoversOnlyProvenTextOutsideTheSelectedRow() throws {
        let toastsRow = try proof("contrast-toasts-row-light", row("Toasts"))
        let selectedRow = try proof("contrast-selected-row-light", row("Toggles"))
        let screens: [String?] = [nil, "buttons", "toggles", "text-fields", "menus", "segmented-pickers", "progress", "segmented-meters", "banners", "toasts", "empty-states", "skeletons"]
        for screen in screens {
            for colorScheme in ["light", "dark"] {
                let context = context(screen: screen, colorScheme: colorScheme)
                for (id, title) in [("buttons", "Buttons"), ("toggles", "Toggles"), ("toasts", "Toasts")] {
                    var row = WorkbenchAuditElement(type: .staticText, identifier: WorkbenchApp.sidebarPrefix + id, value: title, frame: CGRect(x: 56, y: 110, width: 40, height: 16))
                    let name = "\(id) on \(screen ?? "the list") in \(colorScheme)"
                    XCTAssertNil(waiver("contrast", row, context), "unproven \(name)")
                    row.proof = selectedRow
                    XCTAssertNil(waiver("contrast", row, context), "failing \(name)")
                    // A proof passes only for the text it shows: "Toasts".
                    row.proof = toastsRow
                    XCTAssertEqual(waiver("contrast", row, context), id == "toasts" && screen != "toasts" ? "macos-contrast-misread" : nil, "proven \(name)")
                }
            }
        }
        // A text the audit was seen to misread, where it misread it.
        let alertsProof = try proof("contrast-alerts-light", alerts)
        let alertsText = WorkbenchAuditElement(type: .staticText, value: "Alerts", frame: CGRect(x: 304, y: 139, width: 36, height: 16), proof: alertsProof)
        XCTAssertEqual(waiver("contrast", alertsText, context(screen: "toggles", colorScheme: "light")), "macos-contrast-misread")
        XCTAssertNil(waiver("contrast", alertsText, context(screen: "buttons")))
        var other = alertsText
        other.value = "Anything else"
        XCTAssertNil(waiver("contrast", other, context(screen: "toggles")))
        var emptyMessage = WorkbenchAuditElement(type: .staticText, value: "Files you add appear here.", frame: CGRect(x: 550, y: 218, width: 172, height: 17))
        emptyMessage.proof = try proof("contrast-empty-state-dark", emptyState)
        XCTAssertEqual(waiver("contrast", emptyMessage, context(screen: "empty-states", colorScheme: "dark")), "macos-contrast-misread")
        // Only an enabled text.
        let context = context(screen: "toasts")
        let toastProof = try proof("contrast-toast-dark", toast)
        for element in [
            WorkbenchAuditElement(type: .group, label: "Link copied", frame: CGRect(x: 412, y: 640, width: 167, height: 37), proof: toastProof),
            WorkbenchAuditElement(type: .button, label: "Show toast", frame: CGRect(x: 304, y: 139, width: 90, height: 24), proof: toastProof),
        ] {
            XCTAssertNil(waiver("contrast", element, context), "\(element.type)")
        }
        var toastText = WorkbenchAuditElement(type: .staticText, label: "Link copied", value: "The link is on the clipboard.", frame: CGRect(x: 412, y: 640, width: 167, height: 37), proof: toastProof)
        XCTAssertEqual(waiver("contrast", toastText, context), "macos-contrast-misread")
        toastText.proof = try proof("contrast-toast-dark", toast, edit: recolor({ _ in 0...Int.max }, rows: 20...36) { pixel, background in background.blend(toward: pixel, 0.3) })
        XCTAssertNil(waiver("contrast", toastText, context))
        toastText.isEnabled = false
        XCTAssertEqual(waiver("contrast", toastText, context), "disabled-contrast")
    }
    #endif
}
