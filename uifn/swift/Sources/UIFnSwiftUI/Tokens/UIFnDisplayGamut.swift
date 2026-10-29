#if os(macOS)
import AppKit
import SwiftUI

private struct UIFnDisplayGamutKey: EnvironmentKey {
    static let defaultValue = NSDisplayGamut.p3
}

public extension EnvironmentValues {
    /// The gamut of the screen a view draws on, for
    /// `UIFnColorToken.color(displayGamut:)`. Display P3 unless set, for
    /// example by `uifnDisplayGamutFromWindow()`.
    var uifnDisplayGamut: NSDisplayGamut {
        get { self[UIFnDisplayGamutKey.self] }
        set { self[UIFnDisplayGamutKey.self] = newValue }
    }
}

public extension View {
    /// Sets `uifnDisplayGamut` from the screen of the window hosting this view,
    /// and updates it when the window moves to another screen or the screen's
    /// color profile changes.
    func uifnDisplayGamutFromWindow() -> some View {
        modifier(UIFnWindowDisplayGamut())
    }
}

private struct UIFnWindowDisplayGamut: ViewModifier {
    @State private var displayGamut = NSDisplayGamut.p3

    func body(content: Content) -> some View {
        content
            .environment(\.uifnDisplayGamut, displayGamut)
            .background(UIFnWindowDisplayGamutReader(displayGamut: $displayGamut))
    }
}

private struct UIFnWindowDisplayGamutReader: NSViewRepresentable {
    @Binding var displayGamut: NSDisplayGamut

    func makeNSView(context: Context) -> UIFnDisplayGamutView {
        let displayGamut = $displayGamut
        // The view reports while SwiftUI updates the hierarchy; set state afterwards.
        return UIFnDisplayGamutView { gamut in
            DispatchQueue.main.async { displayGamut.wrappedValue = gamut }
        }
    }

    func updateNSView(_ view: UIFnDisplayGamutView, context: Context) {}
}

/// Reports the gamut of its window's screen when it joins a window, and again
/// when that window changes screen or its screen's color profile or color
/// space changes.
final class UIFnDisplayGamutView: NSView {
    private static let windowNotifications: [Notification.Name] = [
        NSWindow.didChangeScreenNotification,
        NSWindow.didChangeScreenProfileNotification,
        NSWindow.didChangeBackingPropertiesNotification,
    ]

    private let gamutOfWindow: (NSWindow) -> NSDisplayGamut
    private let onChange: (NSDisplayGamut) -> Void
    private weak var observedWindow: NSWindow?
    private(set) var displayGamut: NSDisplayGamut?

    init(
        gamutOfWindow: @escaping (NSWindow) -> NSDisplayGamut = { UIFnColorToken.displayGamut(of: $0.screen) },
        onChange: @escaping (NSDisplayGamut) -> Void
    ) {
        self.gamutOfWindow = gamutOfWindow
        self.onChange = onChange
        super.init(frame: .zero)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        let center = NotificationCenter.default
        for name in Self.windowNotifications {
            center.removeObserver(self, name: name, object: observedWindow)
        }
        observedWindow = window
        guard let window else { return }
        for name in Self.windowNotifications {
            center.addObserver(self, selector: #selector(windowDisplayChanged), name: name, object: window)
        }
        windowDisplayChanged()
    }

    @objc private func windowDisplayChanged() {
        guard let window else { return }
        let gamut = gamutOfWindow(window)
        guard gamut != displayGamut else { return }
        displayGamut = gamut
        onChange(gamut)
    }
}
#endif
