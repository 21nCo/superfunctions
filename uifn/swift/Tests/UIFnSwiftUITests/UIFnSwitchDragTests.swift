#if os(macOS)
import AppKit
import SwiftUI
import Testing
@testable import UIFnSwiftUI

extension UIFnHostedWindowTests {
    /// Like the system switch, a UIFn switch takes a drag across its track: the
    /// value comes from the half of the track the drag ends over, and a drag that
    /// ends where it started leaves the value alone.
    ///
    /// Each test shows a key window and sends it mouse events, so the suite runs
    /// inside ``UIFnHostedWindowTests``, one test at a time.
    @MainActor @Suite
    struct UIFnSwitchDragTests {
        /// A toggle's value and how many times it was set.
        @MainActor
        private final class Box: ObservableObject {
            @Published var isOn: Bool
            var writes = 0

            init(_ isOn: Bool) {
                self.isOn = isOn
            }

            var binding: Binding<Bool> {
                Binding(get: { self.isOn }, set: { self.isOn = $0; self.writes += 1 })
            }
        }

        private enum Subject {
            case uifn, system
        }

        /// Where the track sits in the window's content, from its top-leading corner.
        private static let inset: CGFloat = 20

        private struct Host: View {
            @ObservedObject var box: Box
            let subject: Subject
            let isEnabled: Bool

            var body: some View {
                Group {
                    switch subject {
                    case .uifn: Toggle(isOn: box.binding) { EmptyView() }.toggleStyle(.uifnSwitch)
                    case .system: Toggle(isOn: box.binding) { EmptyView() }.toggleStyle(.switch).labelsHidden()
                    }
                }
                .disabled(!isEnabled)
                .padding(UIFnSwitchDragTests.inset)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }

        private struct MixedHost: View {
            @ObservedObject var first: Box
            @ObservedObject var second: Box

            var body: some View {
                Toggle(sources: [first.binding, second.binding], isOn: \.self) { EmptyView() }
                    .toggleStyle(.uifnSwitch)
                    .padding(UIFnSwitchDragTests.inset)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }

        private func makeWindow<Content: View>(_ content: Content) -> NSWindow {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 200, height: 100),
                styleMask: [.titled],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: content)
            window.makeKeyAndOrderFront(nil)
            window.contentView?.layoutSubtreeIfNeeded()
            return window
        }

        /// The track in window coordinates: the system switch's own frame, or the
        /// UIFn track's theme size at the inset.
        private func trackFrame(in window: NSWindow, _ subject: Subject) throws -> NSRect {
            let content = try #require(window.contentView)
            switch subject {
            case .system:
                func find(_ view: NSView) -> NSSwitch? {
                    if let control = view as? NSSwitch { return control }
                    return view.subviews.lazy.compactMap(find).first
                }
                let control = try #require(find(content))
                return control.convert(control.bounds, to: nil)
            case .uifn:
                // 44 by 24 points: the track's size with no Dynamic Type on macOS.
                let top = content.bounds.height - Self.inset
                return NSRect(x: Self.inset, y: top - 24, width: 44, height: 24)
            }
        }

