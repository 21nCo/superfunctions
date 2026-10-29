#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// The text field style tracks focus with its own `FocusState`; an app's
/// `focused(_:)` binding around the styled field must still move focus.
@MainActor
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

    @Test
    func anAppFocusBindingStillFocusesAStyledField() async throws {
        // The plain field shows the window can take focus in this process.
        #expect(try await focusesTheField(styled: false))
        #expect(try await focusesTheField(styled: true))
    }
}
#endif
