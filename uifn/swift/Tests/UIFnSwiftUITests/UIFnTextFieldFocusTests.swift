#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// The text field style tracks focus with its own `FocusState`; an app's
/// `focused(_:)` binding around the styled field must still move focus, and
/// so must a click anywhere inside the field the style draws.
///
/// Each test shows a key window, so they run one at a time.
@MainActor @Suite(.serialized)
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
        case styled, disabled, roundedBorder
    }

    private struct ClickHost: View {
        let field: ClickedField

        var body: some View {
            switch field {
            case .styled: TextField("Name", text: .constant("Ada")).textFieldStyle(.uifn).frame(width: 260)
            case .disabled: TextField("Name", text: .constant("Ada")).textFieldStyle(.uifn).frame(width: 260).disabled(true)
            case .roundedBorder: TextField("Name", text: .constant("Ada")).textFieldStyle(.roundedBorder).frame(width: 260)
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
}
#endif
