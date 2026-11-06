import SwiftUI
import UIFnSwiftUI

// One screen for each UIFn control style, showing each variant enabled and
// disabled and, where the control has them, its states.

struct ButtonsScreen: View {
    @State private var lastPressed = "None"

    var body: some View {
        WorkbenchSection("Variants") {
            buttons
        }
        WorkbenchSection("Disabled") {
            buttons.disabled(true)
        }
        Text("Last pressed: \(lastPressed)")
            .accessibilityIdentifier("buttons.last-pressed")
    }

    private var buttons: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button("Save") { lastPressed = "Save" }.buttonStyle(.uifnPrimary)
            Button("Cancel") { lastPressed = "Cancel" }.buttonStyle(.uifnSecondary)
            Button("More") { lastPressed = "More" }.buttonStyle(.uifnGhost)
            Button("Delete", role: .destructive) { lastPressed = "Delete" }.buttonStyle(.uifnDestructive)
        }
    }
}

struct TogglesScreen: View {
    @State private var alerts = true
    @State private var sounds = false
    @State private var remember = true
    @State private var newsletter = false
    @State private var lists = [
        ListSelection(name: "Inbox", isOn: true),
        ListSelection(name: "Archive", isOn: false),
    ]

    struct ListSelection: Identifiable {
        let name: String
        var isOn: Bool
        var id: String { name }
    }

    var body: some View {
        WorkbenchSection("Switch") {
            Toggle("Alerts", isOn: $alerts).toggleStyle(.uifnSwitch)
            Toggle("Sounds", isOn: $sounds).toggleStyle(.uifnSwitch)
            Toggle("Sync (disabled)", isOn: .constant(true)).toggleStyle(.uifnSwitch).disabled(true)
            HStack {
                Text("Label hidden")
                Toggle("Vibrate", isOn: $sounds).toggleStyle(.uifnSwitch).labelsHidden()
            }
        }
        WorkbenchSection("Checkbox") {
            Toggle("Remember me", isOn: $remember).toggleStyle(.uifnCheckbox)
            Toggle("Send me news", isOn: $newsletter).toggleStyle(.uifnCheckbox)
            // Mixed while the lists disagree.
            Toggle("All lists", sources: $lists, isOn: \.isOn).toggleStyle(.uifnCheckbox)
            ForEach($lists) { $list in
                Toggle(list.name, isOn: $list.isOn).toggleStyle(.uifnCheckbox).padding(.leading, 24)
            }
            Toggle("Accept terms (disabled)", isOn: .constant(false)).toggleStyle(.uifnCheckbox).disabled(true)
        }
    }
}

struct TextFieldsScreen: View {
    @State private var name = ""
    @State private var email = "ada@example.com"

    var body: some View {
        WorkbenchSection("Text field") {
            // On macOS a field shows its prompt, or its title when it has
            // none, but gives accessibility no label, so each names itself.
            TextField("Name", text: $name, prompt: Text("Your name"))
                .textFieldStyle(.uifn)
                .accessibilityLabel("Name")
            TextField("Email", text: $email)
                .textFieldStyle(.uifn)
                .accessibilityLabel("Email")
            TextField("Workspace (disabled)", text: .constant("Design"))
                .textFieldStyle(.uifn)
                .disabled(true)
                .accessibilityLabel("Workspace (disabled)")
        }
    }
}

struct MenusScreen: View {
    enum Sort: String, CaseIterable, Hashable {
        case name = "Name"
        case date = "Date"
        case size = "Size"
    }

    @State private var sort = Sort.name
    @State private var groupBy: Sort?
    @State private var lastAction = "None"

    var body: some View {
        WorkbenchSection("Group box") {
            GroupBox("Account") {
                Text("Signed in as Ada")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .groupBoxStyle(.uifn)
        }
        WorkbenchSection("Menu") {
            Menu("Options") {
                Button("Rename") { lastAction = "Rename" }
                Button("Duplicate") { lastAction = "Duplicate" }
                Button("Delete", role: .destructive) { lastAction = "Delete" }
            }
            .menuStyle(.uifn)
            Menu("Share") {
                Button("Copy link") { lastAction = "Copy link" }
            }
            .menuStyle(.uifn)
            .menuIndicator(.hidden)
            Text("Last action: \(lastAction)")
        }
        WorkbenchSection("Menu picker") {
            UIFnMenuPicker("Sort by", selection: $sort, options: Sort.allCases) { Text($0.rawValue) }
            // Nothing selected: the label shows the picker's title.
            UIFnMenuPicker("Group by", selection: $groupBy, options: Sort.allCases.map(Optional.some)) { option in
                Text(option?.rawValue ?? "")
            }
        }
    }
}

struct SegmentedPickersScreen: View {
    enum Period: String, CaseIterable, Hashable {
        case day = "Day"
        case week = "Week"
        case month = "Month"
    }

    enum Pane: String, CaseIterable, Hashable {
        case overview = "Overview"
        case activity = "Activity"
        case settings = "Settings"
    }

    @State private var period = Period.week
    @State private var pane = Pane.overview

    var body: some View {
        WorkbenchSection("Segmented") {
            UIFnSegmentedPicker("Range", selection: $period, options: Period.allCases) { Text($0.rawValue) }
            UIFnSegmentedPicker("Range (disabled)", selection: .constant(Period.day), options: Period.allCases) { Text($0.rawValue) }
                .disabled(true)
        }
        WorkbenchSection("Tabs") {
            UIFnSegmentedPicker("Pane", selection: $pane, options: Pane.allCases, variant: .tabs) { Text($0.rawValue) }
            Text("Showing \(pane.rawValue)")
        }
    }
}

struct ProgressScreen: View {
    var body: some View {
        WorkbenchSection("Progress") {
            ProgressView(value: 0.4) { Text("Upload") }.progressViewStyle(.uifnLinear)
            ProgressView { Text("Syncing") }.progressViewStyle(.uifnLinear)
            HStack(spacing: 32) {
                ProgressView(value: 0.7) { Text("Download") }.progressViewStyle(.uifnCircular)
                ProgressView { Text("Loading") }.progressViewStyle(.uifnCircular)
            }
        }
        WorkbenchSection("Gauges") {
            Gauge(value: 62, in: 0...100) {
                Text("Storage")
            } currentValueLabel: {
                Text("62 GB")
            } minimumValueLabel: {
                Text("0")
            } maximumValueLabel: {
                Text("100")
            }
            .gaugeStyle(.uifnLinear)
            Gauge(value: 0.8) {
                Text("Battery")
            } currentValueLabel: {
                Text("80")
            }
            .gaugeStyle(.uifnCircular)
        }
    }
}
