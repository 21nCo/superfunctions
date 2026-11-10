import SwiftUI

#if os(macOS)
import AppKit
#elseif canImport(UIKit)
import UIKit
#endif

/// A banner drawn with the environment's ``SwiftUI/EnvironmentValues/uifnTheme``:
/// a title and an optional message on the tone's subtle color, marked by a bar
/// of its solid color along the leading edge, with optional actions and a
/// dismiss button at the trailing end.
///
/// Pass text already localized; the banner shows it as it is. Accessibility
/// reads the title and message as one text, the title as its label and the
/// message as its value, then the actions and the dismiss button, which is
/// labeled with the dismiss label. The tone is drawn only as color, so put
/// what matters about it, such as an error, in the title.
///
/// An inline banner is read where it is laid out; ``SwiftUI/View/uifnToast(_:dismissLabel:edge:)``
/// shows a banner over a view for a while and announces it.
public struct UIFnBanner<Actions: View>: View {
    let title: String
    let message: String?
    let tone: UIFnTone
    let dismiss: UIFnBannerDismiss?
    let actions: Actions

    public init(
        _ title: String,
        message: String? = nil,
        tone: UIFnTone = .accent,
        dismiss: UIFnBannerDismiss? = nil,
        @ViewBuilder actions: () -> Actions
    ) {
        self.title = title
        self.message = message
        self.tone = tone
        self.dismiss = dismiss
        self.actions = actions()
    }

    public var body: some View {
        UIFnBannerAppearance(title: title, message: message, tone: tone, dismiss: dismiss, actions: actions)
    }
}

public extension UIFnBanner where Actions == EmptyView {
    init(_ title: String, message: String? = nil, tone: UIFnTone = .accent, dismiss: UIFnBannerDismiss? = nil) {
        self.init(title, message: message, tone: tone, dismiss: dismiss) { EmptyView() }
    }
}

/// The dismiss button of a banner: its accessibility label, already
/// localized, and what it does.
public struct UIFnBannerDismiss {
    public let label: String
    public let action: () -> Void

    public init(_ label: String, action: @escaping () -> Void) {
        self.label = label
        self.action = action
    }
}

/// How a UIFn banner looks.
struct UIFnBannerAppearance<Actions: View>: View {
    let title: String
    let message: String?
    let tone: UIFnTone
    let dismiss: UIFnBannerDismiss?
    let actions: Actions
    @UIFnStyleEnvironment private var context

    var body: some View {
        let colors = context.colors
        let toneColors = colors.tone(tone)
        let shape = RoundedRectangle(cornerRadius: context.radius.lg, style: .continuous)
        let bar = context.scaled(4)
        HStack(alignment: .center, spacing: context.scaled(context.spacing.space3)) {
            VStack(alignment: .leading, spacing: context.scaled(context.spacing.space1)) {
                Text(verbatim: title)
                    .uifnFont(context.typography.size.md, weight: context.typography.weight.semibold)
                    .foregroundColor(context.color(colors.text.primary))
                if let message {
                    Text(verbatim: message)
                        .uifnFont(context.typography.size.sm, weight: context.typography.weight.regular)
                        .foregroundColor(context.color(colors.text.secondary))
                }
            }
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: title))
            .modifier(UIFnOptionalAccessibilityValue(value: message))
            .accessibilityAddTraits(.isStaticText)
            if Actions.self != EmptyView.self {
                actions
                    .buttonStyle(.uifnSecondary)
            }
            if let dismiss {
                Button(action: dismiss.action) {
                    UIFnCrossMark()
                        .stroke(
                            context.color(colors.text.secondary),
                            style: StrokeStyle(lineWidth: context.scaled(1.5), lineCap: .round)
                        )
                        .frame(width: context.scaled(10), height: context.scaled(10))
                        // A box as tall as the theme's body type size, like a
                        // text label, so the button's padding sizes it like one.
                        .frame(height: context.typography.size.md.scaledPoints(for: context.dynamicTypeSize))
                }
                .buttonStyle(.uifnGhost)
                .accessibilityLabel(Text(verbatim: dismiss.label))
            }
        }
        .padding(context.scaled(context.spacing.space3))
        .padding(.leading, bar)
        .background(shape.fill(context.color(toneColors.subtle)))
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(context.color(toneColors.solid))
                .frame(width: bar)
                .accessibilityHidden(true)
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(context.color(colors.border.subtle), lineWidth: 1))
    }
}

