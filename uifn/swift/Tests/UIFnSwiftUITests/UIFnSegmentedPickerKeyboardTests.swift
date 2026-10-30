#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import UIFnSwiftUI

extension UIFnHostedWindowTests {
    /// On macOS a UIFn segmented picker is one focusable control whose left
    /// and right arrows select the option beside the selected one, in the
    /// layout's reading direction, and a click on a segment selects it.
    ///
    /// Each test shows a key window and sends it events, so the suite runs
    /// inside ``UIFnHostedWindowTests``, one test at a time.
    @MainActor @Suite
    struct UIFnSegmentedPickerKeyboardTests {
        private static let options = ["Day", "Week", "Month"]

        /// The picker's selection, how many times it was set, and whether
        /// the picker has focus.
        @MainActor
        private final class Box: ObservableObject {
            @Published var selection: String
            @Published var isFocused = false
            var writes = 0

            init(_ selection: String) {
                self.selection = selection
            }

            var binding: Binding<String> {
                Binding(get: { self.selection }, set: { self.selection = $0; self.writes += 1 })
            }
        }

        private struct Options {
            var variant = UIFnSegmentedPickerVariant.tabs
            var layoutDirection = LayoutDirection.leftToRight
            var isEnabled = true
            /// Whether the picker, rather than a text field beside it, is focused.
            var focusesPicker = true
        }

        /// Where the picker sits in the window's content, from its top-leading corner.
        private static let inset: CGFloat = 20

        private struct Host: View {
            @ObservedObject var box: Box
            let options: Options
            @FocusState private var focus: Field?

            enum Field {
                case picker, text
            }

            var body: some View {
                VStack(alignment: .leading, spacing: 20) {
                    UIFnSegmentedPicker("Range", selection: box.binding, options: UIFnSegmentedPickerKeyboardTests.options, variant: options.variant) {
                        Text($0)
                    }
                    .fixedSize()
                    .focused($focus, equals: .picker)
                    .disabled(!options.isEnabled)
                    TextField("Note", text: .constant("")).focused($focus, equals: .text).frame(width: 120)
                }
                .padding(UIFnSegmentedPickerKeyboardTests.inset)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .environment(\.layoutDirection, options.layoutDirection)
                .onChange(of: focus) { box.isFocused = $0 == .picker }
                .onAppear { focus = options.focusesPicker ? .picker : .text }
            }
        }

        private func makeWindow(_ box: Box, _ options: Options) -> UIFnHostedWindowTests.Window {
            let window = UIFnHostedWindowTests.Window(width: 360, height: 140)
            window.contentView = NSHostingView(rootView: Host(box: box, options: options))
            window.makeKeyAndOrderFront(nil)
            window.contentView?.layoutSubtreeIfNeeded()
            return window
        }

