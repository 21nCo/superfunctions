import SwiftUI
import UIFnSwiftUI

@main
struct SwiftUIWorkbenchApp: App {
    private let launch = WorkbenchLaunchOptions(defaults: .standard)

    var body: some Scene {
        WindowGroup("UIFn Workbench") {
            WorkbenchRoot(initialScreen: launch.screen)
                .preferredColorScheme(launch.colorScheme)
                #if os(macOS)
                // UIFn colors for the window's screen: the theme's sRGB values
                // on an sRGB display, Display P3 on a P3 one.
                .uifnDisplayGamutFromWindow()
                #endif
        }
        #if os(macOS)
        // Tall enough for the tallest screen, so the audit sees each one whole,
        // and short enough for a 1024 by 768 display.
        .defaultSize(width: 960, height: 680)
        #endif
    }
}

/// How the workbench starts, read from launch arguments such as
/// `-UIFnWorkbenchScreen buttons -UIFnWorkbenchColorScheme dark`, which land in
/// the arguments domain of `UserDefaults`. The UI tests open each screen in
/// each color scheme this way.
struct WorkbenchLaunchOptions {
    static let screenKey = "UIFnWorkbenchScreen"
    static let colorSchemeKey = "UIFnWorkbenchColorScheme"

    /// The screen to open, or nil for the list of screens.
    let screen: WorkbenchScreen?
    /// The color scheme to show, or nil to follow the system.
    let colorScheme: ColorScheme?

    init(defaults: UserDefaults) {
        screen = defaults.string(forKey: Self.screenKey).flatMap(WorkbenchScreen.init(rawValue:))
        switch defaults.string(forKey: Self.colorSchemeKey) {
        case "light": colorScheme = .light
        case "dark": colorScheme = .dark
        default: colorScheme = nil
        }
    }
}
