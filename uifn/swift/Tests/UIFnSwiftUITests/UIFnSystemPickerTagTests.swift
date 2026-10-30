#if os(macOS)
import AppKit
import OSLog
import SwiftUI
import Testing
@testable import UIFnSwiftUI

extension UIFnHostedWindowTests {
    /// The system `Picker` a UIFn picker gives accessibility, or a menu
    /// picker's items, always has a selection one of its items is tagged with,
    /// or, where the picker allows, none: SwiftUI logs a selection with no tag
    /// as invalid and gives undefined results for it.
    ///
    /// The suite shows a window, so it runs inside ``UIFnHostedWindowTests``.
    @MainActor @Suite
    struct UIFnSystemPickerTagTests {
        private static let options = ["Day", "Week", "Month"]

        /// The start of SwiftUI's warning for a system picker whose selection has no tag.
        private static let warning = "Picker: the selection "

        /// This process's log messages since `date`.
        private func messages(since date: Date) throws -> [String] {
            let store = try OSLogStore(scope: .currentProcessIdentifier)
            return try store.getEntries(at: store.position(date: date)).compactMap { ($0 as? OSLogEntryLog)?.composedMessage }
        }

        private func systemPicker(_ selection: String, labelsNoSelection: Bool = false) -> UIFnSystemPicker<Text, String, Text> {
            UIFnSystemPicker(selection: .constant(selection), options: Self.options, label: Text("Range"), labelsNoSelection: labelsNoSelection) {
                Text($0)
            }
        }

        /// The segmented picker's, the menu picker's items and the menu
        /// picker's accessibility system pickers, as the UIFn pickers style
        /// them, with no option selected and with one.
        @Test
        func aSelectionThatIsNotAnOptionIsNoSelectionForTheSystemPicker() async throws {
            let start = Date()
            // Only a menu-style system picker logs the warning. One given a
            // selection with no tag, shown last, shows it is logged and read.
            let control = "control-\(UUID().uuidString)"
            let window = UIFnHostedWindowTests.Window(width: 480, height: 360)
            defer { window.close() }
            window.contentView = NSHostingView(rootView: VStack {
                ForEach(["Year", "Week"], id: \.self) { selection in
                    systemPicker(selection).pickerStyle(.segmented)
                    systemPicker(selection).pickerStyle(.inline)
                    systemPicker(selection, labelsNoSelection: true).pickerStyle(.menu)
                }
                Picker("Range", selection: .constant(control)) {
                    ForEach(Self.options, id: \.self) { Text($0).tag($0) }
                }
                .pickerStyle(.menu)
            }
            .padding(20))
            window.makeKeyAndOrderFront(nil)
            window.contentView?.layoutSubtreeIfNeeded()
            var warnings: [String] = []
            for _ in 0..<50 {
                try await Task.sleep(nanoseconds: 100_000_000)
                warnings = try messages(since: start).filter { $0.hasPrefix(Self.warning) }
                if warnings.contains(where: { $0.contains(control) }) { break }
            }
            try #require(warnings.contains { $0.contains(control) })
            #expect(warnings.allSatisfy { $0.contains(control) }, "\(warnings)")
        }
    }
}
#endif
