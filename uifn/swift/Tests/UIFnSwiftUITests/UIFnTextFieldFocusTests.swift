#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import UIFnSwiftUI

extension UIFnHostedWindowTests {
    /// The text field style tracks focus with its own `FocusState`; an app's
    /// `focused(_:)` binding around the styled field must still move focus, and
    /// so must a click anywhere inside the field the style draws. The style's
    /// focus ring must follow that real focus, with or without the binding.
    ///
    /// Each test shows a key window, so the suite runs inside
    /// ``UIFnHostedWindowTests``, one test at a time.
    @MainActor @Suite
    struct UIFnTextFieldFocusTests {
        private struct Host: View {
            let styled: Bool
            @FocusState private var isFocused: Bool

            var body: some View {
                field
                    .focused($isFocused)
                    .padding()
                    .onAppear { isFocused = true }
            }

            @ViewBuilder
            private var field: some View {
                if styled {
                    TextField("Name", text: .constant("")).textFieldStyle(.uifn)
                } else {
                    TextField("Name", text: .constant("")).textFieldStyle(.plain)
                }
            }
        }

        private func focusesTheField(styled: Bool) async throws -> Bool {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 320, height: 120),
                styleMask: [.titled],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            defer { window.close() }
            window.contentView = NSHostingView(rootView: Host(styled: styled))
            window.makeKeyAndOrderFront(nil)
            for _ in 0..<250 {
                if window.firstResponder is NSTextView { return true }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            return false
        }

        // MARK: - Clicks in the padding

        private enum ClickedField {
            case styled, disabled, roundedBorder, plain, paddedStyled
        }

        private struct ClickHost: View {
            let field: ClickedField

            var body: some View {
                switch field {
                case .styled: TextField("Name", text: .constant("Ada")).textFieldStyle(.uifn).frame(width: 260)
                case .disabled: TextField("Name", text: .constant("Ada")).textFieldStyle(.uifn).frame(width: 260).disabled(true)
                case .roundedBorder: TextField("Name", text: .constant("Ada")).textFieldStyle(.roundedBorder).frame(width: 260)
                case .plain: TextField("Name", text: .constant("Ada")).textFieldStyle(.plain).frame(width: 260).padding()
                // Room for the ring the style draws outside the field.
                case .paddedStyled: TextField("Name", text: .constant("Ada")).textFieldStyle(.uifn).frame(width: 260).padding()
                }
            }
        }

