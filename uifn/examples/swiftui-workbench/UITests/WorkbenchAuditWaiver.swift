import CoreText
import XCTest
#if os(macOS)
import AppKit
#else
import UIKit
#endif

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
    /// For a contrast issue, what the element's screenshot shows of the text
    /// a waiver expects, or nil when it could not be read.
    var proof: WorkbenchTextProof?

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
                guard let element, element.type == .staticText, element.isEnabled, let proof = element.proof,
                      proof.expected == misreadText(of: element, on: context.screen),
                      element.identifier != context.screen.map({ WorkbenchApp.sidebarPrefix + $0 }) else { return false }
                return proof.passes
            },
            reason: "The macOS audit fails the contrast of some texts that measure well above 4.5:1, a different set from run to run, such as the unselected \"Toasts\" row (15:1) while the \"Banners\" row in the same colors passes. Only those texts are waived, and only when the issue's screenshot proves it: the test draws the expected text in the system font in the screenshot's text and background colors and fits each glyph of the screenshot to the drawing. Each glyph must be drawn at 85-115% of the text color's strength, differ from the drawing by at most 12% of its ink and lie at least three-quarters inside the screenshot, no pixel of ink may lie where no glyph is drawn, or more than 15% of the text color beyond the drawing within a pixel, or off the blend of the two colors, and the text color at the weakest glyph's strength less that difference, or at the weakest column's, must reach 4.5:1. A missing, faint, partly faint, cut-off or extra glyph, a separate mark however faint, a second color or fill, and the selected sidebar row stay failed. The proof is attached with each contrast issue."
        ),
    ]

    /// The lines, in the fonts the app draws them in, of a text the macOS
    /// audit was seen to misread on the screen, or nil for any other element:
    /// a sidebar row on any screen (13-point system font, AppKit's sidebar
    /// size), "Alerts" on the toggles and the empty state's message (UIFn's
    /// md size, 14 points), and the toast's title (md, semibold) and message
    /// (sm, 13 points).
    static func misreadText(of element: WorkbenchAuditElement, on screen: String?) -> [WorkbenchExpectedLine]? {
        switch screen {
        case _ where element.identifier.hasPrefix(WorkbenchApp.sidebarPrefix) && !element.value.isEmpty:
            [WorkbenchExpectedLine(text: element.value, points: 13)]
        case "toggles" where element.value == "Alerts", "empty-states" where element.value == "Files you add appear here.":
            [WorkbenchExpectedLine(text: element.value, points: 14)]
        case "toasts" where element.label == "Link copied" && element.value == "The link is on the clipboard.":
            [WorkbenchExpectedLine(text: element.label, points: 14, isSemibold: true), WorkbenchExpectedLine(text: element.value, points: 13)]
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

/// A line of text a waiver expects an element's screenshot to show, in the
/// system font.
struct WorkbenchExpectedLine: Equatable {
    let text: String
    let points: CGFloat
    var isSemibold = false
}

/// What an audit issue's screenshot shows of the text a waiver expects.
///
/// The background is the screenshot's most common color. Each expected line
/// is a band of rows with ink, pixels more than 3 from the background in a
/// channel; a line too faint for that leaves too few bands. The line's text
/// color is its pixel farthest from the background, and each pixel's ink is
/// how far it lies from the background toward that color, so ink however
/// faint counts for what it is. The test draws the expected line in the
/// system font in those two colors, smoothed as AppKit draws text, at eight
/// horizontal and two vertical sub-pixel offsets, and places each drawing
/// where it differs least from the band. Each glyph's columns, out to halfway
/// to its neighbors' ink, are fitted to whichever drawing and offset suits them
/// best: the glyph's strength, the share of the text color that scales the
/// drawing to the screenshot, must be 85-115%, and what still differs, its
/// misfit, at most 12% of its ink, and at most a quarter of its drawn ink may
/// fall outside the screenshot, as where a glyph overhangs the element's
/// frame. So a missing, faint, invisible, partly faint or cut-off glyph, or a
/// mark beside one, fails. A pixel of ink where the glyph's fitted drawing
/// has none within a pixel, or more than 15% of the text color beyond the
/// most it has there, is stray and fails, so a separate mark fails however
/// faint, as does any pixel that is not a blend of the two colors, such as a
/// second color or a fill. The text color at the weakest glyph's strength
/// less its misfit, and at the strength of the weakest column a drawing inks
/// fully, must reach 4.5:1, so text mostly in a failing color fails whatever
/// darker pixels it holds, and weaker columns are not averaged away.
struct WorkbenchTextProof {
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

        /// The color `share` of the way from this color to `other`.
        func blend(toward other: RGB, _ share: Double) -> RGB {
            func mix(_ a: UInt8, _ b: UInt8) -> UInt8 { UInt8((Double(a) + share * (Double(b) - Double(a))).rounded()) }
            return RGB(red: mix(red, other.red), green: mix(green, other.green), blue: mix(blue, other.blue))
        }

        func offset(from other: RGB) -> [Double] { [Double(red) - Double(other.red), Double(green) - Double(other.green), Double(blue) - Double(other.blue)] }

        var description: String { "rgb(\(red), \(green), \(blue))" }
    }

    /// How a glyph of the screenshot compares with the drawing of it.
    struct Glyph {
        /// The share of the text color that best scales the drawing to the
        /// screenshot.
        let strength: Double
        /// How far the screenshot differs from the scaled drawing, as a share
        /// of its ink.
        let misfit: Double
        /// The share of the drawing's ink that falls outside the screenshot,
        /// as of a glyph overhanging the element's frame.
        let clipped: Double
    }

    struct Line {
        let expected: WorkbenchExpectedLine
        let rows: ClosedRange<Int>
        let text: RGB
        /// The farthest any pixel of the line lies from a blend of the text
        /// color and the background.
        let offBlend: Double
        let glyphs: [Glyph]
        /// Pixels of ink the fitted glyphs do not explain.
        let stray: Int
        /// The strength of the weakest column a glyph's drawing inks fully.
        let weakestColumn: Double
        /// The text color's contrast at the weakest glyph's strength less
        /// its misfit, or the weakest column's strength if lower.
        let contrast: Double

        var passes: Bool {
            offBlend <= 16 && stray == 0 && !glyphs.isEmpty
                && glyphs.allSatisfy { (0.85...1.15).contains($0.strength) && $0.misfit <= 0.12 && $0.clipped <= 0.25 } && contrast >= 4.5
        }
    }

    let expected: [WorkbenchExpectedLine]
    let background: RGB
    let backgroundShare: Double
    /// The bands of rows with ink.
    let bands: [ClosedRange<Int>]
    let lines: [Line]

    var passes: Bool {
        !expected.isEmpty && backgroundShare >= 0.5 && bands.count == expected.count && lines.allSatisfy(\.passes)
    }

    var summary: String {
        let head = "background \(background.description) (\(Int((backgroundShare * 100).rounded()))%), \(bands.count) band(s) of ink"
        guard !expected.isEmpty else { return "\(head); no text expected, not proven" }
        guard bands.count == expected.count else { return "\(head) for \(expected.count) expected line(s); not proven" }
        let measured = lines.map { line in
            let strengths = line.glyphs.map(\.strength), misfits = line.glyphs.map(\.misfit)
            let ink = line.glyphs.isEmpty ? "no glyphs" : "glyph strength \(Self.percent(strengths.min() ?? 0))-\(Self.percent(strengths.max() ?? 0)), misfit up to \(Self.percent(misfits.max() ?? 0))"
            return "\"\(line.expected.text)\" rows \(line.rows.lowerBound)-\(line.rows.upperBound) in \(line.text.description), \(ink), weakest column \(Self.percent(line.weakestColumn)), \(line.stray) stray pixel(s), \(String(format: "%.1f", line.offBlend)) off the blend, up to \(Self.percent(line.glyphs.map(\.clipped).max() ?? 0)) of a glyph clipped, \(String(format: "%.2f", line.contrast)):1"
        }
        return "\(head): \(measured.joined(separator: "; ")); \(passes ? "every glyph shown reaches 4.5:1" : "not proven")"
    }

    /// A share as a whole percentage, or "no fit" for a glyph with no
    /// columns in the screenshot, whose misfit is infinite.
    static func percent(_ share: Double) -> String {
        share.isFinite ? "\(Int((share * 100).rounded()))%" : "no fit"
    }

    init?(_ image: CGImage, expected: [WorkbenchExpectedLine], scale: CGFloat = 1) {
        guard let pixels = Self.pixels(of: image) else { return nil }
        self.init(pixels: pixels, width: image.width, expected: expected, scale: scale)
    }

    /// The image's pixels in sRGB, in rows, top row first.
    static func pixels(of image: CGImage) -> [RGB]? {
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
        return drawn ? stride(from: 0, to: bytes.count, by: 4).map { RGB(red: bytes[$0], green: bytes[$0 + 1], blue: bytes[$0 + 2]) } : nil
    }

    /// Proves pixels in rows of `width`, top row first.
    init?(pixels: [RGB], width: Int, expected: [WorkbenchExpectedLine], scale: CGFloat = 1) {
        guard width > 0, !pixels.isEmpty, pixels.count % width == 0 else { return nil }
        let height = pixels.count / width
        var counts: [RGB: Int] = [:]
        pixels.forEach { counts[$0, default: 0] += 1 }
        guard let background = counts.max(by: { $0.value < $1.value || ($0.value == $1.value && $0.key.luminance < $1.key.luminance) })?.key else { return nil }
        self.expected = expected
        self.background = background
        backgroundShare = Double(pixels.filter { $0.offset(from: background).allSatisfy { abs($0) <= 2 } }.count) / Double(pixels.count)
        var bands: [ClosedRange<Int>] = []
        for row in 0..<height where (0..<width).contains(where: { x in pixels[row * width + x].offset(from: background).contains { abs($0) > 3 } }) {
            if let last = bands.last, last.upperBound == row - 1 {
                bands[bands.count - 1] = last.lowerBound...row
            } else {
                bands.append(row...row)
            }
        }
        self.bands = bands
        lines = bands.count == expected.count
            ? zip(bands, expected).map { Self.line($1, in: $0, of: pixels, width: width, background: background, scale: scale) }
            : []
    }

    /// The share of the way from `background` toward `text` that `pixel`
    /// lies, and how far it lies from that line.
    private static func ink(_ pixel: RGB, background: RGB, text: RGB) -> (share: Double, off: Double) {
        let toward = text.offset(from: background)
        let offset = pixel.offset(from: background)
        let length = toward.map { $0 * $0 }.reduce(0, +)
        let share = length == 0 ? 0 : min(max(zip(offset, toward).map(*).reduce(0, +) / length, 0), 1)
        let off = zip(offset, toward).map { ($0 - share * $1) * ($0 - share * $1) }.reduce(0, +).squareRoot()
        return (share, off)
    }

    private struct Drawing {
        let width: Int
        let height: Int
        let ink: [Double]
        /// Each glyph's ink, from its left edge to its right, in columns.
        let glyphs: [ClosedRange<Double>]
    }

    /// The line drawn in the system font, smoothed as AppKit draws text, in
    /// `text` on `background`, offset by a fraction of a pixel.
    private static func drawing(of line: WorkbenchExpectedLine, scale: CGFloat, text: RGB, background: RGB, offset: CGPoint) -> Drawing? {
        #if os(macOS)
        let font = NSFont.systemFont(ofSize: line.points * scale, weight: line.isSemibold ? .semibold : .regular)
        #else
        let font = UIFont.systemFont(ofSize: line.points * scale, weight: line.isSemibold ? .semibold : .regular)
        #endif
        func cgColor(_ color: RGB) -> CGColor {
            CGColor(srgbRed: CGFloat(color.red) / 255, green: CGFloat(color.green) / 255, blue: CGFloat(color.blue) / 255, alpha: 1)
        }
        let attributes = [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): cgColor(text)] as [NSAttributedString.Key: Any]
        let ctLine = CTLineCreateWithAttributedString(NSAttributedString(string: line.text, attributes: attributes))
        let bounds = CTLineGetBoundsWithOptions(ctLine, .useGlyphPathBounds)
        let (width, height) = (Int(bounds.width.rounded(.up)) + 4, Int(bounds.height.rounded(.up)) + 4)
        guard !bounds.isEmpty, let sRGB = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let origin = CGPoint(x: 2 - bounds.minX + offset.x, y: 2 - bounds.minY + offset.y)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(
                data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                space: sRGB, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
            ) else { return false }
            context.setFillColor(cgColor(background))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.setAllowsFontSmoothing(true)
            context.setShouldSmoothFonts(true)
            context.textPosition = origin
            CTLineDraw(ctLine, context)
            return true
        }
        guard drawn else { return nil }
        var glyphs: [ClosedRange<Double>] = []
        for run in CTLineGetGlyphRuns(ctLine) as? [CTRun] ?? [] {
            let count = CTRunGetGlyphCount(run)
            var ids = [CGGlyph](repeating: 0, count: count)
            var positions = [CGPoint](repeating: .zero, count: count)
            var boxes = [CGRect](repeating: .zero, count: count)
            CTRunGetGlyphs(run, CFRange(location: 0, length: count), &ids)
            CTRunGetPositions(run, CFRange(location: 0, length: count), &positions)
            let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName as String].map { $0 as! CTFont } ?? (font as CTFont)
            CTFontGetBoundingRectsForGlyphs(runFont, .default, ids, &boxes, count)
            for index in 0..<count where !boxes[index].isEmpty {
                let left = Double(origin.x + positions[index].x + boxes[index].minX)
                glyphs.append(left...(left + Double(boxes[index].width)))
            }
        }
        let ink = stride(from: 0, to: bytes.count, by: 4).map {
            Self.ink(RGB(red: bytes[$0], green: bytes[$0 + 1], blue: bytes[$0 + 2]), background: background, text: text).share
        }
        return Drawing(width: width, height: height, ink: ink, glyphs: glyphs)
    }

    private static func line(_ expected: WorkbenchExpectedLine, in rows: ClosedRange<Int>, of pixels: [RGB], width: Int, background: RGB, scale: CGFloat) -> Line {
        let height = pixels.count / width
        let distance = { (pixel: RGB) in pixel.offset(from: background).map { $0 * $0 }.reduce(0, +) }
        let text = rows.flatMap { row in (0..<width).map { pixels[row * width + $0] } }.max { distance($0) < distance($1) } ?? background
        var ink = [Double](repeating: 0, count: pixels.count)
        var offBlend = 0.0
        for row in rows {
            for x in 0..<width {
                let measured = Self.ink(pixels[row * width + x], background: background, text: text)
                ink[row * width + x] = measured.share
                offBlend = max(offBlend, measured.off)
            }
        }
        func centroid(_ ink: [Double], width: Int) -> CGPoint {
            var (sum, x, y) = (0.0, 0.0, 0.0)
            for (index, share) in ink.enumerated() {
                sum += share
                x += share * Double(index % width)
                y += share * Double(index / width)
            }
            return sum == 0 ? .zero : CGPoint(x: x / sum, y: y / sum)
        }
        let center = centroid(ink, width: width)
        // The drawing, and where it lies in the screenshot, that differs least from the line.
        var best: (difference: Double, drawing: Drawing, dx: Int, dy: Int)?
        var placed: [(drawing: Drawing, dx: Int, dy: Int)] = []
        for step in 0..<16 {
            guard let drawing = drawing(of: expected, scale: scale, text: text, background: background, offset: CGPoint(x: CGFloat(step % 8) / 8, y: CGFloat(step / 8) / 2)) else { continue }
            let drawn = centroid(drawing.ink, width: drawing.width)
            let (dx0, dy0) = (Int((center.x - drawn.x).rounded()), Int((center.y - drawn.y).rounded()))
            var bestHere: (difference: Double, dx: Int, dy: Int)?
            for dx in dx0 - 1...dx0 + 1 {
                for dy in dy0 - 1...dy0 + 1 {
                    // The line's ink against the drawing's, and the drawing's
                    // ink that falls outside the line.
                    var difference = 0.0
                    ink.withUnsafeBufferPointer { shown in
                        drawing.ink.withUnsafeBufferPointer { drawn in
                            for y in 0..<drawing.height {
                                let inLine = rows.contains(y + dy)
                                for x in 0..<drawing.width {
                                    let share = drawn[y * drawing.width + x]
                                    let px = x + dx
                                    if inLine && px >= 0 && px < width {
                                        difference += abs(shown[(y + dy) * width + px] - share) - shown[(y + dy) * width + px]
                                    } else {
                                        difference += share
                                    }
                                }
                            }
                            for index in rows.lowerBound * width..<(rows.upperBound + 1) * width { difference += shown[index] }
                        }
                    }
                    if bestHere.map({ difference < $0.difference }) ?? true { bestHere = (difference, dx, dy) }
                }
            }
            if let bestHere {
                placed.append((drawing, bestHere.dx, bestHere.dy))
                if best.map({ bestHere.difference < $0.difference }) ?? true { best = (bestHere.difference, drawing, bestHere.dx, bestHere.dy) }
            }
        }
        guard let best else { return Line(expected: expected, rows: rows, text: text, offBlend: offBlend, glyphs: [], stray: 0, weakestColumn: 0, contrast: 1) }
        let glyphs = best.drawing.glyphs.map { ($0.lowerBound + Double(best.dx))...($0.upperBound + Double(best.dx)) }
        var cuts = [-Double.infinity]
        for index in glyphs.indices.dropFirst() { cuts.append((glyphs[index - 1].upperBound + glyphs[index].lowerBound) / 2) }
        cuts.append(.infinity)
        // The share of each glyph's drawn ink that lies outside the
        // screenshot, on either axis.
        var drawnInk = [Double](repeating: 0, count: glyphs.count)
        var cropped = [Double](repeating: 0, count: glyphs.count)
        for y in 0..<best.drawing.height {
            for x in 0..<best.drawing.width {
                let (px, py) = (x + best.dx, y + best.dy)
                guard let index = glyphs.indices.first(where: { (cuts[$0]..<cuts[$0 + 1]).contains(Double(px) + 0.5) }) else { continue }
                drawnInk[index] += best.drawing.ink[y * best.drawing.width + x]
                if !(0..<width).contains(px) || !(0..<height).contains(py) { cropped[index] += best.drawing.ink[y * best.drawing.width + x] }
            }
        }
        // Each glyph's columns, scaled against whichever drawing and offset
        // fits them best: the strength that scales the drawing to the
        // screenshot, and how far the screenshot still differs from it.
        let fits = glyphs.indices.map { index -> (fit: Glyph, columns: [Int], model: (drawing: Drawing, dx: Int, dy: Int)?) in
            let columns = (0..<width).filter { (cuts[index]..<cuts[index + 1]).contains(Double($0) + 0.5) }
            let clipped = drawnInk[index] > 0 ? cropped[index] / drawnInk[index] : 1
            var fit = Glyph(strength: 0, misfit: .infinity, clipped: clipped)
            var model: (drawing: Drawing, dx: Int, dy: Int)?
            for (drawing, dx0, dy) in placed {
                for dx in dx0 - 1...dx0 + 1 {
                    var pairs: [(shown: Double, drawn: Double)] = []
                    for y in 0..<height {
                        for x in columns {
                            let (rx, ry) = (x - dx, y - dy)
                            pairs.append((ink[y * width + x], (0..<drawing.width).contains(rx) && (0..<drawing.height).contains(ry) ? drawing.ink[ry * drawing.width + rx] : 0))
                        }
                    }
                    let squares = pairs.map { $0.drawn * $0.drawn }.reduce(0, +)
                    guard squares > 0 else { continue }
                    let strength = pairs.map { $0.shown * $0.drawn }.reduce(0, +) / squares
                    let misfit = pairs.map { abs($0.shown - strength * $0.drawn) }.reduce(0, +) / max(strength * pairs.map(\.drawn).reduce(0, +), 0.5)
                    if misfit < fit.misfit { (fit, model) = (Glyph(strength: strength, misfit: misfit, clipped: clipped), (drawing, dx, dy)) }
                }
            }
            return (fit, columns, model)
        }
        // Each pixel of ink against its glyph's fitted drawing: ink no glyph
        // draws within a pixel, or more than 0.15 of the text color beyond
        // the most the drawing puts within a pixel, is stray, as a separate
        // mark is however faint. Each column the drawing inks fully is
        // scaled on its own, so weaker parts of a glyph count for what they are.
        var stray = 0
        var weakestColumn = 1.0
        for (fit, columns, model) in fits {
            guard let (drawing, dx, dy) = model else { continue }
            func drawn(_ x: Int, _ y: Int) -> Double {
                let (rx, ry) = (x - dx, y - dy)
                return (0..<drawing.width).contains(rx) && (0..<drawing.height).contains(ry) ? drawing.ink[ry * drawing.width + rx] : 0
            }
            for x in columns {
                var (product, squares, total) = (0.0, 0.0, 0.0)
                for y in 0..<height {
                    let d = drawn(x, y)
                    (product, squares, total) = (product + ink[y * width + x] * d, squares + d * d, total + d)
                    guard rows.contains(y), pixels[y * width + x].offset(from: background).contains(where: { abs($0) > 3 }) else { continue }
                    let near = (y - 1...y + 1).flatMap { ny in (x - 1...x + 1).map { drawn($0, ny) } }.max() ?? 0
                    if near < 0.02 || ink[y * width + x] - fit.strength * near > 0.15 { stray += 1 }
                }
                if total >= 1 { weakestColumn = min(weakestColumn, product / squares) }
            }
        }
        let weakest = min(fits.map { min($0.fit.strength, 1) - $0.fit.misfit }.min() ?? 0, weakestColumn)
        return Line(
            expected: expected, rows: rows, text: text, offBlend: offBlend, glyphs: fits.map(\.fit), stray: stray, weakestColumn: weakestColumn,
            contrast: background.blend(toward: text, max(weakest, 0)).contrast(with: background)
        )
    }
}