/// Sets an accessibility value only when there is one.
struct UIFnOptionalAccessibilityValue: ViewModifier {
    let value: String?

    func body(content: Content) -> some View {
        if let value {
            content.accessibilityValue(Text(verbatim: value))
        } else {
            content
        }
    }
}

/// A cross filling its frame, drawn rather than taken from a symbol font so it
/// looks the same on every OS release.
struct UIFnCrossMark: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.move(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        return path
    }
}

// MARK: - Toast

/// A banner shown over a view for a while by ``SwiftUI/View/uifnToast(_:dismissLabel:edge:)``.
///
/// Pass text already localized. Each toast has its own identity: setting a
/// toast with a new `id` shows and announces it again, even with the same text.
public struct UIFnToast: Identifiable, Equatable, Sendable {
    public let id: UUID
    public var title: String
    public var message: String?
    public var tone: UIFnTone
    /// Seconds the toast shows before it dismisses itself, up to 365 days, or
    /// nil to show it until it is dismissed. A duration that is not positive
    /// and finite, or is longer than 365 days, also shows it until it is
    /// dismissed.
    public var duration: TimeInterval?

    public init(
        _ title: String,
        message: String? = nil,
        tone: UIFnTone = .accent,
        duration: TimeInterval? = 5,
        id: UUID = UUID()
    ) {
        self.id = id
        self.title = title
        self.message = message
        self.tone = tone
        self.duration = duration
    }

    /// What assistive technologies announce when the toast appears: the title,
    /// then the message.
    var announcement: String {
        [title, message].compactMap { $0 }.joined(separator: ", ")
    }
}

public extension View {
    /// Shows the toast as a banner over this view, at its top or bottom edge,
    /// until its duration passes or it is dismissed, then sets the binding to nil.
    ///
    /// The banner slides in from the edge and fades; under Reduce Motion it
    /// only fades, for the theme's reduced-motion duration. When a toast
    /// appears, assistive technologies such as VoiceOver announce its title
    /// and message, so it is heard wherever focus is. A new toast replaces the
    /// one showing and restarts the duration. With a `dismissLabel`, already
    /// localized, the banner has a dismiss button with that accessibility label.
    func uifnToast(_ toast: Binding<UIFnToast?>, dismissLabel: String?, edge: VerticalEdge = .top) -> some View {
        modifier(UIFnToastPresenter(toast: toast, dismissLabel: dismissLabel, edge: edge))
    }
}

struct UIFnToastPresenter: ViewModifier {
    @Binding var toast: UIFnToast?
    let dismissLabel: String?
    let edge: VerticalEdge
    @UIFnStyleEnvironment private var context
    @Environment(\.uifnAnnouncer) private var announcer

    func body(content: Content) -> some View {
        let motion = UIFnToastMotion(context: context, edge: edge)
        content
            .overlay(alignment: edge == .top ? .top : .bottom) {
                ZStack {
                    if let toast {
                        UIFnBanner(
                            toast.title,
                            message: toast.message,
                            tone: toast.tone,
                            dismiss: dismissLabel.map { label in UIFnBannerDismiss(label) { dismiss(toast.id) } }
                        )
                        .frame(maxWidth: 480)
                        .padding(context.scaled(context.spacing.space4))
                        .id(toast.id)
                        .transition(motion.transition)
                    }
                }
                // Animates the change of toast; the transition sets how each
                // banner comes in and goes.
                .animation(motion.insertionAnimation, value: toast?.id)
            }
            .task(id: toast?.id) { await present(toast) }
    }

    /// Announces the toast, then dismisses it when its duration passes,
    /// unless another toast has replaced it by then.
    @MainActor
    private func present(_ shown: UIFnToast?) async {
        guard let shown else { return }
        announcer.announce(shown.announcement, shown.tone)
        guard let duration = shown.duration else { return }
        guard await UIFnToastTimer.wait(duration) else { return }
        dismiss(shown.id)
    }

    private func dismiss(_ id: UUID) {
        if toast?.id == id {
            toast = nil
        }
    }
}

