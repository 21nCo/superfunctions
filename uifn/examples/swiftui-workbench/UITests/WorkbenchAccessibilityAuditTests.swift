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
        // By identifier: on macOS a labelled switch is a switch named by a
        // separate text, as the system's is, and one with its label hidden
        // is a checkbox.
        func toggle(_ id: String) -> XCUIElement {
            app.descendants(matching: .any).matching(NSPredicate(
                format: "identifier == %@ AND (elementType == %d OR elementType == %d)",
                id, XCUIElement.ElementType.switch.rawValue, XCUIElement.ElementType.checkBox.rawValue
            )).firstMatch
        }
        func value(_ element: XCUIElement) -> String { "\(element.value ?? "")" }
        // On iOS a labelled switch's element spans its label, which takes
        // no presses, so press the track at the trailing end of the element.
        func press(_ element: XCUIElement) {
            let track = element.coordinate(withNormalizedOffset: CGVector(dx: 1, dy: 0.5)).withOffset(CGVector(dx: -10, dy: 0))
            #if os(macOS)
            track.click()
            #else
            track.tap()
            #endif
        }
        let sounds = toggle("toggles.sounds")
        let vibrate = toggle("toggles.vibrate")
        XCTAssertTrue(sounds.waitForExistence(timeout: 5), "The Sounds switch did not appear")
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

    #if os(macOS)
    /// While the list of screens has keyboard focus, the selected row shows
    /// an outline that reaches 3:1 against what it covers; when focus moves
    /// to the screen, the outline goes.
    func testTheSelectedRowShowsWhenTheListHasFocus() throws {
        for colorScheme in ["light", "dark"] {
            let app = WorkbenchApp.launch(screen: "text-fields", colorScheme: colorScheme)
            defer { app.terminate() }
            let row = app.outlineRows.containing(.staticText, identifier: WorkbenchApp.sidebarPrefix + "text-fields").firstMatch
            // XCUITest finds no hit point on the selected row itself, whose
            // center lies past its title, so click the title, as
            // testEveryScreenInTheListIsAudited clicks each row's.
            let title = app.staticTexts[WorkbenchApp.sidebarPrefix + "text-fields"].firstMatch
            let field = app.textFields.firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 10), "The selected row did not appear")
            XCTAssertTrue(field.waitForExistence(timeout: 5), "No text field appeared")
            field.click()
            let unfocused = try XCTUnwrap(row.screenshot().workbenchCGImage.flatMap(WorkbenchTextProof.pixels(of:)))
            /// The pixels of the row that changed from `unfocused` by at
            /// least 3:1, waiting up to 3 seconds for `isDone`.
            func outline(until isDone: (Int) -> Bool) -> Int {
                var changed = 0
                for _ in 0..<6 {
                    let pixels = row.screenshot().workbenchCGImage.flatMap(WorkbenchTextProof.pixels(of:)) ?? []
                    changed = pixels.count == unfocused.count ? zip(pixels, unfocused).filter { $0.contrast(with: $1) >= 3 }.count : -1
                    if isDone(changed) { break }
                    Thread.sleep(forTimeInterval: 0.5)
                }
                return changed
            }
            title.click()
            // Only the list with keyboard focus moves its selection with the
            // arrow keys: down to the next screen and back.
            app.typeKey(.downArrow, modifierFlags: [])
            XCTAssertTrue(WorkbenchApp.screen("menus", in: app).waitForExistence(timeout: 5), "\(colorScheme): the down arrow did not move the list's selection, so the list does not have keyboard focus")
            app.typeKey(.upArrow, modifierFlags: [])
            XCTAssertTrue(WorkbenchApp.screen("text-fields", in: app).waitForExistence(timeout: 5), "\(colorScheme): the up arrow did not move the list's selection back")
            // The outline runs along the row's long edges.
            let width = Int(row.frame.width)
            let focused = outline { $0 >= width }
            XCTAssertGreaterThanOrEqual(focused, width, "\(colorScheme): with the list focused, \(focused) pixels of the selected row changed by 3:1")
            field.click()
            let left = outline { $0 == 0 }
            XCTAssertEqual(left, 0, "\(colorScheme): with the text field focused, \(left) pixels of the selected row still differ by 3:1")
        }
    }
    #endif

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
    ///
    /// An audit that XCTest gives up on for taking too long, as on a busy CI
    /// simulator, runs once more in a new launch of the app, with a note
    /// attached; running it again in the same launch lost the test runner.
    /// The issues the unfinished audit reported are dropped, so each issue is
    /// reported once, from a finished audit. A second timeout fails the test.
    private func audit(
        _ screen: String?,
        prepare: (XCUIApplication) -> Void = { _ in },
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        for colorScheme in ["light", "dark"] {
            try XCTContext.runActivity(named: "Audit \(screen ?? "the screen list") in \(colorScheme)") { _ in
                for attempt in 1...2 {
                    let app = WorkbenchApp.launch(screen: screen, colorScheme: colorScheme)
                    defer { app.terminate() }
                    do {
                        return try audit(app, screen: screen, colorScheme: colorScheme, prepare: prepare, file: file, line: line)
                    } catch let error as NSError where attempt == 1 && error.domain == "com.apple.xcode.xctest.accessibilityAudit" && error.code == -56 {
                        let note = XCTAttachment(string: "\(error)")
                        note.name = "The audit did not complete in time, so it runs once more in a new launch"
                        note.lifetime = .keepAlways
                        XCTContext.runActivity(named: "Audit timed out; running it once more in a new launch") { $0.add(note) }
                    }
                }
            }
        }
    }

    /// Audits `screen`, or the list of screens when nil, in the launched app.
    private func audit(
        _ app: XCUIApplication,
        screen: String?,
        colorScheme: String,
        prepare: (XCUIApplication) -> Void,
        file: StaticString,
        line: UInt
    ) throws {
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

    /// Audits the app and, once the audit has finished, fails each issue no
    /// waiver matches and attaches the waived ones and the contrast evidence.
    private func auditVisibleContent(of app: XCUIApplication, screen: String?, colorScheme: String) throws {
        var failures: [String] = []
        var waived: [String] = []
        var banner: String?
        var contrastEvidence: [XCTAttachment] = []
        var context = WorkbenchAuditContext(
            screen: screen,
            colorScheme: colorScheme,
            page: screen.map { WorkbenchApp.screen($0, in: app).frame },
            window: app.windows.firstMatch.frame
        )
        #if os(macOS)
        WorkbenchApp.findFrameworkElements(of: app, for: &context)
        #endif
        #if os(iOS)
        WorkbenchApp.waitForNoNotificationBanner()
        #endif
        try app.performAccessibilityAudit { issue in
            #if os(iOS)
            // A banner that came and went during the audit leaves no trace
            // after it, so look while the audit reports each issue.
            if banner == nil, WorkbenchApp.notificationBanner.exists {
                banner = WorkbenchApp.notificationBanner.label
            }
            #endif
            var summary = "\(issue.auditType.workbenchName) on \(issue.element.map(WorkbenchApp.describe) ?? "the app")"
            var element = issue.element.map(WorkbenchAuditElement.init)
            // What the audit judged, kept with each contrast issue, waived
            // or not: the element's screenshot, what it proves of the text a
            // waiver expects, and the window's screenshot once.
            if issue.auditType == .contrast, let issueElement = issue.element, let audited = element {
                let screenshot = issueElement.screenshot()
                let expected = WorkbenchAuditWaiver.misreadText(of: audited, on: screen) ?? []
                let proof = screenshot.workbenchCGImage.flatMap { image in
                    WorkbenchTextProof(image, expected: expected, scale: audited.frame.width > 0 ? max(1, (CGFloat(image.width) / audited.frame.width).rounded()) : 1)
                }
                element?.proof = proof
                summary += " [measured: \(proof?.summary ?? "unreadable screenshot")]"
                let attachment = XCTAttachment(screenshot: screenshot)
                attachment.name = "Contrast issue: \(summary)"
                attachment.lifetime = .keepAlways
                if contrastEvidence.isEmpty {
                    let window = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
                    window.name = "The window when the audit reported contrast"
                    window.lifetime = .keepAlways
                    contrastEvidence.append(window)
                }
                contrastEvidence.append(attachment)
            }
            var waiver = WorkbenchAuditWaiver.matching(issue.auditType.workbenchName, on: element, in: context)
            #if os(macOS)
            // The audit can change the window, as by focusing a field, which
            // fills the Touch Bar; look again before failing the issue.
            if waiver == nil {
                WorkbenchApp.findFrameworkElements(of: app, for: &context)
                waiver = WorkbenchAuditWaiver.matching(issue.auditType.workbenchName, on: element, in: context)
            }
            #endif
            if let waiver {
                waived.append("\(summary): \(waiver.reason)")
            } else {
                // Recorded here, with the element, rather than by the audit,
                // whose failure names only the audit type.
                failures.append("\(screen ?? "screen list") (\(colorScheme)): \(summary): \(issue.compactDescription). \(issue.detailedDescription)")
            }
            return true
        }
        failures.forEach { XCTFail($0) }
        #if os(iOS)
        if banner == nil, WorkbenchApp.notificationBanner.exists {
            banner = WorkbenchApp.notificationBanner.label
        }
        XCTAssertNil(banner, "\(screen ?? "screen list") (\(colorScheme)): a notification banner covered the app during the audit, so the issues above may be its")
        #endif
        if !contrastEvidence.isEmpty {
            XCTContext.runActivity(named: "\(contrastEvidence.count - 1) contrast issue(s)") { activity in
                contrastEvidence.forEach(activity.add)
            }
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

    /// Launches the app on `screen` in `colorScheme`, and fails the test if
    /// it shows no window.
    static func launch(screen: String?, colorScheme: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-UIFnWorkbenchColorScheme", colorScheme]
        if let screen {
            app.launchArguments += ["-UIFnWorkbenchScreen", screen]
        }
        #if os(macOS)
        // Each launch opens the app's window afresh. macOS otherwise restores
        // the windows the last launch left, and a launch that left none, as
        // one did on CI, would leave every later launch without a window.
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        #endif
        app.launch()
        #if os(macOS)
        app.activate()
        #endif
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10), "The app launched with no window", file: file, line: line)
        return app
    }

    /// Waits until no element of the window moves for half a second, so the
    /// audit does not run during a transition, such as the push to the first
    /// screen that iOS 18 animates at launch. On failure it names the
    /// elements that still moved.
    ///
    /// Progress indicators are left out: an indeterminate one moves for as
    /// long as it shows, and on iOS its frame follows the moving bar or the
    /// turning ring. A transition moves the elements around them too.
    static func waitForStillLayout(_ app: XCUIApplication, timeout: TimeInterval = 10) throws {
        /// Each element's frame, by its path in the tree.
        func frames() throws -> [String: CGRect] {
            var frames: [String: CGRect] = [:]
            func visit(_ element: XCUIElementSnapshot, path: String) {
                frames[path] = element.frame
                for (index, child) in element.children.enumerated() where child.elementType != .progressIndicator {
                    visit(child, path: "\(path)/\(child.elementType.rawValue)[\(index)]\(child.identifier.isEmpty ? "" : " id \"\(child.identifier)\"")\(child.label.isEmpty ? "" : " \"\(child.label)\"")")
                }
            }
            visit(try app.windows.firstMatch.snapshot(), path: "window")
            return frames
        }
        let deadline = Date().addingTimeInterval(timeout)
        var last = try frames()
        var moving: [String] = []
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.5)
            let current = try frames()
            moving = Set(last.keys).union(current.keys).sorted().filter { last[$0] != current[$0] }
            if moving.isEmpty { return }
            last = current
        }
        XCTFail("The window was still moving after \(Int(timeout)) seconds: \(moving.map { "\($0) at \(last[$0].map { "\($0)" } ?? "gone")" }.joined(separator: "; "))")
    }

    #if os(macOS)
    /// Sets the context's framework groups, Touch Bar items and window titles
    /// from the app's tree, or none when it cannot be read.
    static func findFrameworkElements(of app: XCUIApplication, for context: inout WorkbenchAuditContext) {
        guard let tree = try? app.snapshot() else {
            (context.frameworkGroups, context.touchBarItems, context.windowTitles) = ([], [], [])
            return
        }
        let touchBars = app.touchBars.allElementsBoundByIndex.compactMap { try? $0.snapshot() }
        (context.frameworkGroups, context.touchBarItems, context.windowTitles) = WorkbenchFrameworkElements.find(
            in: WorkbenchAuditNode(tree), touchBars: touchBars.map(WorkbenchAuditNode.init)
        )
    }
    #endif

    #if os(iOS)
    /// A SpringBoard notification banner, such as the "Ready for Apple
    /// Intelligence" one a new simulator shows a few minutes after it boots.
    static var notificationBanner: XCUIElement {
        XCUIApplication(bundleIdentifier: "com.apple.springboard").descendants(matching: .any)["NotificationShortLookView"]
    }

    /// Waits until no notification banner covers the app, so the audit sees
    /// only the app; a banner leaves after a few seconds.
    static func waitForNoNotificationBanner(timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line) {
        let banner = notificationBanner
        let deadline = Date().addingTimeInterval(timeout)
        while banner.exists && Date() < deadline {
            Thread.sleep(forTimeInterval: 1)
        }
        XCTAssertFalse(banner.exists, "A notification banner still covered the app after \(Int(timeout)) seconds: \(banner.exists ? banner.label : "")", file: file, line: line)
    }
    #endif

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

extension XCUIScreenshot {
    /// The screenshot's pixels, for measuring their colors.
    var workbenchCGImage: CGImage? {
        #if os(macOS)
        image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        #else
        image.cgImage
        #endif
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
