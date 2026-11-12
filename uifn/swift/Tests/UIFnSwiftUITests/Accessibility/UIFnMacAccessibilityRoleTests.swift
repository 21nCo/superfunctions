#if os(macOS)
import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// The macOS elements of the UIFn controls that accessibility sees as system
/// controls, read as VoiceOver and Xcode's accessibility audit read them: each
/// is one element with the control's label, and nothing reads text the
/// control does not draw.
@MainActor @Suite(.serialized)
struct UIFnMacAccessibilityRoleTests {
    private func elements(_ view: some View, until complete: @escaping ([UIFnAccessibilityElement]) -> Bool) async -> [UIFnAccessibilityElement] {
        let host = UIFnAccessibilityHost(view.environment(\.locale, Locale(identifier: "en_US")), width: 500, height: 200)
        defer { host.close() }
        return await host.elements(until: complete)
    }

    /// A gauge reads its label, current value label and value. SwiftUI gives
    /// a gauge with a custom style an element with no macOS role, whatever
    /// the style's body or accessibility representation is, so the
    /// workbench's audit waives that (`swiftui-gauge-role`); the label and
    /// value are what VoiceOver has to read.
    @Test(arguments: UIFnGaugeStyle.Variant.allCases)
    func aGaugeReadsItsLabelsAndValue(_ variant: UIFnGaugeStyle.Variant) async {
        let gauge = Gauge(value: 62, in: 0...100) {
            Text("Storage")
        } currentValueLabel: {
            Text("62 GB")
        } minimumValueLabel: {
            Text("0")
        } maximumValueLabel: {
            Text("100")
        }
        .gaugeStyle(.uifn(variant))
        let elements = await elements(gauge) { $0.count == 1 && $0[0].label == "Storage, 62 GB" }
        #expect(elements.count == 1, "\(elements)")
        #expect(elements.first?.label == "Storage, 62 GB", "\(elements)")
        #expect(elements.first?.value == "0.62", "\(elements)")
    }

    /// The segmented picker's label is the segmented control's, not a text of
    /// its own where the picker draws its segments.
    @Test(arguments: UIFnSegmentedPickerVariant.allCases)
    func aSegmentedPickersLabelIsItsControls(_ variant: UIFnSegmentedPickerVariant) async {
        let picker = UIFnSegmentedPicker("Range", selection: .constant("Week"), options: ["Day", "Week"], variant: variant) { Text($0) }
        let elements = await elements(picker) { $0.count == 1 && $0[0].label == "Range" }
        #expect(!elements.contains { $0.is(.staticText) }, "\(elements)")
        #expect(elements.count == 1, "\(elements)")
        #expect(elements.first?.label == "Range", "\(elements)")
    }

    /// A switch is named by its label as the system's switch is: the label is
    /// a text beside it that the switch gives as its title element, which
    /// VoiceOver reads as its name. With its label hidden the switch is
    /// labelled itself.
    @Test func aSwitchIsNamedByItsLabel() async {
        let toggles = VStack {
            Toggle("Sounds", isOn: .constant(false)).toggleStyle(.uifnSwitch)
            Toggle("Vibrate", isOn: .constant(false)).toggleStyle(.uifnSwitch).labelsHidden()
        }
        let checkBox = NSAccessibility.Role.checkBox.rawValue
        let names = { (elements: [UIFnAccessibilityElement]) in
            elements.filter { $0.platformRole == checkBox }.map { $0.label ?? $0.titleElementText }
        }
        let elements = await elements(toggles) { names($0) == ["Sounds", "Vibrate"] }
        #expect(names(elements) == ["Sounds", "Vibrate"], "\(elements)")
    }

    /// The menu picker's label is the pop-up button's, not a text of its own
    /// where the picker draws the selected option.
    @Test(arguments: [Optional("Name"), nil])
    func aMenuPickersLabelIsItsPopUpButtons(_ selection: String?) async {
        let picker = UIFnMenuPicker("Sort by", selection: .constant(selection), options: ["Name", "Date"].map(Optional.some)) { Text($0 ?? "") }
        let elements = await elements(picker) { $0.count == 1 && $0[0].label == "Sort by" }
        #expect(!elements.contains { $0.is(.staticText) }, "\(elements)")
        #expect(elements.count == 1, "\(elements)")
        #expect(elements.first?.is(.popUpButton) == true, "\(elements)")
        #expect(elements.first?.label == "Sort by", "\(elements)")
    }
}
#endif