        private func makeWindow(_ field: ClickedField) -> NSWindow {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 320, height: 120),
                styleMask: [.titled],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: ClickHost(field: field))
            window.makeKeyAndOrderFront(nil)
            window.contentView?.layoutSubtreeIfNeeded()
            return window
        }

        /// The frame of the system text field in the window, in window coordinates.
        private func textFieldFrame(in window: NSWindow) throws -> NSRect {
            func find(_ view: NSView) -> NSTextField? {
                if let field = view as? NSTextField { return field }
                return view.subviews.lazy.compactMap(find).first
            }
            let field = try #require(window.contentView.flatMap(find))
            return field.convert(field.bounds, to: nil)
        }

        private func click(_ window: NSWindow, at point: NSPoint) {
            func event(_ type: NSEvent.EventType) -> NSEvent? {
                NSEvent.mouseEvent(
                    with: type,
                    location: point,
                    modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime,
                    windowNumber: window.windowNumber,
                    context: nil,
                    eventNumber: 0,
                    clickCount: 1,
                    pressure: 1
                )
            }
            guard let down = event(.leftMouseDown), let up = event(.leftMouseUp) else { return }
            window.sendEvent(down)
            window.sendEvent(up)
        }

        private func becomesFocused(_ window: NSWindow, attempts: Int = 50) async throws -> Bool {
            for _ in 0..<attempts {
                if window.firstResponder is NSTextView { return true }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            return false
        }

        /// Points in the styled field: in its left and top padding, inside the
        /// border it draws but outside the system text field, and on the text.
        private func styledFieldPoints() throws -> (padding: [NSPoint], text: NSPoint) {
            let window = makeWindow(.styled)
            defer { window.close() }
            let text = try textFieldFrame(in: window)
            let spacing = UIFnTheme.uifn.spacing
            let padding = [
                NSPoint(x: text.minX - spacing.space3 / 2, y: text.midY),
                NSPoint(x: text.midX, y: text.maxY + spacing.space2 / 2),
            ]
            return (padding, NSPoint(x: text.midX, y: text.midY))
        }

        @Test
        func aClickInThePaddingOrOnTheTextFocusesAStyledField() async throws {
            let points = try styledFieldPoints()
            // A click left of the text lands inside a rounded-border field the
            // same width, which shows clicks reach fields in this process.
            let control = makeWindow(.roundedBorder)
            defer { control.close() }
            try #require(try textFieldFrame(in: control).contains(points.padding[0]))
            click(control, at: points.padding[0])
            #expect(try await becomesFocused(control))

            for point in points.padding + [points.text] {
                let window = makeWindow(.styled)
                defer { window.close() }
                #expect(!(window.firstResponder is NSTextView))
                click(window, at: point)
                #expect(try await becomesFocused(window), "\(point)")
            }
        }

        @Test
        func aClickInThePaddingDoesNotFocusADisabledField() async throws {
            for point in try styledFieldPoints().padding {
                let window = makeWindow(.disabled)
                defer { window.close() }
                click(window, at: point)
                // An enabled field takes focus in the same turn as the click.
                #expect(!(try await becomesFocused(window, attempts: 10)), "\(point)")
            }
        }

        @Test
        func anAppFocusBindingStillFocusesAStyledField() async throws {
            // The plain field shows the window can take focus in this process.
            #expect(try await focusesTheField(styled: false))
            #expect(try await focusesTheField(styled: true))
        }

        // MARK: - The app's focus binding follows the field

        /// An app's view of its focus binding around a styled field.
        @MainActor
        private final class AppFocus: ObservableObject {
            /// The binding's value, as the host last saw it change.
            var isFocused = false
            /// A value to set the binding to.
            @Published var request: Bool?
        }

        private struct BindingHost: View {
            @ObservedObject var focus: AppFocus
            @FocusState private var isFocused: Bool

            var body: some View {
                TextField("Name", text: .constant("Ada"))
                    .textFieldStyle(.uifn)
                    .focused($isFocused)
                    .frame(width: 260)
                    .onChange(of: isFocused) { focus.isFocused = $0 }
                    .onReceive(focus.$request.compactMap { $0 }) { isFocused = $0 }
            }
        }

        private func waitUntil(_ condition: () -> Bool) async throws -> Bool {
            for _ in 0..<50 {
                if condition() { return true }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            return false
        }

        @Test
        func aClickSetsTheAppFocusBindingAndClearingItResignsTheField() async throws {
            let points = try styledFieldPoints()
            for point in points.padding + [points.text] {
                let focus = AppFocus()
                let window = NSWindow(
                    contentRect: NSRect(x: 0, y: 0, width: 320, height: 120),
                    styleMask: [.titled],
                    backing: .buffered,
                    defer: false
                )
                window.isReleasedWhenClosed = false
                defer { window.close() }
                window.contentView = NSHostingView(rootView: BindingHost(focus: focus))
                window.makeKeyAndOrderFront(nil)
                window.contentView?.layoutSubtreeIfNeeded()
                #expect(!(window.firstResponder is NSTextView))

                click(window, at: point)
                #expect(try await becomesFocused(window), "\(point)")
                #expect(try await waitUntil { focus.isFocused }, "\(point)")

                focus.request = false
                #expect(try await waitUntil { !(window.firstResponder is NSTextView) }, "\(point)")
                #expect(!focus.isFocused, "\(point)")
            }
        }

        // MARK: - The focus ring follows real focus

        /// Waits until the window has taken its content's size, which happens
        /// after the first layout, and returns the content as it draws then.
        private func settledCapture(_ window: NSWindow) async throws -> UIFnBitmap {
            let view = try #require(window.contentView)
            for _ in 0..<50 {
                view.layoutSubtreeIfNeeded()
                if view.bounds.size == view.fittingSize { break }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            try #require(view.bounds.size == view.fittingSize)
            return try capture(window)
        }

        /// The window's content as it draws.
        private func capture(_ window: NSWindow) throws -> UIFnBitmap {
            let view = try #require(window.contentView)
            view.layoutSubtreeIfNeeded()
            let rep = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: rep)
            return try #require(rep.cgImage.flatMap(UIFnBitmap.init))
        }

        /// The number of pixels outside the system text field that differ
        /// between two captures of the window. The caret, the selection and
        /// the text stay inside the system field, so only what the style draws
        /// around the field counts.
        private func changedPixelsOutsideTheText(_ lhs: UIFnBitmap, _ rhs: UIFnBitmap, in window: NSWindow) throws -> Int {
            try #require(lhs.width == rhs.width && lhs.height == rhs.height)
            let (width, height) = (lhs.width, lhs.height)
            let view = try #require(window.contentView)
            let text = view.convert(try textFieldFrame(in: window), from: nil)
            let scale = CGFloat(lhs.width) / view.bounds.width
            let top = view.isFlipped ? text.minY : view.bounds.height - text.maxY
            let excluded = (
                x: Int((text.minX * scale).rounded(.down)) - 1 ..< Int((text.maxX * scale).rounded(.up)) + 1,
                y: Int((top * scale).rounded(.down)) - 1 ..< Int(((top + text.height) * scale).rounded(.up)) + 1
            )
            return lhs.pixels.withUnsafeBufferPointer { lhs in
                rhs.pixels.withUnsafeBufferPointer { rhs in
                    var changed = 0
                    for y in 0..<height {
                        for x in 0..<width where !(excluded.x.contains(x) && excluded.y.contains(y)) {
                            let pixel = (y * width + x) * 4
                            if (pixel..<pixel + 4).contains(where: { abs(Int(lhs[$0]) - Int(rhs[$0])) > 8 }) {
                                changed += 1
                            }
                        }
                    }
                    return changed
                }
            }
        }

        /// The fewest changed pixels that count as the ring: a quarter of a
        /// 2pt ring around a 260pt-wide field, at the window's scale.
        private func ringPixels(in window: NSWindow) -> Int {
            let scale = window.backingScaleFactor
            return Int(2 * (260 + 30) * 2 * scale * scale / 4)
        }

        /// Waits until the window has drawn at least `minimum` (or, with
        /// `maximum`, at most that many) changed pixels outside the text, and
        /// returns the last count.
        private func changedPixels(
            in window: NSWindow,
            from before: UIFnBitmap,
            atLeast minimum: Int = 0,
            atMost maximum: Int = .max
        ) async throws -> Int {
            var changed = 0
            for _ in 0..<50 {
                changed = try changedPixelsOutsideTheText(before, capture(window), in: window)
                if changed >= minimum && changed <= maximum { break }
                try await Task.sleep(nanoseconds: 20_000_000)
            }
            return changed
        }

        @Test
        func aFocusedStyledFieldDrawsItsRing() async throws {
            // A plain field draws nothing around its text when it takes focus,
            // so a change there comes from the style.
            let control = makeWindow(.plain)
            defer { control.close() }
            let controlBefore = try await settledCapture(control)
            let controlText = try textFieldFrame(in: control)
            click(control, at: NSPoint(x: controlText.midX, y: controlText.midY))
            #expect(try await becomesFocused(control))
            try await Task.sleep(nanoseconds: 300_000_000)
            #expect(try changedPixelsOutsideTheText(controlBefore, capture(control), in: control) == 0)

            let window = makeWindow(.paddedStyled)
            defer { window.close() }
            let before = try await settledCapture(window)
            let text = try textFieldFrame(in: window)
            click(window, at: NSPoint(x: text.midX, y: text.midY))
            #expect(try await becomesFocused(window))
            let minimum = ringPixels(in: window)
            let changed = try await changedPixels(in: window, from: before, atLeast: minimum)
            #expect(changed >= minimum, "\(changed) changed pixels around the field")
        }

        @Test
        func aStyledFieldDrawsItsRingWhenTheAppFocusBindingMovesFocus() async throws {
            let focus = AppFocus()
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 320, height: 120),
                styleMask: [.titled],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            defer { window.close() }
            window.contentView = NSHostingView(rootView: BindingHost(focus: focus).padding())
            window.makeKeyAndOrderFront(nil)
            let before = try await settledCapture(window)
            let minimum = ringPixels(in: window)

            // Focused by a click, with the app's binding around the field.
            let text = try textFieldFrame(in: window)
            click(window, at: NSPoint(x: text.midX, y: text.midY))
            #expect(try await becomesFocused(window))
            #expect(try await waitUntil { focus.isFocused })
            var changed = try await changedPixels(in: window, from: before, atLeast: minimum)
            #expect(changed >= minimum, "clicked: \(changed) changed pixels around the field")

            // Clearing the binding takes the ring away.
            focus.request = false
            #expect(try await waitUntil { !(window.firstResponder is NSTextView) })
            changed = try await changedPixels(in: window, from: before, atMost: 0)
            #expect(changed == 0, "cleared: \(changed) changed pixels around the field")

            // Setting the binding brings it back.
            focus.request = true
            #expect(try await becomesFocused(window))
            changed = try await changedPixels(in: window, from: before, atLeast: minimum)
            #expect(changed >= minimum, "set: \(changed) changed pixels around the field")
        }
    }
}
#endif
