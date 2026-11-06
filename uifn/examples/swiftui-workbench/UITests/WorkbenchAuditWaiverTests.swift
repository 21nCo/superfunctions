import XCTest

/// The waivers cover only the elements their reasons name: an app element
/// that merely shares a weak property with them, such as no label or a frame
/// outside the window, is still audited. These tests run no app.
final class WorkbenchAuditWaiverTests: XCTestCase {
    private let window = CGRect(x: 32, y: 31, width: 960, height: 674)

    func testContrastIsMeasuredBetweenTheLightestAndDarkestPixels() throws {
        func image(_ pixels: [UInt8]) throws -> CGImage {
            let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
            let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels.flatMap { [$0, $0, $0, 255] }) as CFData))
            return try XCTUnwrap(CGImage(
                width: pixels.count, height: 1, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: pixels.count * 4,
                space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent
            ))
        }
        XCTAssertEqual(try XCTUnwrap(WorkbenchContrast.ratio(of: image([0, 128, 255]))), 21, accuracy: 0.01)
        XCTAssertEqual(try XCTUnwrap(WorkbenchContrast.ratio(of: image([200, 200]))), 1, accuracy: 0.01)
        // #767676 is the lightest gray with 4.5:1 on white.
        XCTAssertEqual(try XCTUnwrap(WorkbenchContrast.ratio(of: image([0x76, 255]))), 4.54, accuracy: 0.01)
    }

    #if os(macOS)
    private let sidebar = CGRect(x: 40, y: 39, width: 240, height: 658)
    private let header = CGRect(x: 54, y: 83, width: 224, height: 19)
    private let fullScreenButton = CGRect(x: 97, y: 50, width: 14, height: 14)
    private let touchBar = CGRect(x: 80, y: 0, width: 685, height: 30)

    private func context(screen: String? = nil, colorScheme: String = "light") -> WorkbenchAuditContext {
        WorkbenchAuditContext(
            screen: screen,
            colorScheme: colorScheme,
            page: screen == nil ? nil : CGRect(x: 280, y: 83, width: 712, height: 622),
            window: window,
            frameworkGroups: [window, sidebar, header, fullScreenButton],
            touchBars: [touchBar]
        )
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

            // An unlabeled group of the app's, in the list or on a page.
            for frame in [CGRect(x: 54, y: 110, width: 224, height: 32), CGRect(x: 304, y: 107, width: 200, height: 40), .zero] {
                XCTAssertNil(waiver("sufficientElementDescription", .init(type: .group, frame: frame), context), "\(frame)")
            }
            // A labeled or identified group, or another element, where a framework group is.
            XCTAssertNil(waiver("sufficientElementDescription", .init(type: .group, label: "Styles", frame: header), context))
            XCTAssertNil(waiver("sufficientElementDescription", .init(type: .group, identifier: "workbench.screen.buttons", frame: sidebar), context))
            XCTAssertNil(waiver("sufficientElementDescription", .init(type: .image, frame: header), context))
        }
        // Without the framework's groups found, nothing is waived.
        var empty = context()
        empty.frameworkGroups = []
        XCTAssertNil(waiver("sufficientElementDescription", .init(type: .group, frame: .zero), empty))
        XCTAssertNil(waiver("sufficientElementDescription", .init(type: .group, frame: window), empty))
    }

    func testTheTouchBarWaiverCoversOnlyTheTouchBar() {
        let context = context(screen: "text-fields")
        XCTAssertEqual(waiver("sufficientElementDescription", .init(type: .touchBar, frame: touchBar), context), "macos-touch-bar")
        let emoji = WorkbenchAuditElement(type: .button, label: "emoji & symbols", frame: CGRect(x: 79, y: -1, width: 74, height: 32))
        XCTAssertEqual(waiver("action", emoji, context), "macos-touch-bar")
        XCTAssertEqual(waiver("sufficientElementDescription", emoji, context), "macos-touch-bar")

        // The app's own elements: with an empty frame, off the window but not
        // in a Touch Bar, or in the window.
        for frame in [CGRect.zero, CGRect(x: 0, y: 768, width: 0, height: 0), CGRect(x: 1100, y: 300, width: 40, height: 20), CGRect(x: 304, y: 289, width: 91, height: 33)] {
            XCTAssertNil(waiver("action", .init(type: .button, frame: frame), context), "\(frame)")
        }
        var noTouchBar = context
        noTouchBar.touchBars = []
        XCTAssertNil(waiver("action", emoji, noTouchBar))
    }

    func testTheContrastMisreadWaiverNeedsTheTextsPixelsToPass() {
        let alerts = WorkbenchAuditElement(type: .staticText, value: "Alerts", frame: CGRect(x: 304, y: 139, width: 36, height: 16))
        var measured = alerts
        measured.measuredContrast = 17
        XCTAssertEqual(waiver("contrast", measured, context(screen: "toggles")), "macos-contrast-misread")
        measured.measuredContrast = 3.9
        XCTAssertNil(waiver("contrast", measured, context(screen: "toggles")))
        XCTAssertNil(waiver("contrast", alerts, context(screen: "toggles")))
    }

    func testNoWaiverCoversTheSidebarsRows() {
        let screens: [String?] = [nil, "buttons", "toggles", "text-fields", "menus", "segmented-pickers", "progress", "segmented-meters", "banners", "toasts", "empty-states", "skeletons"]
        for screen in screens {
            for colorScheme in ["light", "dark"] {
                for (id, title) in [("buttons", "Buttons"), ("text-fields", "Text fields"), ("skeletons", "Skeletons")] {
                    let row = WorkbenchAuditElement(
                        type: .staticText, identifier: WorkbenchApp.sidebarPrefix + id, value: title,
                        frame: CGRect(x: 56, y: 110, width: 62, height: 16), measuredContrast: 15
                    )
                    XCTAssertNil(waiver("contrast", row, context(screen: screen, colorScheme: colorScheme)), "\(id) on \(screen ?? "the list") in \(colorScheme)")
                }
            }
        }
    }
    #endif
}
