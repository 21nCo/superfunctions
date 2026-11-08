import SwiftUI
import UIFnSwiftUI

/// One screen of the workbench. The raw value is the screen's launch argument
/// and the suffix of its accessibility identifiers.
enum WorkbenchScreen: String, CaseIterable, Identifiable, Hashable {
    case buttons
    case toggles
    case textFields = "text-fields"
    case menus
    case segmentedPickers = "segmented-pickers"
    case progress
    case segmentedMeters = "segmented-meters"
    case banners
    case toasts
    case emptyStates = "empty-states"
    case skeletons

    enum Group: String, CaseIterable {
        case styles = "Styles"
        case components = "Components"
    }

    var id: String { rawValue }

    var group: Group {
        switch self {
        case .buttons, .toggles, .textFields, .menus, .segmentedPickers, .progress: .styles
        case .segmentedMeters, .banners, .toasts, .emptyStates, .skeletons: .components
        }
    }

    var title: String {
        switch self {
        case .buttons: "Buttons"
        case .toggles: "Toggles"
        case .textFields: "Text fields"
        case .menus: "Group boxes and menus"
        case .segmentedPickers: "Segmented pickers"
        case .progress: "Progress and gauges"
        case .segmentedMeters: "Segmented meters"
        case .banners: "Banners"
        case .toasts: "Toasts"
        case .emptyStates: "Empty states"
        case .skeletons: "Skeletons"
        }
    }

    var systemImage: String {
        switch self {
        case .buttons: "rectangle.and.hand.point.up.left"
        case .toggles: "switch.2"
        case .textFields: "character.cursor.ibeam"
        case .menus: "filemenu.and.selection"
        case .segmentedPickers: "rectangle.split.3x1"
        case .progress: "hourglass"
        case .segmentedMeters: "chart.bar"
        case .banners: "text.bubble"
        case .toasts: "bubble.left.and.exclamationmark.bubble.right"
        case .emptyStates: "tray"
        case .skeletons: "rectangle.dashed"
        }
    }

    @ViewBuilder
    var content: some View {
        switch self {
        case .buttons: ButtonsScreen()
        case .toggles: TogglesScreen()
        case .textFields: TextFieldsScreen()
        case .menus: MenusScreen()
        case .segmentedPickers: SegmentedPickersScreen()
        case .progress: ProgressScreen()
        case .segmentedMeters: SegmentedMetersScreen()
        case .banners: BannersScreen()
        case .toasts: ToastsScreen()
        case .emptyStates: EmptyStatesScreen()
        case .skeletons: SkeletonsScreen()
        }
    }
}

/// The list of screens beside, or on iPhone before, the selected screen.
struct WorkbenchRoot: View {
    @State private var selection: WorkbenchScreen?
    @State private var compactColumn: NavigationSplitViewColumn
    @Environment(\.uifnTheme) private var theme
    #if os(macOS)
    @FocusState private var listHasFocus: Bool
    @Environment(\.controlActiveState) private var windowState
    @Environment(\.uifnDisplayGamut) private var displayGamut
    #endif

    init(initialScreen: WorkbenchScreen?) {
        _selection = State(initialValue: initialScreen)
        _compactColumn = State(initialValue: initialScreen == nil ? .sidebar : .detail)
    }

