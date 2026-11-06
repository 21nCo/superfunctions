import XCTest

/// Runs Xcode's automated accessibility audit on every workbench screen, in
/// light and dark, on macOS and the iOS simulator.
///
/// An issue fails the test unless a waiver in ``WorkbenchAuditWaiver/all``
/// matches it; the waivers and their reasons are listed in the workbench
/// README. The audit does not stand in for checking the screens with
/// VoiceOver or under other display settings.
final class WorkbenchAccessibilityAuditTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = true
    }

    func testScreenList() throws { try audit(nil) }
    func testButtons() throws { try auditScreen() }
    func testToggles() throws { try auditScreen() }
    func testTextFields() throws { try auditScreen() }
    func testMenus() throws { try auditScreen() }
    func testSegmentedPickers() throws { try auditScreen() }
    func testProgressAndGauges() throws { try auditScreen() }
    func testSegmentedMeters() throws { try auditScreen() }
    func testBanners() throws { try auditScreen() }
    func testEmptyStates() throws { try auditScreen() }
    func testSkeletons() throws { try auditScreen() }

    func testToasts() throws {
        try auditScreen { app in
            app.descendants(matching: .any)["toasts.show"].firstMatch.tap()
            XCTAssertTrue(
                app.buttons["Dismiss notification"].waitForExistence(timeout: 5),
                "The toast did not appear"
            )
        }
    }

    /// Each switch on the toggles screen sets only its own setting.
    func testTogglesChangeIndependently() throws {
        let app = WorkbenchApp.launch(screen: "toggles", colorScheme: "light")
        defer { app.terminate() }
        XCTAssertTrue(WorkbenchApp.screen("toggles", in: app).waitForExistence(timeout: 10), "toggles did not appear")
        func toggle(_ label: String) -> XCUIElement {
            app.descendants(matching: .any).matching(NSPredicate(
                format: "label == %@ AND (elementType == %d OR elementType == %d)",
                label, XCUIElement.ElementType.switch.rawValue, XCUIElement.ElementType.checkBox.rawValue
            )).firstMatch
        }
        func value(_ element: XCUIElement) -> String { "\(element.value ?? "")" }
        // A labelled switch's element spans its label, which takes no
        // presses, so press the track at the trailing end of the row.
        func press(_ element: XCUIElement) {
            let track = element.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5)).withOffset(CGVector(dx: -10, dy: 0))
            #if os(macOS)
            track.click()
            #else
            track.tap()
            #endif
        }
        let sounds = toggle("Sounds")
        let vibrate = toggle("Vibrate")
        XCTAssertTrue(vibrate.waitForExistence(timeout: 5), "The Vibrate switch did not appear")
        let soundsBefore = value(sounds)
        let vibrateBefore = value(vibrate)
        press(vibrate)
        XCTAssertNotEqual(value(vibrate), vibrateBefore, "Vibrate did not change")
        XCTAssertEqual(value(sounds), soundsBefore, "Setting Vibrate changed Sounds")
        press(sounds)
        XCTAssertNotEqual(value(sounds), soundsBefore, "Sounds did not change")
        XCTAssertNotEqual(value(vibrate), vibrateBefore, "Setting Sounds changed Vibrate")
    }

    /// The screens in the app's list are the screens the tests above audit,
    /// each with its own test, and each opens from the list.
    func testEveryScreenInTheListIsAudited() throws {
        let testNames = Set(Self.defaultTestSuite.tests.compactMap { test in
            // "-[Module.Class testName]"
            test.name.split(separator: " ").last.map { String($0.dropLast()) + "()" }
        })
        for test in WorkbenchApp.screensByTest.keys where !testNames.contains(test) {
            XCTFail("No test \(test) audits \(WorkbenchApp.screensByTest[test] ?? "")")
        }

        let app = WorkbenchApp.launch(screen: nil, colorScheme: "light")
        let rows = WorkbenchApp.sidebarRows(in: app)
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "The screen list did not appear")
        let listed = Set(rows.allElementsBoundByIndex.map { String($0.identifier.dropFirst(WorkbenchApp.sidebarPrefix.count)) })
        let audited = Set(WorkbenchApp.screensByTest.values)
        XCTAssertEqual(listed, audited, "The audit tests and the app's screens differ")

        for screen in audited.sorted() {
            app.descendants(matching: .any)[WorkbenchApp.sidebarPrefix + screen].firstMatch.tap()
            XCTAssertTrue(WorkbenchApp.screen(screen, in: app).waitForExistence(timeout: 10), "\(screen) did not open from the list")
            #if os(iOS)
            app.navigationBars.buttons.element(boundBy: 0).tap()
            #endif
        }
    }

    /// The README's waiver table lists each waiver by id with its reason. A
    /// runner that cannot read the README skips the test, unless
    /// `UIFN_WORKBENCH_REQUIRE_README` is set, as CI sets it through
    /// `TEST_RUNNER_UIFN_WORKBENCH_REQUIRE_README`.
    func testTheReadmeListsEveryWaiver() throws {
        let readme = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("README.md")
        let text: String
        do {
            text = try String(contentsOf: readme, encoding: .utf8)
        } catch {
            let message = "The test runner cannot read \(readme.path): \(error)"
            if ProcessInfo.processInfo.environment["UIFN_WORKBENCH_REQUIRE_README"] == "1" {
                XCTFail(message)
                return
            }
            throw XCTSkip(message)
        }
        var listed: [String: String] = [:]
        for row in text.split(separator: "\n") where row.hasPrefix("| `") {
            let cells = row.split(separator: "|", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            guard cells.count > 3 else { continue }
            listed[cells[1].trimmingCharacters(in: CharacterSet(charactersIn: "`"))] = cells[cells.count - 2]
        }
        let waivers = Dictionary(uniqueKeysWithValues: WorkbenchAuditWaiver.all.map { ($0.id, $0.reason) })
        XCTAssertEqual(listed, waivers, "The README's waiver table and WorkbenchAuditWaiver.all differ")
    }

    /// Audits the screen ``WorkbenchApp/screensByTest`` names for the test.
    private func auditScreen(
        test: String = #function,
        prepare: (XCUIApplication) -> Void = { _ in },
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        guard let screen = WorkbenchApp.screensByTest[test] else {
            return XCTFail("WorkbenchApp.screensByTest has no screen for \(test)", file: file, line: line)
        }
        try audit(screen, prepare: prepare, file: file, line: line)
    }

    /// Audits `screen`, or the list of screens when nil, in light and then
    /// dark, after `prepare` puts the screen in the state to audit.
    private func audit(
        _ screen: String?,
        prepare: (XCUIApplication) -> Void = { _ in },
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        for colorScheme in ["light", "dark"] {
            try XCTContext.runActivity(named: "Audit \(screen ?? "the screen list") in \(colorScheme)") { _ in
                let app = WorkbenchApp.launch(screen: screen, colorScheme: colorScheme)
                defer { app.terminate() }
                guard let screen else {
                    let rows = WorkbenchApp.sidebarRows(in: app)
                    XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 10), "The screen list did not appear", file: file, line: line)
                    try WorkbenchApp.waitForStillLayout(app)
                    let window = app.windows.firstMatch.frame
                    for row in rows.allElementsBoundByIndex where !window.contains(row.frame) {
                        XCTFail("The screen list does not fit its window: \(row.identifier) is at \(row.frame)", file: file, line: line)
                    }
                    try auditVisibleContent(of: app, screen: nil, colorScheme: colorScheme)
                    return
                }
                let page = WorkbenchApp.screen(screen, in: app)
                guard page.waitForExistence(timeout: 10) else {
                    return XCTFail("\(screen) did not appear", file: file, line: line)
                }
                prepare(app)
                try WorkbenchApp.waitForStillLayout(app)
                // The audit judges contrast from what is on screen, so the
                // whole page must be.
                try assertWholePageIsOnScreen(page, screen: screen, file: file, line: line)
                try auditVisibleContent(of: app, screen: screen, colorScheme: colorScheme)
            }
        }
    }

    /// Fails unless every element of the page lies inside the page's frame,
    /// so none is scrolled out of sight while the audit runs.
    private func assertWholePageIsOnScreen(_ page: XCUIElement, screen: String, file: StaticString, line: UInt) throws {
        let snapshot = try page.snapshot()
        var outside: [String] = []
        func visit(_ element: XCUIElementSnapshot) {
            for child in element.children {
                let frame = child.frame
                // Unlabeled containers and decoration, such as the scroll
                // indicator, have nothing to audit; their children are checked.
                // Nor do the 2-point pop-up buttons SwiftUI keeps at a corner
                // of the screen to open each menu from on macOS.
                let isAudited = (child.elementType != .other || !child.label.isEmpty)
                    && !(frame.width <= 2 && frame.height <= 2)
                if isAudited && !frame.isEmpty && (frame.minY < snapshot.frame.minY - 1 || frame.maxY > snapshot.frame.maxY + 1) {
                    outside.append("\(child.elementType.rawValue) \"\(child.label)\" \(frame)")
                }
                visit(child)
            }
        }
        visit(snapshot)
        XCTAssertTrue(
            outside.isEmpty,
            "\(screen) is taller than its \(snapshot.frame) page, so the audit cannot see all of it; split the screen or enlarge the window. Outside: \(outside.joined(separator: "; "))",
            file: file, line: line
        )
    }

    private func auditVisibleContent(of app: XCUIApplication, screen: String?, colorScheme: String) throws {
        var waived: [String] = []
        let context = WorkbenchAuditContext(
            screen: screen,
            colorScheme: colorScheme,
            page: screen.map { WorkbenchApp.screen($0, in: app).frame },
            window: app.windows.firstMatch.frame
        )
        try app.performAccessibilityAudit { issue in
            let summary = "\(issue.auditType.workbenchName) on \(issue.element.map(WorkbenchApp.describe) ?? "the app")"
            if let waiver = WorkbenchAuditWaiver.matching(issue, in: context) {
                waived.append("\(summary): \(waiver.reason)")
            } else {
                // Recorded here, with the element, rather than by the audit,
                // whose failure names only the audit type.
                XCTFail("\(screen ?? "screen list") (\(colorScheme)): \(summary): \(issue.compactDescription). \(issue.detailedDescription)")
            }
            return true
        }
        if !waived.isEmpty {
            let attachment = XCTAttachment(string: waived.joined(separator: "\n"))
            attachment.name = "Waived accessibility audit issues"
            attachment.lifetime = .keepAlways
            XCTContext.runActivity(named: "\(waived.count) waived issue(s)") { $0.add(attachment) }
        }
    }
}

