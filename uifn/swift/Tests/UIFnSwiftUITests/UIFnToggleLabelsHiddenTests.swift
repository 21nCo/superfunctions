import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// Like the system styles, a UIFn toggle draws no label where labels are
/// hidden. Styles can tell only on iOS 18, macOS 15 and later.
struct UIFnToggleLabelsHiddenTests {
    enum Style: String, CaseIterable, CustomTestStringConvertible {
        case `switch`, checkbox

        var testDescription: String { rawValue }
    }

    /// How a test hides, shows or leaves the labels.
    enum Labels: String, CaseIterable, CustomTestStringConvertible {
        case labelsHidden, labelsHiddenOnAContainer, labelsVisibilityHidden

        var testDescription: String { rawValue }
    }

    init() throws {
        try registerSnapshotFont()
    }

    @MainActor
    private static func toggle(_ style: Style, label: String?) -> some View {
        Toggle(isOn: .constant(true)) {
            if let label { Text(label) }
        }
        .toggleStyle(style)
    }

    @MainActor
    private static func render(_ content: @escaping @MainActor () -> some View) async throws -> UIFnBitmap {
        try #require(await UIFnSnapshot.render { content().isolated() })
    }

    @Test(arguments: Style.allCases, Labels.allCases)
    func aHiddenLabelIsNotDrawn(_ style: Style, _ labels: Labels) async throws {
        guard #available(iOS 18.0, macOS 15.0, *) else { return }
        let labelled = try await Self.render { Self.toggle(style, label: "Remember") }
        let unlabelled = try await Self.render { Self.toggle(style, label: nil) }
        let hidden = try await Self.render {
            switch labels {
            case .labelsHidden: AnyView(Self.toggle(style, label: "Remember").labelsHidden())
            case .labelsHiddenOnAContainer: AnyView(VStack { Self.toggle(style, label: "Remember") }.labelsHidden())
            case .labelsVisibilityHidden: AnyView(Self.toggle(style, label: "Remember").labelsVisibility(.hidden))
            }
        }
        #expect(hidden.width < labelled.width)
        // Nothing of the label is left, not even the space before it.
        #expect(hidden.width == unlabelled.width && hidden.height == unlabelled.height)
        #expect(hidden.differingFraction(from: unlabelled) == 0)
    }

    @Test(arguments: Style.allCases)
    func aVisibleLabelIsDrawn(_ style: Style) async throws {
        guard #available(iOS 18.0, macOS 15.0, *) else { return }
        let labelled = try await Self.render { Self.toggle(style, label: "Remember") }
        let visible = try await Self.render { Self.toggle(style, label: "Remember").labelsVisibility(.visible) }
        #expect(visible.differingFraction(from: labelled) == 0)
    }
}

private extension Toggle {
    func toggleStyle(_ style: UIFnToggleLabelsHiddenTests.Style) -> some View {
        switch style {
        case .switch: AnyView(toggleStyle(.uifnSwitch))
        case .checkbox: AnyView(toggleStyle(.uifnCheckbox))
        }
    }
}