    var body: some View {
        NavigationSplitView(preferredCompactColumn: $compactColumn) {
            List(selection: $selection) {
                ForEach(WorkbenchScreen.Group.allCases, id: \.self) { group in
                    Section {
                        ForEach(WorkbenchScreen.allCases.filter { $0.group == group }) { screen in
                            #if os(macOS)
                            // A navigation link in a macOS sidebar is an
                            // element with no role; a tagged row is the
                            // list's own selectable row.
                            Text(screen.title)
                                .fontWeight(selection == screen ? .semibold : .regular)
                                .foregroundStyle(theme.colors.text.primary.color(displayGamut: displayGamut))
                                .accessibilityIdentifier("workbench.sidebar.\(screen.rawValue)")
                                .tag(screen)
                                .listRowBackground(WorkbenchSidebarRowBackground(
                                    isSelected: selection == screen,
                                    showsFocus: selection == screen && listHasFocus && windowState == .key
                                ))
                            #else
                            NavigationLink(value: screen) {
                                Label(screen.title, systemImage: screen.systemImage)
                            }
                            .accessibilityIdentifier("workbench.sidebar.\(screen.rawValue)")
                            #endif
                        }
                    } header: {
                        // The list's own header color is too faint on iOS for
                        // the contrast audit.
                        Text(group.rawValue)
                            #if os(macOS)
                            .foregroundStyle(theme.colors.text.secondary.color(displayGamut: displayGamut))
                            #else
                            .foregroundStyle(Color.primary)
                            #endif
                            .accessibilityAddTraits(.isHeader)
                    }
                }
            }
            .navigationTitle("UIFn Workbench")
            #if os(macOS)
            // Over the sidebar's own translucent material the audit failed
            // the contrast of a different set of legible rows each run. An
            // opaque theme surface, with the rows in theme text colors on
            // backgrounds the app draws, makes what it measures the same for
            // every row, selected or not.
            .scrollContentBackground(.hidden)
            .background(theme.colors.surface.sunken.color(displayGamut: displayGamut))
            .focused($listHasFocus)
            .navigationSplitViewColumnWidth(min: 200, ideal: 240)
            #else
            // Keeps the whole list on an iPhone's screen, where the audit
            // can see it.
            .listSectionSpacing(.compact)
            #endif
        } detail: {
            if let selection {
                WorkbenchPage(screen: selection)
            } else {
                // The secondary color only nearly passes the contrast audit.
                Text("Choose a screen")
                    .accessibilityIdentifier("workbench.placeholder")
            }
        }
        #if os(macOS)
        .frame(minWidth: 760, minHeight: 560)
        #endif
    }
}

#if os(macOS)
/// A macOS sidebar row's background, drawn by the app in every selection
/// state. AppKit draws its selection (the accent color while the list has
/// focus in the key window, gray otherwise) beneath a row's background, so
/// this opaque background hides it, and the row's primary text has the same
/// background whether or not the list has focus. The selected row is the
/// theme's subtle accent with a solid accent bar at its leading edge and,
/// standing in for AppKit's focused selection, a solid accent outline while
/// the list has keyboard focus in the key window.
private struct WorkbenchSidebarRowBackground: View {
    let isSelected: Bool
    let showsFocus: Bool
    @Environment(\.uifnTheme) private var theme
    @Environment(\.uifnDisplayGamut) private var displayGamut

    var body: some View {
        ZStack(alignment: .leading) {
            theme.colors.surface.sunken.color(displayGamut: displayGamut)
            if isSelected {
                let shape = RoundedRectangle(cornerRadius: 6)
                shape
                    .fill(theme.colors.accent.subtle.color(displayGamut: displayGamut))
                    .overlay {
                        if showsFocus {
                            shape.strokeBorder(theme.colors.accent.solid.color(displayGamut: displayGamut), lineWidth: 2)
                        }
                    }
                    .padding(.horizontal, 8)
                Capsule()
                    .fill(theme.colors.accent.solid.color(displayGamut: displayGamut))
                    .frame(width: 3)
                    .padding(.vertical, 6)
                    .padding(.leading, 10)
            }
        }
    }
}
#endif

/// A screen's content, scrolling on the theme's canvas, with the toasts the
/// screen shows over it.
struct WorkbenchPage: View {
    let screen: WorkbenchScreen
    @State private var toast: UIFnToast?
    @Environment(\.uifnTheme) private var theme
    #if os(macOS)
    @Environment(\.uifnDisplayGamut) private var displayGamut
    private var canvas: Color { theme.colors.surface.canvas.color(displayGamut: displayGamut) }
    #else
    private var canvas: Color { theme.colors.surface.canvas.color }
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                screen.content
            }
            .padding(24)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("workbench.screen.\(screen.rawValue)")
        .background(canvas)
        .uifnToast($toast, dismissLabel: "Dismiss notification", edge: .bottom)
        .environment(\.workbenchShowToast) { toast = $0 }
        .navigationTitle(screen.title)
        // A new screen starts without the last one's toast.
        .onChange(of: screen) { toast = nil }
    }
}

private struct WorkbenchShowToastKey: EnvironmentKey {
    static let defaultValue: (UIFnToast) -> Void = { _ in }
}

extension EnvironmentValues {
    /// Shows a toast over the current screen.
    var workbenchShowToast: (UIFnToast) -> Void {
        get { self[WorkbenchShowToastKey.self] }
        set { self[WorkbenchShowToastKey.self] = newValue }
    }
}

/// A titled group of examples on a screen.
struct WorkbenchSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