/// How a toast moves in and out: from its edge with a fade, or under Reduce
/// Motion a fade in place, at the theme's normal duration (or its
/// reduced-motion duration), coming in with the theme's entrance easing and
/// going with its exit easing.
struct UIFnToastMotion {
    let reduceMotion: Bool
    let edge: VerticalEdge
    let theme: UIFnTheme

    init(context: UIFnStyleContext, edge: VerticalEdge) {
        reduceMotion = context.reduceMotion
        self.edge = edge
        theme = context.theme
    }

    /// Whether the toast moves from its edge, rather than only fading.
    var moves: Bool { !reduceMotion }

    var transition: AnyTransition {
        let fade = AnyTransition.opacity
        let movement = moves ? AnyTransition.move(edge: edge == .top ? .top : .bottom).combined(with: fade) : fade
        return .asymmetric(
            insertion: movement.animation(insertionAnimation),
            removal: movement.animation(removalAnimation)
        )
    }

    /// Seconds the toast takes to come in or go.
    var duration: Double {
        theme.motion.duration.normal.seconds(reduceMotion: reduceMotion)
    }

    /// How the toast comes in: with the theme's entrance easing.
    var insertionAnimation: Animation {
        theme.motion.easing.entrance.animation(theme.motion.duration.normal, reduceMotion: reduceMotion)
    }

    /// How the toast goes: with the theme's exit easing.
    var removalAnimation: Animation {
        theme.motion.easing.exit.animation(theme.motion.duration.normal, reduceMotion: reduceMotion)
    }
}

/// Waits out a toast's duration.
enum UIFnToastTimer {
    /// The longest single sleep, in seconds: a day, whose nanoseconds fit in
    /// a `UInt64` with room to spare.
    static let longestSleep: TimeInterval = 86_400

    /// The longest duration the timer waits out, in seconds: 365 days. A
    /// longer duration never passes, as an infinite one does not.
    static let longestDuration: TimeInterval = 365 * longestSleep

    /// Sleeps until `duration` seconds have passed: a whole number of sleeps
    /// of ``longestSleep`` seconds, then one for the rest, so a duration up to
    /// ``longestDuration`` passes in full. Returns whether it did: false at
    /// once, without sleeping, for a duration that is not positive and finite
    /// or is longer than ``longestDuration``, and false as soon as the task is
    /// cancelled.
    static func wait(
        _ duration: TimeInterval,
        sleep: (_ nanoseconds: UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }
    ) async -> Bool {
        guard duration.isFinite, duration > 0, duration <= longestDuration else { return false }
        // Counting whole sleeps, rather than subtracting each from what is
        // left, ends after a known number of them.
        let wholeSleeps = Int(duration / longestSleep)
        let rest = duration - Double(wholeSleeps) * longestSleep
        let sleeps = Array(repeating: longestSleep, count: wholeSleeps) + (rest > 0 ? [rest] : [])
        for seconds in sleeps {
            do {
                try await sleep(UInt64((seconds * 1_000_000_000).rounded(.up)))
            } catch {
                return false
            }
            if Task.isCancelled { return false }
        }
        return true
    }
}

// MARK: - Announcements

/// Posts announcements for assistive technologies such as VoiceOver.
struct UIFnAnnouncer {
    let announce: @MainActor (_ text: String, _ tone: UIFnTone) -> Void

    /// The platform's announcement: interrupting other speech for warnings
    /// and dangers on macOS, which can tell them apart.
    static let system = UIFnAnnouncer { text, tone in
        #if os(macOS)
        guard let app = NSApp else { return }
        let priority: NSAccessibilityPriorityLevel = tone == .warning || tone == .danger ? .high : .medium
        NSAccessibility.post(
            element: app.mainWindow ?? app,
            notification: .announcementRequested,
            userInfo: [.announcement: text, .priority: priority.rawValue]
        )
        #elseif canImport(UIKit)
        UIAccessibility.post(notification: .announcement, argument: text)
        #endif
    }
}

private struct UIFnAnnouncerKey: EnvironmentKey {
    static let defaultValue = UIFnAnnouncer.system
}

extension EnvironmentValues {
    /// Where UIFn components post announcements: the platform's announcer,
    /// ``UIFnAnnouncer/system``, unless a test sets another.
    var uifnAnnouncer: UIFnAnnouncer {
        get { self[UIFnAnnouncerKey.self] }
        set { self[UIFnAnnouncerKey.self] = newValue }
    }
}
