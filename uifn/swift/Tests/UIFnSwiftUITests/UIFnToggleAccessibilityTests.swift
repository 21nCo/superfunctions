import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// A UIFn toggle shows accessibility a system toggle in its place, which must
/// be off, on or mixed like the UIFn toggle and set the UIFn toggle's value.
@MainActor
struct UIFnToggleAccessibilityTests {
    private final class Reading {
        var value: UIFnToggleValue?
        var isOn: Binding<Bool>?
    }

    /// Reads the configuration SwiftUI gives the system toggle.
    private struct ReadingToggleStyle: ToggleStyle {
        let reading: Reading

        func makeBody(configuration: Configuration) -> some View {
            reading.value = UIFnToggleValue(isOn: configuration.isOn, isMixed: configuration.isMixed)
            reading.isOn = configuration.$isOn
            return configuration.label.frame(width: 10, height: 10)
        }
    }

    private final class Box {
        var isOn: Bool
        var writes = 0

        init(_ isOn: Bool) {
            self.isOn = isOn
        }

        var binding: Binding<Bool> {
            Binding(get: { self.isOn }, set: { self.isOn = $0; self.writes += 1 })
        }
    }

    private func read(_ value: UIFnToggleValue, isOn box: Box) async throws -> Reading {
        let reading = Reading()
        _ = try #require(await UIFnSnapshot.render {
            UIFnAccessibilityToggle(value: value, isOn: box.binding) { Text("Remember") }
                .toggleStyle(ReadingToggleStyle(reading: reading))
        })
        return reading
    }

    @Test(arguments: [UIFnToggleValue.off, .on, .mixed])
    func theSystemToggleHasTheUIFnTogglesValue(_ value: UIFnToggleValue) async throws {
        let reading = try await read(value, isOn: Box(value == .on))
        #expect(reading.value == value)
    }

    @Test(arguments: [UIFnToggleValue.off, .on, .mixed])
    func settingTheSystemToggleSetsTheUIFnToggleOnce(_ value: UIFnToggleValue) async throws {
        let box = Box(value == .on)
        let reading = try await read(value, isOn: box)
        let isOn = try #require(reading.isOn)
        let newValue = value != .on
        isOn.wrappedValue = newValue
        #expect(box.isOn == newValue)
        #expect(box.writes == 1)
    }
}
