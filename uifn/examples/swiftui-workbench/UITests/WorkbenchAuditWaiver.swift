import XCTest

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
    /// For a contrast issue, the colors measured from the element's
    /// screenshot, or nil when it could not be read.
    var contrast: WorkbenchContrastMeasurement?

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
            reason: "AppKit draws the window's title in its toolbar in its own colors (light text at 15.7:1 on the dark toolbar). The title's screenshot spans the toolbar with its separator and the window's rounded corner, so the screenshot measurement cannot single out the text. Only a text that is a child of the window or its toolbar is waived, and not one whose type and frame an element of the app's own shares."
        ),
        WorkbenchAuditWaiver(
            id: "macos-contrast-misread",
            screens: [],
            platform: .macOS,
            auditTypes: ["contrast"],
            element: { element, context in
                // The selected sidebar row is never waived.
                guard let element, element.type == .staticText, element.isEnabled, let contrast = element.contrast,
                      let lines = misreadLines(of: element, on: context.screen),
                      element.identifier != context.screen.map({ WorkbenchApp.sidebarPrefix + $0 }) else { return false }
                return contrast.passes && contrast.lines.count == lines
            },
            reason: "The macOS audit fails the contrast of some texts that measure well above 4.5:1, a different set from run to run, such as the unselected \"Toasts\" row (8.5:1) while the \"Banners\" row in the same colors passes. Only those texts are waived, and only when the test measures the issue's screenshot: one color covers at least half of it, every glyph run on every line reaches 4.5:1 against it by the color a quarter of the run's ink reaches, and it shows as many lines as the text draws, so a line too faint to measure keeps the issue failed. A fill behind text, a failing run and the selected sidebar row stay failed. The measurement is attached with each contrast issue."
        ),
    ]

    /// The lines of text drawn by a text the macOS audit was seen to misread
    /// on the screen, or nil for any other element: a sidebar row on any
    /// screen, "Alerts" on the toggles, the empty state's message and the
    /// toast's title and message.
    static func misreadLines(of element: WorkbenchAuditElement, on screen: String?) -> Int? {
        switch screen {
        case _ where element.identifier.hasPrefix(WorkbenchApp.sidebarPrefix): 1
        case "toggles" where element.value == "Alerts": 1
        case "empty-states" where element.value == "Files you add appear here.": 1
        case "toasts" where element.label == "Link copied": 2
        default: nil
        }
    }

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

/// The contrast of the text in an audit issue's element, measured from the
/// element's screenshot. The background is its most common color; every
/// pixel further than 3 from it in any channel is ink, however faint. Ink
/// forms lines (bands of rows) and, on each line, runs (columns with ink
/// between columns without: a glyph or a few touching glyphs). A run's text
/// color is the color a quarter of its ink reaches. Edge pixels blend toward
/// the background, so a run drawn in one color measures at most that color's
/// contrast, and a run in a second color is measured on its own. It cannot
/// tell apart two colors within one run, nor see text within 3 of the
/// background, so ``WorkbenchAuditWaiver/misreadLines(of:on:)`` also checks
/// that it found every line the element draws.
struct WorkbenchContrastMeasurement {
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

        func isClose(to other: RGB) -> Bool {
            max(abs(Int(red) - Int(other.red)), abs(Int(green) - Int(other.green)), abs(Int(blue) - Int(other.blue))) <= 3
        }

