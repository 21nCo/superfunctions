import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// Like the system styles, a UIFn toggle draws no label where labels are
/// hidden. Styles can tell only on iOS 18, macOS 15 and later; earlier, the
/// toggles hide their labels through `LabeledContent`, which the tests force
/// with ``SwiftUI/EnvironmentValues/uifnHidesLabelsWithLabeledContent``.
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

    /// How the toggle finds out that labels are hidden.
    enum Path: String, CaseIterable, CustomTestStringConvertible {
        /// The `labelsVisibility` environment value of iOS 18, macOS 15 and later.
        case labelsVisibility
        /// The `LabeledContent` used before iOS 18 and macOS 15.
        case labeledContent

        var testDescription: String { rawValue }
    }

    init() throws {
        try registerSnapshotFont()
    }

    @MainActor
    private static func toggle(_ style: Style, label: String?, path: Path) -> some View {
        Toggle(isOn: .constant(true)) {
            if let label { Text(label) }
        }
        .toggleStyle(style)
        .environment(\.uifnHidesLabelsWithLabeledContent, path == .labeledContent)
    }

    @MainActor
    private static func render(_ content: @escaping @MainActor () -> some View) async throws -> UIFnBitmap {
        try #require(await UIFnSnapshot.render { content().isolated() })
    }

    @Test(arguments: Style.allCases, Path.allCases)
    func aHiddenLabelIsNotDrawn(_ style: Style, _ path: Path) async throws {
        var cases: [Labels] = [.labelsHidden, .labelsHiddenOnAContainer]
        if #available(iOS 18.0, macOS 15.0, *) {
            cases.append(.labelsVisibilityHidden)
        } else if path == .labelsVisibility {
            return
        }
        let labelled = try await Self.render { Self.toggle(style, label: "Remember", path: path) }
        let unlabelled = try await Self.render { Self.toggle(style, label: nil, path: path) }
        for labels in cases {
            let hidden = try await Self.render {
                switch labels {
                case .labelsHidden:
                    AnyView(Self.toggle(style, label: "Remember", path: path).labelsHidden())
                case .labelsHiddenOnAContainer:
                    AnyView(VStack { Self.toggle(style, label: "Remember", path: path) }.labelsHidden())
                case .labelsVisibilityHidden:
                    if #available(iOS 18.0, macOS 15.0, *) {
                        AnyView(Self.toggle(style, label: "Remember", path: path).labelsVisibility(.hidden))
                    } else {
                        AnyView(EmptyView())
                    }
                }
            }
            #expect(hidden.width < labelled.width, "\(labels)")
            // Nothing of the label is left, not even the space before it.
            #expect(hidden.width == unlabelled.width && hidden.height == unlabelled.height, "\(labels)")
            #expect(hidden.differingFraction(from: unlabelled) == 0, "\(labels)")
        }
    }

    @Test(arguments: Style.allCases)
    func aVisibleLabelIsDrawn(_ style: Style) async throws {
        guard #available(iOS 18.0, macOS 15.0, *) else { return }
        let labelled = try await Self.render { Self.toggle(style, label: "Remember", path: .labelsVisibility) }
        let visible = try await Self.render {
            Self.toggle(style, label: "Remember", path: .labelsVisibility).labelsVisibility(.visible)
        }
        #expect(visible.differingFraction(from: labelled) == 0)
    }

    /// Where a test puts a toggle.
    enum Container: String, CaseIterable, CustomTestStringConvertible {
        case alone, form, rightToLeft, rightToLeftForm, firstTextBaselineRow, wideFrame

        var testDescription: String { rawValue }
    }

    /// The `LabeledContent` path draws a toggle exactly as the
    /// `labelsVisibility` path does, labelled or not, so the snapshots hold
    /// for both and neither adds space or takes more width than the label
    /// needs, including in a form.
    @Test(arguments: Style.allCases, Container.allCases)
    func bothPathsDrawAToggleAlike(_ style: Style, _ container: Container) async throws {
        @MainActor @ViewBuilder func content(_ path: Path, label: String?) -> some View {
            let direction: LayoutDirection = [.rightToLeft, .rightToLeftForm].contains(container) ? .rightToLeft : .leftToRight
            Group {
                switch container {
                case .form, .rightToLeftForm:
                    Form { Self.toggle(style, label: label, path: path) }.frame(width: 240)
                case .firstTextBaselineRow:
                    HStack(alignment: .firstTextBaseline) {
                        Text("Aa").font(.system(size: 30))
                        Self.toggle(style, label: label, path: path)
                    }
                case .wideFrame:
                    Self.toggle(style, label: label, path: path).frame(width: 320, alignment: .leading)
                case .alone, .rightToLeft:
                    Self.toggle(style, label: label, path: path)
                }
            }
            .environment(\.layoutDirection, direction)
        }
        for label in ["Remember", nil] {
            let visibility = try await Self.render { content(.labelsVisibility, label: label) }
            let labeledContent = try await Self.render { content(.labeledContent, label: label) }
            #expect(labeledContent.width == visibility.width && labeledContent.height == visibility.height, "\(label ?? "no label")")
            #expect(labeledContent.differingFraction(from: visibility) == 0, "\(label ?? "no label")")
        }
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