/// Launches the workbench app and finds its screens.
enum WorkbenchApp {
    static let sidebarPrefix = "workbench.sidebar."

    /// The screen, by launch argument, that each audit test covers.
    static let screensByTest = [
        "testButtons()": "buttons",
        "testToggles()": "toggles",
        "testTextFields()": "text-fields",
        "testMenus()": "menus",
        "testSegmentedPickers()": "segmented-pickers",
        "testProgressAndGauges()": "progress",
        "testSegmentedMeters()": "segmented-meters",
        "testBanners()": "banners",
        "testToasts()": "toasts",
        "testEmptyStates()": "empty-states",
        "testSkeletons()": "skeletons",
    ]

    static func launch(screen: String?, colorScheme: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UIFnWorkbenchColorScheme", colorScheme]
        if let screen {
            app.launchArguments += ["-UIFnWorkbenchScreen", screen]
        }
        app.launch()
        #if os(macOS)
        app.activate()
        #endif
        return app
    }

    /// Waits until no element of the window moves for half a second, so the
    /// audit does not run during a transition, such as the push to the first
    /// screen that iOS 18 animates at launch.
    static func waitForStillLayout(_ app: XCUIApplication, timeout: TimeInterval = 10) throws {
        func frames() throws -> [CGRect] {
            var frames: [CGRect] = []
            func visit(_ element: XCUIElementSnapshot) {
                frames.append(element.frame)
                element.children.forEach(visit)
            }
            visit(try app.windows.firstMatch.snapshot())
            return frames
        }
        let deadline = Date().addingTimeInterval(timeout)
        var last = try frames()
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
            let current = try frames()
            if current == last { return }
            last = current
        }
        XCTFail("The window was still moving after \(Int(timeout)) seconds")
    }

    /// The rows of the list of screens.
    static func sidebarRows(in app: XCUIApplication) -> XCUIElementQuery {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH %@", sidebarPrefix))
    }

    static func screen(_ screen: String, in app: XCUIApplication) -> XCUIElement {
        app.scrollViews["workbench.screen.\(screen)"].firstMatch
    }

    /// The element's type, identifier, label and value, for failure messages.
    static func describe(_ element: XCUIElement) -> String {
        var parts = ["\(element.elementType.rawValue)"]
        if !element.identifier.isEmpty { parts.append("id \"\(element.identifier)\"") }
        if !element.label.isEmpty { parts.append("label \"\(element.label)\"") }
        if let value = element.value as? String, !value.isEmpty { parts.append("value \"\(value)\"") }
        if !element.isEnabled { parts.append("disabled") }
        parts.append("frame \(element.frame)")
        return parts.joined(separator: " ")
    }
}

extension XCUIAccessibilityAuditType {
    /// The audit type's name, for waivers and logs.
    var workbenchName: String {
        var names: [String] = []
        if contains(.contrast) { names.append("contrast") }
        if contains(.elementDetection) { names.append("elementDetection") }
        if contains(.hitRegion) { names.append("hitRegion") }
        if contains(.sufficientElementDescription) { names.append("sufficientElementDescription") }
        #if os(iOS)
        if contains(.dynamicType) { names.append("dynamicType") }
        if contains(.textClipped) { names.append("textClipped") }
        if contains(.trait) { names.append("trait") }
        #endif
        #if os(macOS)
        if contains(.action) { names.append("action") }
        if contains(.parentChild) { names.append("parentChild") }
        #endif
        return names.isEmpty ? "rawValue \(rawValue)" : names.joined(separator: "+")
    }
}
