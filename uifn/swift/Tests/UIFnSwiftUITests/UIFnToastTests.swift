import SwiftUI
import Testing
@testable import UIFnSwiftUI

/// `uifnToast` shows a toast over a view in a window: it announces each toast
/// once, dismisses it when its duration passes or its dismiss button is
/// pressed, never dismisses a toast that replaced it, and only fades under
/// Reduce Motion.
///
/// The tests show windows on the main actor, so they run one at a time and
/// other suites' main-actor work runs between them.
@MainActor @Suite(.serialized)
struct UIFnToastTests {
    private final class Model: ObservableObject {
        @Published var toast: UIFnToast?

        init(_ toast: UIFnToast? = nil) {
            self.toast = toast
        }
    }

    private final class Announcements {
        var posted: [String] = []
        var tones: [UIFnTone] = []

        var announcer: UIFnAnnouncer {
            UIFnAnnouncer { text, tone in
                self.posted.append(text)
                self.tones.append(tone)
            }
        }
    }

    private struct Screen: View {
        @ObservedObject var model: Model
        let dismissLabel: String?
        let announcer: UIFnAnnouncer

        var body: some View {
            Color.clear
                .frame(width: 360, height: 240)
                .uifnToast($model.toast, dismissLabel: dismissLabel)
                .environment(\.uifnAnnouncer, announcer)
        }
    }

    private func show(
        _ model: Model,
        dismissLabel: String? = "Dismiss",
        announcements: Announcements = Announcements()
    ) -> UIFnAccessibilityHost<Screen> {
        UIFnAccessibilityHost(Screen(model: model, dismissLabel: dismissLabel, announcer: announcements.announcer))
    }

    /// Long enough for the window to run a toast's task and redraw.
    private func settle() async {
        try? await Task.sleep(nanoseconds: 300_000_000)
    }

    // MARK: - Announcements

    @Test
    func eachToastIsAnnouncedOnceWhenItAppears() async {
        let model = Model()
        let announcements = Announcements()
        let host = show(model, announcements: announcements)
        defer { host.close() }
        await settle()
        #expect(announcements.posted.isEmpty)

        model.toast = UIFnToast("Copied", message: "The link is on the clipboard.", duration: nil)
        await host.wait { announcements.posted.count == 1 }
        // Changing the toast showing redraws it without announcing it again.
        model.toast?.message = "The link and its title are on the clipboard."
        await settle()
        #expect(announcements.posted == ["Copied, The link is on the clipboard."])

        // The same text in a new toast is announced again.
        model.toast = UIFnToast("Copied", tone: .success, duration: nil)
        await host.wait { announcements.posted.count == 2 }
        #expect(announcements.posted == ["Copied, The link is on the clipboard.", "Copied"])
        #expect(announcements.tones == [.accent, .success])
    }

    @Test
    func aToastShowingWhenTheViewAppearsIsAnnounced() async {
        let announcements = Announcements()
        let host = show(Model(UIFnToast("Offline", tone: .warning, duration: nil)), announcements: announcements)
        defer { host.close() }
        await host.wait { !announcements.posted.isEmpty }
        #expect(announcements.posted == ["Offline"])
        #expect(announcements.tones == [.warning])
    }

    // MARK: - Dismissal

    @Test
    func aToastDismissesItselfWhenItsDurationPasses() async {
        let model = Model()
        let host = show(model)
        defer { host.close() }
        model.toast = UIFnToast("Saved", duration: 0.5)
        await Task.yield()
        #expect(model.toast != nil)
        await host.wait(upTo: 3) { model.toast == nil }
        #expect(model.toast == nil)
    }

    /// A toast that replaces another keeps showing for its own duration, not
    /// what was left of the one it replaced.
    @Test
    func aReplacedToastsDurationDoesNotDismissItsReplacement() async {
        let model = Model()
        let announcements = Announcements()
        let host = show(model, announcements: announcements)
        defer { host.close() }
        model.toast = UIFnToast("Uploading", duration: 0.4)
        await host.wait { announcements.posted.count == 1 }
        let replacement = UIFnToast("Uploaded", duration: nil)
        model.toast = replacement
        try? await Task.sleep(nanoseconds: 900_000_000)
        #expect(model.toast == replacement)
    }

    /// Without a duration, or with one that never passes, a toast shows until
    /// it is dismissed.
    @Test(arguments: [nil, 0, -1, .infinity, .nan] as [TimeInterval?])
    func aToastWithoutAPositiveFiniteDurationStays(_ duration: TimeInterval?) async {
        let toast = UIFnToast("Offline", duration: duration)
        let model = Model(toast)
        let announcements = Announcements()
        let host = show(model, announcements: announcements)
        defer { host.close() }
        await host.wait { !announcements.posted.isEmpty }
        try? await Task.sleep(nanoseconds: 300_000_000)
        #expect(model.toast?.id == toast.id)
    }

    @Test
    func theDismissButtonDismissesTheToast() async throws {
        let model = Model(UIFnToast("Copied", message: "The link is on the clipboard.", duration: nil))
        let host = show(model)
        defer { host.close() }
        let elements = host.elements()
        #expect(elements.count == 2, "\(elements)")
        let text = try #require(elements.first)
        #expect(text.is(.staticText) && text.label == "Copied" && text.value == "The link is on the clipboard.", "\(text)")
        let button = try #require(elements.last)
        #expect(button.is(.button) && button.label == "Dismiss", "\(button)")
        #expect(button.press())
        await host.wait { model.toast == nil }
        #expect(model.toast == nil)
    }

    @Test
    func withoutADismissLabelTheToastHasNoDismissButton() {
        let host = show(Model(UIFnToast("Copied", duration: nil)), dismissLabel: nil)
        defer { host.close() }
        let elements = host.elements()
        #expect(elements.count == 1, "\(elements)")
        #expect(elements.first?.is(.staticText) == true && elements.first?.label == "Copied", "\(elements)")
    }

    // MARK: - Motion

    /// Reads the motion a toast presenter resolves from the environment.
    private struct MotionReader: View {
        let edge: VerticalEdge
        let read: (UIFnToastMotion) -> Void
        @UIFnStyleEnvironment private var context

        var body: some View {
            read(UIFnToastMotion(context: context, edge: edge))
            return Color.clear.frame(width: 1, height: 1)
        }
    }

    /// The toast slides in from its edge for the theme's normal duration;
    /// under Reduce Motion it does not move and takes the theme's
    /// reduced-motion duration, which for the default theme is none.
    @Test(arguments: [VerticalEdge.top, .bottom], [false, true])
    func underReduceMotionAToastDoesNotMove(_ edge: VerticalEdge, _ reduceMotion: Bool) async throws {
        var motion: UIFnToastMotion?
        _ = try #require(await UIFnSnapshot.render {
            MotionReader(edge: edge) { motion = $0 }
                .environment(\._accessibilityReduceMotion, reduceMotion)
        })
        let resolved = try #require(motion)
        let normal = UIFnTheme.uifn.motion.duration.normal
        #expect(resolved.moves == !reduceMotion)
        #expect(resolved.duration == (reduceMotion ? normal.reducedMotionSeconds : normal.seconds))
        #expect(UIFnTheme.uifn.motion.duration.normal.reducedMotionSeconds == 0)
    }

    @Test
    func theAnnouncementIsTheTitleThenTheMessage() {
        #expect(UIFnToast("Copied", message: "The link is on the clipboard.").announcement == "Copied, The link is on the clipboard.")
        #expect(UIFnToast("Copied").announcement == "Copied")
    }
}