        /// Waits until `condition` holds, for up to a second.
        private func eventually(_ condition: () -> Bool) async throws -> Bool {
            for _ in 0..<50 {
                if condition() { return true }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            return condition()
        }

        private enum Arrow {
            case left, right

            var keyCode: UInt16 { self == .left ? 123 : 124 }
            var character: String {
                String(Character(UnicodeScalar(self == .left ? NSLeftArrowFunctionKey : NSRightArrowFunctionKey)!))
            }
        }

        /// Presses an arrow key in the window and lets SwiftUI apply it.
        private func press(_ arrow: Arrow, in window: NSWindow) async throws {
            for type in [NSEvent.EventType.keyDown, .keyUp] {
                let event = try #require(NSEvent.keyEvent(
                    with: type,
                    location: .zero,
                    modifierFlags: [.numericPad, .function],
                    timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber,
                    context: nil,
                    characters: arrow.character,
                    charactersIgnoringModifiers: arrow.character,
                    isARepeat: false,
                    keyCode: arrow.keyCode
                ))
                window.sendEvent(event)
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        /// Presses each arrow in turn and returns the selection after each.
        private func selections(after arrows: [Arrow], from start: String, _ options: Options = Options()) async throws -> (selections: [String], writes: Int, box: Box) {
            let box = Box(start)
            let window = makeWindow(box, options)
            defer { window.close() }
            if options.focusesPicker && options.isEnabled {
                try #require(try await eventually { box.isFocused })
            } else {
                // Give focus time to settle where it goes.
                try await Task.sleep(nanoseconds: 200_000_000)
            }
            var selections: [String] = []
            for arrow in arrows {
                try await press(arrow, in: window)
                selections.append(box.selection)
            }
            return (selections, box.writes, box)
        }

        @Test(arguments: UIFnSegmentedPickerVariant.allCases)
        func arrowsSelectTheNeighboringOptionAndStopAtTheEnds(_ variant: UIFnSegmentedPickerVariant) async throws {
            var options = Options()
            options.variant = variant
            let result = try await selections(after: [.right, .right, .left, .left, .left], from: "Week", options)
            #expect(result.selections == ["Month", "Month", "Week", "Day", "Day"])
            // An arrow at an end sets nothing.
            #expect(result.writes == 3)
        }

        @Test
        func rightToLeftTheArrowsFollowTheReadingDirection() async throws {
            var options = Options()
            options.layoutDirection = .rightToLeft
            // Right to left, the first option is on the right.
            let result = try await selections(after: [.left, .left, .right, .right], from: "Day", options)
            #expect(result.selections == ["Week", "Month", "Week", "Day"])
        }

        @Test
        func withNoOptionSelectedTheArrowsSelectTheFirstOrLast() async throws {
            #expect(try await selections(after: [.right], from: "Year").selections == ["Day"])
            #expect(try await selections(after: [.left], from: "Year").selections == ["Month"])
        }

        @Test
        func anUnfocusedPickerIgnoresTheArrows() async throws {
            var options = Options()
            options.focusesPicker = false
            let result = try await selections(after: [.right, .left, .left], from: "Week", options)
            #expect(!result.box.isFocused)
            #expect(result.selections == ["Week", "Week", "Week"])
            #expect(result.writes == 0)
        }

        @Test
        func aDisabledPickerTakesNoFocusAndIgnoresTheArrows() async throws {
            var options = Options()
            options.isEnabled = false
            let result = try await selections(after: [.right, .left, .left], from: "Week", options)
            #expect(!result.box.isFocused)
            #expect(result.selections == ["Week", "Week", "Week"])
            #expect(result.writes == 0)
        }

        // MARK: - Clicks

        /// The picker's size, measured on its own.
        private func pickerSize(_ variant: UIFnSegmentedPickerVariant) -> CGSize {
            let picker = UIFnSegmentedPicker("Range", selection: .constant("Week"), options: Self.options, variant: variant) {
                Text($0)
            }
            return NSHostingView(rootView: picker.fixedSize()).fittingSize
        }

        private func click(_ window: UIFnHostedWindowTests.Window, segment index: Int, of variant: UIFnSegmentedPickerVariant) throws {
            let size = pickerSize(variant)
            let content = try #require(window.contentView)
            let segmentWidth = size.width / CGFloat(Self.options.count)
            // Window coordinates run up from the bottom.
            let point = NSPoint(
                x: Self.inset + segmentWidth * (CGFloat(index) + 0.5),
                y: content.bounds.height - Self.inset - size.height / 2
            )
            window.press([
                try UIFnHostedWindowTests.mouseEvent(.leftMouseDown, at: point, in: window),
                try UIFnHostedWindowTests.mouseEvent(.leftMouseUp, at: point, in: window),
            ])
        }

        @Test(arguments: UIFnSegmentedPickerVariant.allCases)
        func aClickOnASegmentSelectsItsOption(_ variant: UIFnSegmentedPickerVariant) async throws {
            var options = Options()
            options.variant = variant
            options.focusesPicker = false
            let box = Box("Week")
            let window = makeWindow(box, options)
            defer { window.close() }
            try click(window, segment: 2, of: variant)
            #expect(try await eventually { box.selection == "Month" })
            try click(window, segment: 0, of: variant)
            #expect(try await eventually { box.selection == "Day" })
            #expect(box.writes == 2)
        }

        @Test
        func aClickOnADisabledPickerSelectsNothing() async throws {
            var options = Options()
            options.isEnabled = false
            options.focusesPicker = false
            let box = Box("Week")
            let window = makeWindow(box, options)
            defer { window.close() }
            try click(window, segment: 2, of: options.variant)
            try await Task.sleep(nanoseconds: 200_000_000)
            #expect(box.selection == "Week")
            #expect(box.writes == 0)
        }

        // MARK: - Focus ring

        /// The picker and the room for a focus ring around it, as drawn in
        /// a window whose picker has focus or not.
        private func drawnPicker(focused: Bool, selection: String) async throws -> UIFnBitmap {
            var options = Options()
            options.focusesPicker = focused
            let box = Box(selection)
            let window = makeWindow(box, options)
            defer { window.close() }
            if focused {
                try #require(try await eventually { box.isFocused })
            }
            // Let the ring finish animating in.
            try await Task.sleep(nanoseconds: 400_000_000)
            #expect(box.isFocused == focused)
            let content = try #require(window.contentView)
            let representation = try #require(content.bitmapImageRepForCachingDisplay(in: content.bounds))
            content.cacheDisplay(in: content.bounds, to: representation)
            let bitmap = try #require(representation.cgImage)
            let size = pickerSize(options.variant)
            let scale = CGFloat(bitmap.width) / content.bounds.width
            let rect = CGRect(x: Self.inset - 8, y: Self.inset - 8, width: size.width + 16, height: size.height + 16)
                .applying(CGAffineTransform(scaleX: scale, y: scale))
                .integral
            return try #require(bitmap.cropping(to: rect).flatMap(UIFnBitmap.init))
        }

        /// The focused picker draws the style's focus ring around its
        /// selected segment, or around itself with no option selected; focus
        /// elsewhere draws none.
        @Test(arguments: ["Week", "Year"])
        func theFocusedPickerDrawsTheFocusRing(_ selection: String) async throws {
            let focused = try await drawnPicker(focused: true, selection: selection)
            let unfocused = try await drawnPicker(focused: false, selection: selection)
            #expect(focused.differingFraction(from: unfocused) > UIFnStateChange.minimumDifferingFraction)
        }
    }
}
#endif