        var description: String { "rgb(\(red), \(green), \(blue))" }
    }

    /// A run of columns with ink on a line, a glyph or a few touching
    /// glyphs, measured on its own so that a second color on the line is
    /// measured as its own run.
    struct Run {
        let columns: ClosedRange<Int>
        let ink: Int
        /// The color a quarter of the run's ink reaches.
        let text: RGB
        let contrast: Double
        /// The share of the run's ink that is not a blend of the text color
        /// and the background, such as a second color.
        let otherColorShare: Double
        /// The share of the run's box its ink covers.
        let coverage: Double
        /// Whether the run is a fill behind text rather than text: as wide
        /// as it is tall and mostly covered. A thin glyph such as "l" covers
        /// its narrow box too.
        let isAFill: Bool

        var passes: Bool { contrast >= 4.5 && otherColorShare <= 0.15 && !isAFill }
    }

    /// A band of rows with ink, between rows without.
    struct Line {
        let rows: ClosedRange<Int>
        let runs: [Run]

        var passes: Bool { !runs.isEmpty && runs.allSatisfy(\.passes) }
        /// The failing run, or else the run of lowest contrast.
        var weakest: Run? { runs.first { !$0.passes } ?? runs.min { $0.contrast < $1.contrast } }
    }

    let background: RGB
    let backgroundShare: Double
    let lines: [Line]
    /// Rows of ink one or two pixels tall that span the crop, such as a
    /// separator, which are not text.
    let rules: [ClosedRange<Int>]

    /// Whether every run of every line of text on the one background reaches
    /// 4.5:1.
    var passes: Bool { backgroundShare >= 0.5 && !lines.isEmpty && lines.allSatisfy(\.passes) }

    var summary: String {
        let measured = lines.map { line in
            let weakest = line.weakest.map { run in
                "weakest run at columns \(run.columns.lowerBound)-\(run.columns.upperBound): \(run.text.description) \(String(format: "%.2f", run.contrast)):1, \(Int((run.otherColorShare * 100).rounded()))% other colors, \(Int((run.coverage * 100).rounded()))% filled"
            } ?? "no runs"
            return "rows \(line.rows.lowerBound)-\(line.rows.upperBound), \(line.runs.count) run(s), \(weakest)"
        }
        let ruled = rules.isEmpty ? "" : "; separators at rows \(rules.map { "\($0.lowerBound)-\($0.upperBound)" }.joined(separator: ", "))"
        return "background \(background.description) (\(Int((backgroundShare * 100).rounded()))%), \(lines.count) line(s): \(measured.joined(separator: "; "))\(ruled); \(passes ? "every run reaches 4.5:1" : "not shown to reach 4.5:1")"
    }

    init?(_ image: CGImage) {
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
        guard drawn else { return nil }
        let pixels = stride(from: 0, to: bytes.count, by: 4).map { RGB(red: bytes[$0], green: bytes[$0 + 1], blue: bytes[$0 + 2]) }
        self.init(pixels: pixels, width: width)
    }

    /// Measures pixels in rows of `width`, top row first. Every pixel that
    /// is not close to the background is ink, however faint, so faint text
    /// is measured rather than dropped.
    init?(pixels: [RGB], width: Int) {
        guard width > 0, !pixels.isEmpty, pixels.count % width == 0 else { return nil }
        let height = pixels.count / width
        var counts: [RGB: Int] = [:]
        pixels.forEach { counts[$0, default: 0] += 1 }
        guard let background = counts.max(by: { $0.value < $1.value || ($0.value == $1.value && $0.key.luminance < $1.key.luminance) })?.key else { return nil }
        self.background = background
        backgroundShare = Double(pixels.filter { $0.isClose(to: background) }.count) / Double(pixels.count)

        let isInk = { (x: Int, y: Int) in !pixels[y * width + x].isClose(to: background) }
        var bands: [ClosedRange<Int>] = []
        for row in 0..<height where (0..<width).contains(where: { isInk($0, row) }) {
            if let last = bands.last, last.upperBound == row - 1 {
                bands[bands.count - 1] = last.lowerBound...row
            } else {
                bands.append(row...row)
            }
        }
        var lines: [Line] = []
        var rules: [ClosedRange<Int>] = []
        for band in bands {
            let inkColumns = (0..<width).filter { x in band.contains { isInk(x, $0) } }
            if band.count <= 2 && Double(inkColumns.count) >= 0.8 * Double(width) {
                rules.append(band)
                continue
            }
            // Columns with ink, split at columns without.
            var groups: [ClosedRange<Int>] = []
            for x in inkColumns {
                if let last = groups.last, last.upperBound == x - 1 {
                    groups[groups.count - 1] = last.lowerBound...x
                } else {
                    groups.append(x...x)
                }
            }
            let inkIn = { (columns: ClosedRange<Int>) in columns.flatMap { x in band.filter { isInk(x, $0) }.map { pixels[$0 * width + x] } } }
            lines.append(Line(rows: band, runs: groups.map { Self.run($0, ink: inkIn($0), rows: band.count, background: background) }))
        }
        self.lines = lines
        self.rules = rules
    }

    private static func run(_ columns: ClosedRange<Int>, ink: [RGB], rows: Int, background: RGB) -> Run {
        let text = ink.sorted { $0.contrast(with: background) > $1.contrast(with: background) }[ink.count / 4]
        // A blend of the text color and the background lies on the line
        // between them in RGB.
        let direction = [Double(text.red) - Double(background.red), Double(text.green) - Double(background.green), Double(text.blue) - Double(background.blue)]
        let length = (direction.map { $0 * $0 }.reduce(0, +)).squareRoot()
        let others = ink.filter { pixel in
            let offset = [Double(pixel.red) - Double(background.red), Double(pixel.green) - Double(background.green), Double(pixel.blue) - Double(background.blue)]
            let along = zip(offset, direction).map(*).reduce(0, +) / max(length, 1)
            let squared = offset.map { $0 * $0 }.reduce(0, +) - along * along
            return max(squared, 0).squareRoot() > 32
        }
        return Run(
            columns: columns, ink: ink.count, text: text, contrast: text.contrast(with: background),
            otherColorShare: Double(others.count) / Double(ink.count), coverage: Double(ink.count) / Double(columns.count * rows),
            isAFill: columns.count >= rows && ink.count * 4 > columns.count * rows * 3
        )
    }
}