        private func event(_ type: NSEvent.EventType, at point: NSPoint, in window: NSWindow) throws -> NSEvent {
            try #require(NSEvent.mouseEvent(
                with: type,
                location: point,
                modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: 0,
                clickCount: 1,
                pressure: type == .leftMouseUp ? 0 : 1
            ))
        }

        /// Presses at the first point, drags through the rest in small steps and
        /// releases at the last.
        private func press(_ window: NSWindow, through points: [NSPoint]) throws {
            var path: [NSPoint] = []
            for (from, to) in zip(points, points.dropFirst()) {
                for step in 1...8 {
                    let t = CGFloat(step) / 8
                    path.append(NSPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
                }
            }
            let events = try [event(.leftMouseDown, at: points[0], in: window)]
                + path.map { try event(.leftMouseDragged, at: $0, in: window) }
                + [event(.leftMouseUp, at: points[points.count - 1], in: window)]
            for event in events {
                window.sendEvent(event)
            }
        }

        private func settle() async throws {
            try await Task.sleep(nanoseconds: 100_000_000)
        }

        private struct Drag: Sendable, CustomTestStringConvertible {
            let name: String
            let startsOn: Bool
            /// Points as fractions of the track's width from its left edge.
            let path: [CGFloat]
            /// How far up the drag ends from where it starts, in points, or down
            /// when negative, reached evenly along the path.
            var rise: CGFloat = 0
            let endsOn: Bool

            var testDescription: String { name }
        }

        private nonisolated static let drags = [
            Drag(name: "off dragged to on", startsOn: false, path: [0.25, 0.9], endsOn: true),
            Drag(name: "off dragged past the trailing end", startsOn: false, path: [0.25, 1.4], endsOn: true),
            Drag(name: "off dragged right and back", startsOn: false, path: [0.25, 0.9, 0.2], endsOn: false),
            Drag(name: "on dragged to off", startsOn: true, path: [0.75, 0.1], endsOn: false),
            Drag(name: "on dragged left and back", startsOn: true, path: [0.75, 0.1, 0.8], endsOn: true),
            Drag(name: "off dragged to on drifting down", startsOn: false, path: [0.25, 0.9], rise: -10, endsOn: true),
            // A drag up or down sets nothing, even from the half the thumb
            // is not on.
            Drag(name: "off dragged up from the trailing half", startsOn: false, path: [0.75, 0.75], rise: 25, endsOn: false),
            Drag(name: "off dragged down from the trailing half", startsOn: false, path: [0.75, 0.75], rise: -40, endsOn: false),
            Drag(name: "on dragged up from the leading half", startsOn: true, path: [0.25, 0.25], rise: 15, endsOn: true),
            Drag(name: "on dragged down from the leading half", startsOn: true, path: [0.25, 0.25], rise: -25, endsOn: true),
            Drag(name: "off dragged steeply down to the trailing end", startsOn: false, path: [0.6, 0.9], rise: -30, endsOn: false),
        ]

        private func run(_ drag: Drag, on subject: Subject, isEnabled: Bool = true) async throws -> Box {
            let box = Box(drag.startsOn)
            let window = makeWindow(Host(box: box, subject: subject, isEnabled: isEnabled))
            defer { window.close() }
            let track = try trackFrame(in: window, subject)
            let points = drag.path.enumerated().map { index, x in
                NSPoint(
                    x: track.minX + track.width * x,
                    y: track.midY + drag.rise * CGFloat(index) / CGFloat(drag.path.count - 1)
                )
            }
            try press(window, through: points)
            try await settle()
            return box
        }

        @Test(arguments: drags)
        private func aDragSetsTheSwitchFromWhereItEnds(_ drag: Drag) async throws {
            let box = try await run(drag, on: .uifn)
            #expect(box.isOn == drag.endsOn)
            #expect(box.writes == (drag.endsOn == drag.startsOn ? 0 : 1))
        }

        @Test
        func theSystemSwitchTakesTheSameDrags() async throws {
            // The same events move the system switch the same way, so the UIFn
            // switch's results above are the native behavior.
            for drag in Self.drags {
                let box = try await run(drag, on: .system)
                #expect(box.isOn == drag.endsOn, "\(drag.name)")
                #expect(box.writes == (drag.endsOn == drag.startsOn ? 0 : 1), "\(drag.name)")
            }
        }

        @Test
        func aClickStillFlipsTheSwitch() async throws {
            for startsOn in [false, true] {
                let box = Box(startsOn)
                let window = makeWindow(Host(box: box, subject: .uifn, isEnabled: true))
                defer { window.close() }
                let track = try trackFrame(in: window, .uifn)
                // A press that moves less than a drag is a click, wherever it lands.
                for x in [track.minX + track.width * 0.25, track.minX + track.width * 0.75] {
                    let before = box.isOn
                    try press(window, through: [NSPoint(x: x, y: track.midY), NSPoint(x: x + 2, y: track.midY)])
                    try await settle()
                    #expect(box.isOn == !before)
                }
                #expect(box.writes == 2)
            }
        }

        @Test
        func aDisabledSwitchIgnoresDrags() async throws {
            for drag in Self.drags {
                let box = try await run(drag, on: .uifn, isEnabled: false)
                #expect(box.isOn == drag.startsOn, "\(drag.name)")
                #expect(box.writes == 0, "\(drag.name)")
            }
        }

        @Test
        func aDragFollowsTheTrackRightToLeft() async throws {
            // Right to left, the thumb starts at the right when off and the
            // trailing half that turns the switch on is the left.
            for (path, endsOn) in [([0.75, 0.1], true), ([0.75, 0.1, 0.8], false), ([0.75, 0.6], false)] {
                let box = Box(false)
                let window = makeWindow(
                    Host(box: box, subject: .uifn, isEnabled: true).environment(\.layoutDirection, .rightToLeft)
                )
                defer { window.close() }
                let content = try #require(window.contentView)
                let track = NSRect(x: content.bounds.width - Self.inset - 44, y: content.bounds.height - Self.inset - 24, width: 44, height: 24)
                try press(window, through: path.map { NSPoint(x: track.minX + track.width * $0, y: track.midY) })
                try await settle()
                #expect(box.isOn == endsOn, "\(path)")
                #expect(box.writes == (endsOn ? 1 : 0), "\(path)")
            }
        }

        @Test
        func aMixedSwitchTurnsOffOnlyWhenDraggedToTheLeadingHalf() async throws {
            // A mixed switch draws its thumb on the trailing side, like on.
            for (path, isOff) in [([0.75, 0.1], true), ([0.75, 0.1, 0.8], false)] {
                let first = Box(true), second = Box(false)
                let window = makeWindow(MixedHost(first: first, second: second))
                defer { window.close() }
                let track = try trackFrame(in: window, .uifn)
                try press(window, through: path.map { NSPoint(x: track.minX + track.width * $0, y: track.midY) })
                try await settle()
                if isOff {
                    #expect(!first.isOn && !second.isOn, "\(path)")
                } else {
                    #expect(first.isOn && !second.isOn && first.writes + second.writes == 0, "\(path)")
                }
            }
        }
    }
}
#endif
